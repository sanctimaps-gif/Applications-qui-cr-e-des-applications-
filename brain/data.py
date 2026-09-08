"""Du texte brut aux lots d'entrainement.

Le corpus est tokenise une fois, ecrit dans un fichier binaire, puis lu en
memoire virtuelle : on entraine ainsi sur des corpus plus gros que la RAM.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch

from .tokenizer import Tokenizer

#: uint16 suffit jusqu'a 65 536 entrees de vocabulaire, et divise par deux la
#: taille du corpus tokenise sur le disque.
def _dtype(vocab_size: int) -> np.dtype:
    return np.dtype(np.uint16 if vocab_size < 2**16 else np.uint32)


def lire_corpus(chemins: list[str | Path], extensions: tuple[str, ...] | None = None) -> str:
    """Concatene des fichiers texte, ou tous les fichiers d'un repertoire."""
    morceaux: list[str] = []
    for entree in chemins:
        chemin = Path(entree)
        if chemin.is_dir():
            for fichier in sorted(chemin.rglob("*")):
                if not fichier.is_file():
                    continue
                if extensions and fichier.suffix not in extensions:
                    continue
                try:
                    morceaux.append(fichier.read_text(encoding="utf-8"))
                except (UnicodeDecodeError, OSError):
                    continue  # fichier binaire ou illisible : on passe
        elif chemin.is_file():
            morceaux.append(chemin.read_text(encoding="utf-8"))
        else:
            raise FileNotFoundError(f"corpus introuvable : {chemin}")
    if not morceaux:
        raise ValueError("le corpus est vide")
    return "\n\n".join(morceaux)


def prepare(
    texte: str,
    tokenizer: Tokenizer,
    sortie: str | Path,
    part_validation: float = 0.05,
) -> dict[str, int]:
    """Tokenise le texte et ecrit `train.bin` et `val.bin`."""
    sortie = Path(sortie)
    sortie.mkdir(parents=True, exist_ok=True)

    ids = tokenizer.encode(texte)
    dtype = _dtype(tokenizer.vocab_size)
    tableau = np.array(ids, dtype=dtype)

    coupe = int(len(tableau) * (1.0 - part_validation))
    tableau[:coupe].tofile(sortie / "train.bin")
    tableau[coupe:].tofile(sortie / "val.bin")

    (sortie / "meta.json").write_text(
        f'{{"vocab_size": {tokenizer.vocab_size}, "dtype": "{dtype.name}", '
        f'"train_tokens": {coupe}, "val_tokens": {len(tableau) - coupe}}}',
        encoding="utf-8",
    )
    return {
        "caracteres": len(texte),
        "tokens": len(tableau),
        "train": coupe,
        "val": len(tableau) - coupe,
    }


class Dataset:
    """Lots tires au hasard dans un corpus tokenise."""

    def __init__(self, repertoire: str | Path, block_size: int, vocab_size: int) -> None:
        self.repertoire = Path(repertoire)
        self.block_size = block_size
        self.dtype = _dtype(vocab_size)
        self._parts: dict[str, np.memmap] = {}

        for nom in ("train", "val"):
            fichier = self.repertoire / f"{nom}.bin"
            if not fichier.exists():
                raise FileNotFoundError(f"{fichier} manquant — lancez d'abord la preparation")
            self._parts[nom] = np.memmap(fichier, dtype=self.dtype, mode="r")

        for nom, part in self._parts.items():
            if len(part) <= block_size + 1:
                raise ValueError(
                    f"partie « {nom} » trop courte ({len(part)} tokens) pour un contexte de "
                    f"{block_size}. Fournissez plus de texte, ou reduisez block_size."
                )

    def tokens(self, partie: str = "train") -> int:
        return len(self._parts[partie])

    def batch(
        self,
        partie: str,
        batch_size: int,
        device: torch.device,
        generateur: torch.Generator | None = None,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """Un lot (entrees, cibles) : la cible est l'entree decalee d'un token."""
        donnees = self._parts[partie]
        haut = len(donnees) - self.block_size - 1
        debuts = torch.randint(haut, (batch_size,), generator=generateur)

        x = torch.stack(
            [torch.from_numpy(donnees[i : i + self.block_size].astype(np.int64)) for i in debuts]
        )
        y = torch.stack(
            [
                torch.from_numpy(donnees[i + 1 : i + 1 + self.block_size].astype(np.int64))
                for i in debuts
            ]
        )

        if device.type == "cuda":
            return x.pin_memory().to(device, non_blocking=True), y.pin_memory().to(device, non_blocking=True)
        return x.to(device), y.to(device)
