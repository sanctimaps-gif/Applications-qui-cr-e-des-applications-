"""Tokeniseur BPE au niveau octet, entraine de zero sur VOTRE corpus.

Rien n'est emprunte : ni vocabulaire, ni fusions, ni table pre-entrainee. On
part des 256 octets possibles et on apprend les fusions les plus frequentes.
Travailler sur les octets garantit qu'aucun texte n'est inencodable, quelle
que soit la langue ou l'alphabet.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Iterable

#: Decoupage prealable, en re standard (pas de dependance a `regex`).
#: `[^\W\d_]` designe les lettres, accents compris, grace a re.UNICODE.
#:
#: La branche des symboles doit couvrir tout ce qui n'est ni lettre, ni
#: chiffre, ni espace — y compris le tiret bas, que `\w` classe pourtant comme
#: caractere de mot. L'ecrire `[^\s\w]` perdait silencieusement chaque `_`,
#: ce qui mutilait tout corpus de code.
MOTIF = re.compile(
    r"""'(?:[sdmt]|ll|ve|re)"""  # elisions anglaises courantes
    r"""| ?[^\W\d_]+"""  # lettres
    r"""| ?\d{1,3}"""  # chiffres, par groupes de trois au plus
    r"""| ?(?:(?![^\W\d_])[^\s\d])+"""  # symboles, tiret bas compris
    r"""|\s+(?!\S)"""  # espaces en fin de ligne
    r"""|\s+""",  # tout autre espace
    re.UNICODE,
)

#: Jetons speciaux. Les identifiants sont attribues apres les octets bruts.
SPECIAUX = (
    "<|pad|>",
    "<|bos|>",
    "<|eos|>",
    "<|system|>",
    "<|user|>",
    "<|assistant|>",
)


class Tokenizer:
    """BPE au niveau octet : entrainement, encodage, decodage, persistance."""

    def __init__(
        self,
        merges: dict[tuple[int, int], int] | None = None,
        specials: tuple[str, ...] = SPECIAUX,
    ) -> None:
        self.merges: dict[tuple[int, int], int] = merges or {}
        self.specials = specials
        self._rebuild()

    # ------------------------------------------------------------------ #
    # Construction des tables derivees
    # ------------------------------------------------------------------ #
    def _rebuild(self) -> None:
        # Vocabulaire : 256 octets, puis une entree par fusion apprise.
        self.vocab: dict[int, bytes] = {i: bytes([i]) for i in range(256)}
        for (a, b), idx in sorted(self.merges.items(), key=lambda kv: kv[1]):
            self.vocab[idx] = self.vocab[a] + self.vocab[b]

        premier_special = 256 + len(self.merges)
        self.special_to_id = {jeton: premier_special + i for i, jeton in enumerate(self.specials)}
        self.id_to_special = {v: k for k, v in self.special_to_id.items()}
        self._cache: dict[str, list[int]] = {}
        self._motif_speciaux = (
            re.compile("(" + "|".join(re.escape(s) for s in self.specials) + ")")
            if self.specials
            else None
        )

    @property
    def vocab_size(self) -> int:
        return 256 + len(self.merges) + len(self.specials)

    @property
    def bos_id(self) -> int:
        return self.special_to_id["<|bos|>"]

    @property
    def eos_id(self) -> int:
        return self.special_to_id["<|eos|>"]

    @property
    def pad_id(self) -> int:
        return self.special_to_id["<|pad|>"]

    # ------------------------------------------------------------------ #
    # Entrainement
    # ------------------------------------------------------------------ #
    def train(self, texte: str, vocab_size: int, verbose: bool = False) -> "Tokenizer":
        """Apprend les fusions BPE jusqu'a atteindre `vocab_size`.

        L'implementation maintient les comptes de paires de facon incrementale
        et n'inspecte que les mots reellement touches par chaque fusion : sans
        cela, entrainer sur quelques megaoctets prendrait des minutes au lieu
        de quelques secondes.
        """
        cible = vocab_size - 256 - len(self.specials)
        if cible < 0:
            raise ValueError(
                f"vocab_size doit valoir au moins {256 + len(self.specials)} "
                f"(256 octets + {len(self.specials)} jetons speciaux)"
            )

        # Chaque mot distinct devient une sequence d'identifiants, avec son
        # nombre d'occurrences : le corpus est ainsi compresse d'emblee.
        frequences: dict[str, int] = defaultdict(int)
        for morceau in MOTIF.findall(texte):
            frequences[morceau] += 1

        mots: list[list[int]] = []
        poids: list[int] = []
        for morceau, compte in frequences.items():
            mots.append(list(morceau.encode("utf-8")))
            poids.append(compte)

        # Comptes de paires, et index inverse paire -> mots concernes.
        paires: dict[tuple[int, int], int] = defaultdict(int)
        ou: dict[tuple[int, int], set[int]] = defaultdict(set)
        for i, mot in enumerate(mots):
            for paire in zip(mot, mot[1:]):
                paires[paire] += poids[i]
                ou[paire].add(i)

        merges: dict[tuple[int, int], int] = {}

        for rang in range(cible):
            if not paires:
                break
            meilleure = max(paires, key=lambda p: (paires[p], -p[0], -p[1]))
            if paires[meilleure] < 2:
                break  # plus rien de recurrent a fusionner

            nouvel_id = 256 + rang
            merges[meilleure] = nouvel_id

            for i in list(ou[meilleure]):
                mot = mots[i]
                if len(mot) < 2:
                    continue

                # On retire l'ancienne contribution du mot...
                for paire in zip(mot, mot[1:]):
                    paires[paire] -= poids[i]
                    if paires[paire] <= 0:
                        paires.pop(paire, None)
                        ou.pop(paire, None)
                    else:
                        ou[paire].discard(i)

                # ...on applique la fusion...
                fusionne: list[int] = []
                j = 0
                while j < len(mot):
                    if j < len(mot) - 1 and (mot[j], mot[j + 1]) == meilleure:
                        fusionne.append(nouvel_id)
                        j += 2
                    else:
                        fusionne.append(mot[j])
                        j += 1
                mots[i] = fusionne

                # ...et on reinjecte la nouvelle contribution.
                for paire in zip(fusionne, fusionne[1:]):
                    paires[paire] += poids[i]
                    ou[paire].add(i)

            paires.pop(meilleure, None)
            ou.pop(meilleure, None)

            if verbose and (rang + 1) % 250 == 0:
                print(f"  fusion {rang + 1}/{cible}", flush=True)

        self.merges = merges
        self._rebuild()
        return self

    # ------------------------------------------------------------------ #
    # Encodage / decodage
    # ------------------------------------------------------------------ #
    def _encode_morceau(self, morceau: str) -> list[int]:
        cache = self._cache.get(morceau)
        if cache is not None:
            return cache

        ids = list(morceau.encode("utf-8"))
        while len(ids) >= 2:
            # On applique toujours la fusion apprise le plus tot : c'est ce qui
            # rend l'encodage deterministe et coherent avec l'entrainement.
            candidate = min(
                (self.merges.get(paire, float("inf")), paire) for paire in zip(ids, ids[1:])
            )
            rang, paire = candidate
            if rang == float("inf"):
                break
            nouvel_id = self.merges[paire]
            fusionne: list[int] = []
            i = 0
            while i < len(ids):
                if i < len(ids) - 1 and (ids[i], ids[i + 1]) == paire:
                    fusionne.append(nouvel_id)
                    i += 2
                else:
                    fusionne.append(ids[i])
                    i += 1
            ids = fusionne

        if len(self._cache) < 100_000:
            self._cache[morceau] = ids
        return ids

    def encode(self, texte: str, autoriser_speciaux: bool = True) -> list[int]:
        """Texte -> identifiants. Les jetons speciaux sont reconnus tels quels."""
        if not autoriser_speciaux or self._motif_speciaux is None:
            return [i for m in MOTIF.findall(texte) for i in self._encode_morceau(m)]

        sortie: list[int] = []
        for fragment in self._motif_speciaux.split(texte):
            if not fragment:
                continue
            if fragment in self.special_to_id:
                sortie.append(self.special_to_id[fragment])
            else:
                for morceau in MOTIF.findall(fragment):
                    sortie.extend(self._encode_morceau(morceau))
        return sortie

    def decode(self, ids: Iterable[int]) -> str:
        """Identifiants -> texte. Tolerant aux sequences d'octets incompletes."""
        morceaux: list[bytes] = []
        for i in ids:
            if i in self.id_to_special:
                morceaux.append(self.id_to_special[i].encode("utf-8"))
            elif i in self.vocab:
                morceaux.append(self.vocab[i])
            # Un identifiant hors vocabulaire est ignore plutot que de lever :
            # un modele en cours d'entrainement peut en produire.
        return b"".join(morceaux).decode("utf-8", errors="replace")

    # ------------------------------------------------------------------ #
    # Persistance
    # ------------------------------------------------------------------ #
    def save(self, chemin: str | Path) -> None:
        chemin = Path(chemin)
        chemin.parent.mkdir(parents=True, exist_ok=True)
        donnees = {
            "version": 1,
            "specials": list(self.specials),
            "merges": [[a, b, idx] for (a, b), idx in sorted(self.merges.items(), key=lambda kv: kv[1])],
        }
        chemin.write_text(json.dumps(donnees, ensure_ascii=False), encoding="utf-8")

    @classmethod
    def load(cls, chemin: str | Path) -> "Tokenizer":
        donnees = json.loads(Path(chemin).read_text(encoding="utf-8"))
        merges = {(a, b): idx for a, b, idx in donnees["merges"]}
        return cls(merges=merges, specials=tuple(donnees.get("specials", SPECIAUX)))
