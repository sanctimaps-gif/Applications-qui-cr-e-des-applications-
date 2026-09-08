"""L'atelier : une boucle d'agent qui travaille reellement sur un projet.

C'est la partie de « Claude Code » qui ne depend d'aucun modele : les outils,
l'edition de fichiers confinee, l'execution des tests, les instantanes pour
annuler, l'historique. L'intelligence, ici, est le compilateur d'intention —
deterministe, donc toujours correcte sur son domaine.
"""

from __future__ import annotations

import difflib
import json
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from ..intent import analyser, generer
from ..intent.analyse import Champ, Intention
from ..intent.generation import SPEC
from ..intent.lexique import capitalise, identifiant, normalise, options_du_champ, type_du_champ
from .commandes import Operation

#: Seul programme que l'atelier a le droit de lancer. Il execute du code qu'il
#: a lui-meme ecrit, jamais une commande arbitraire venue d'une instruction.
PROGRAMME_TESTS = "node"


@dataclass
class Resultat:
    """Ce que l'atelier renvoie apres chaque instruction."""

    message: str
    detail: str = ""
    modifie: bool = False
    fini: bool = False
    echec: bool = False


@dataclass
class Entree:
    """Une ligne d'historique."""

    instruction: str
    operation: str
    resume: str
    horodatage: float = field(default_factory=time.time)


class ProjetIntrouvable(Exception):
    pass


class Atelier:
    """Session de travail sur un projet, avec memoire et annulation."""

    def __init__(self, racine: str | Path) -> None:
        self.racine = Path(racine).resolve()
        self.intention: Intention | None = None
        self.historique: list[Entree] = []
        self._instantanes: list[dict[str, str]] = []
        self._dernier_diff: str = ""

        if (self.racine / SPEC).exists():
            self.intention = Intention.from_dict(
                json.loads((self.racine / SPEC).read_text(encoding="utf-8"))
            )

    # ------------------------------------------------------------------ #
    # Outils de bas niveau, tous confines a la racine du projet
    # ------------------------------------------------------------------ #
    def _resoudre(self, relatif: str) -> Path:
        cible = (self.racine / relatif).resolve()
        racine = str(self.racine)
        if not str(cible).startswith(racine.rstrip("/") + "/") and cible != self.racine:
            raise ValueError(f"chemin hors du projet : {relatif}")
        return cible

    def fichiers(self) -> list[str]:
        """Fichiers du projet, dossiers lourds exclus."""
        exclus = {"node_modules", ".git", ".forge"}
        sortie: list[str] = []
        for chemin in sorted(self.racine.rglob("*")):
            if not chemin.is_file():
                continue
            if any(part in exclus for part in chemin.relative_to(self.racine).parts):
                continue
            sortie.append(str(chemin.relative_to(self.racine)))
        return sortie

    def _etat(self) -> dict[str, str]:
        """Instantane du projet : chemin -> contenu."""
        etat: dict[str, str] = {}
        for relatif in self.fichiers():
            try:
                etat[relatif] = (self.racine / relatif).read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
        return etat

    def _ecrire(self, fichiers: dict[str, str]) -> None:
        for relatif, contenu in fichiers.items():
            cible = self._resoudre(relatif)
            cible.parent.mkdir(parents=True, exist_ok=True)
            cible.write_text(contenu, encoding="utf-8")

    @staticmethod
    def _diff(avant: dict[str, str], apres: dict[str, str]) -> str:
        """Differences lisibles entre deux instantanes."""
        morceaux: list[str] = []
        for chemin in sorted(set(avant) | set(apres)):
            ancien = avant.get(chemin, "").splitlines(keepends=True)
            nouveau = apres.get(chemin, "").splitlines(keepends=True)
            if ancien == nouveau:
                continue
            lignes = list(
                difflib.unified_diff(ancien, nouveau, fromfile=f"a/{chemin}", tofile=f"b/{chemin}", n=2)
            )
            if lignes:
                morceaux.append("".join(lignes))
        return "\n".join(morceaux)

    # ------------------------------------------------------------------ #
    # Regeneration : toute modification passe par la specification
    # ------------------------------------------------------------------ #
    def _appliquer(self, resume: str) -> Resultat:
        """Regenere le projet depuis la specification, avec diff et annulation."""
        if self.intention is None:
            raise ProjetIntrouvable("aucun projet ouvert")

        avant = self._etat()
        self._instantanes.append(avant)
        if len(self._instantanes) > 50:
            self._instantanes.pop(0)

        self._ecrire(generer(self.intention))
        apres = self._etat()
        self._dernier_diff = self._diff(avant, apres)

        touches = sum(1 for c in set(avant) | set(apres) if avant.get(c) != apres.get(c))
        return Resultat(
            message=f"{resume} — {touches} fichier(s) mis à jour",
            detail=self._dernier_diff,
            modifie=True,
        )

    # ------------------------------------------------------------------ #
    # Operations
    # ------------------------------------------------------------------ #
    def executer(self, operation: Operation) -> Resultat:
        """Execute une operation comprise."""
        methode = getattr(self, f"_op_{operation.nom}", None)
        if methode is None:
            return Resultat(f"opération inconnue : {operation.nom}", echec=True)

        resultat = methode(operation)
        self.historique.append(
            Entree(instruction=operation.source, operation=operation.nom, resume=resultat.message)
        )
        return resultat

    # -- creation ------------------------------------------------------- #
    def _op_creer(self, operation: Operation) -> Resultat:
        demande = operation.arguments.get("demande", "")
        self.intention = analyser(demande)
        self.racine.mkdir(parents=True, exist_ok=True)

        avant = self._etat()
        self._instantanes.append(avant)
        self._ecrire(generer(self.intention))
        self._dernier_diff = self._diff(avant, self._etat())

        return Resultat(
            message=f"« {self.intention.titre} » créée dans {self.racine}",
            detail=self.intention.resume(),
            modifie=True,
        )

    # -- champs --------------------------------------------------------- #
    def _trouver_champ(self, nom: str) -> Champ | None:
        cible = normalise(nom)
        if self.intention is None:
            return None
        for champ in self.intention.champs:
            if normalise(champ.libelle) == cible or champ.cle == identifiant(nom):
                return champ
        # Correspondance partielle : « date » retrouve « Date échéance ».
        for champ in self.intention.champs:
            if cible and cible in normalise(champ.libelle):
                return champ
        return None

    def _op_ajouter_champ(self, operation: Operation) -> Resultat:
        if self.intention is None:
            return Resultat("aucun projet ouvert — commencez par « crée … »", echec=True)

        nom = operation.arguments.get("nom", "").strip()
        if not nom:
            return Resultat("quel champ faut-il ajouter ?", echec=True)
        if self._trouver_champ(nom) is not None:
            return Resultat(f"le champ « {capitalise(nom)} » existe déjà", echec=True)
        if len(self.intention.champs) >= 8:
            return Resultat("huit champs au maximum : supprimez-en un d'abord", echec=True)

        type_champ = type_du_champ(nom)
        champ = Champ(
            cle=identifiant(nom),
            libelle=capitalise(nom),
            type=type_champ,
            options=options_du_champ(nom) if type_champ == "choix" else [],
        )
        self.intention.champs.append(champ)

        # Un nouveau champ peut activer une fonction : un choix appelle un
        # filtre, un booleen une case a cocher.
        if type_champ == "choix":
            self.intention.fonctions.add("filtre")
        if type_champ == "booleen":
            self.intention.fonctions.add("cochage")

        return self._appliquer(f"champ « {champ.libelle} » ({champ.type}) ajouté")

    def _op_retirer_champ(self, operation: Operation) -> Resultat:
        if self.intention is None:
            return Resultat("aucun projet ouvert", echec=True)

        champ = self._trouver_champ(operation.arguments.get("nom", ""))
        if champ is None:
            connus = ", ".join(c.libelle for c in self.intention.champs)
            return Resultat(
                f"champ introuvable. Champs actuels : {connus}", echec=True
            )
        if len(self.intention.champs) == 1:
            return Resultat("c'est le dernier champ : une fiche vide n'aurait aucun sens", echec=True)
        if champ.requis and len(self.intention.champs) > 1:
            # Le champ obligatoire sert de titre : on transmet ce role.
            self.intention.champs[1].requis = True

        self.intention.champs.remove(champ)
        return self._appliquer(f"champ « {champ.libelle} » supprimé")

    def _op_renommer_champ(self, operation: Operation) -> Resultat:
        if self.intention is None:
            return Resultat("aucun projet ouvert", echec=True)

        champ = self._trouver_champ(operation.arguments.get("ancien", ""))
        nouveau = operation.arguments.get("nouveau", "").strip()
        if champ is None:
            return Resultat("champ introuvable", echec=True)
        if not nouveau:
            return Resultat("quel doit être le nouveau nom ?", echec=True)

        ancien_libelle = champ.libelle
        champ.libelle = capitalise(nouveau)
        champ.cle = identifiant(nouveau)
        return self._appliquer(f"« {ancien_libelle} » renommé en « {champ.libelle} »")

    # -- fonctions ------------------------------------------------------ #
    def _op_ajouter_fonction(self, operation: Operation) -> Resultat:
        if self.intention is None:
            return Resultat("aucun projet ouvert", echec=True)

        fonction = operation.arguments.get("fonction", "")
        if fonction in self.intention.fonctions:
            return Resultat(f"« {fonction} » est déjà en place", echec=True)
        self.intention.fonctions.add(fonction)
        return self._appliquer(f"fonction « {fonction} » ajoutée")

    def _op_retirer_fonction(self, operation: Operation) -> Resultat:
        if self.intention is None:
            return Resultat("aucun projet ouvert", echec=True)

        fonction = operation.arguments.get("fonction", "")
        if fonction in ("ajout", "liste"):
            return Resultat("ajouter et lister sont indispensables : impossible de les retirer", echec=True)
        if fonction not in self.intention.fonctions:
            return Resultat(f"« {fonction} » n'est pas active", echec=True)
        self.intention.fonctions.discard(fonction)
        return self._appliquer(f"fonction « {fonction} » retirée")

    def _op_titre(self, operation: Operation) -> Resultat:
        if self.intention is None:
            return Resultat("aucun projet ouvert", echec=True)
        self.intention.titre = operation.arguments.get("valeur", self.intention.titre)
        return self._appliquer(f"projet renommé « {self.intention.titre} »")

    # -- inspection ----------------------------------------------------- #
    def _op_lister(self, _: Operation) -> Resultat:
        fichiers = self.fichiers()
        if not fichiers:
            return Resultat("le projet est vide")
        lignes = []
        for relatif in fichiers:
            taille = (self.racine / relatif).stat().st_size
            lignes.append(f"  {relatif:<28} {taille:>7,} o")
        return Resultat(f"{len(fichiers)} fichiers", detail="\n".join(lignes))

    def _op_decrire(self, _: Operation) -> Resultat:
        if self.intention is None:
            return Resultat("aucun projet ouvert dans ce dossier", echec=True)
        return Resultat(self.intention.titre, detail=self.intention.resume())

    def _op_montrer(self, operation: Operation) -> Resultat:
        relatif = operation.arguments.get("fichier", "")
        try:
            cible = self._resoudre(relatif)
        except ValueError as probleme:
            return Resultat(str(probleme), echec=True)
        if not cible.exists():
            return Resultat(f"{relatif} n'existe pas", echec=True)

        contenu = cible.read_text(encoding="utf-8")
        lignes = contenu.splitlines()
        apercu = "\n".join(f"{i + 1:>4} │ {l}" for i, l in enumerate(lignes[:60]))
        if len(lignes) > 60:
            apercu += f"\n     … {len(lignes) - 60} lignes de plus"
        return Resultat(f"{relatif} — {len(lignes)} lignes", detail=apercu)

    def _op_differences(self, _: Operation) -> Resultat:
        if not self._dernier_diff:
            return Resultat("aucune modification depuis l'ouverture")
        return Resultat("dernières modifications", detail=self._dernier_diff)

    def _op_historique(self, _: Operation) -> Resultat:
        if not self.historique:
            return Resultat("rien n'a encore été fait")
        lignes = [
            f"  {i + 1:>2}. {e.instruction}\n      → {e.resume}"
            for i, e in enumerate(self.historique)
        ]
        return Resultat(f"{len(self.historique)} instruction(s)", detail="\n".join(lignes))

    def _op_aide(self, _: Operation) -> Resultat:
        from .commandes import AIDE

        return Resultat("instructions disponibles", detail=AIDE)

    def _op_quitter(self, _: Operation) -> Resultat:
        return Resultat("à bientôt", fini=True)

    # -- execution ------------------------------------------------------ #
    def _op_tester(self, _: Operation) -> Resultat:
        if not (self.racine / "test").exists():
            return Resultat("ce projet n'a pas de dossier test/", echec=True)

        # Les fichiers sont passes un a un : selon la version de Node, donner
        # un repertoire a `--test` le fait interpreter comme un module.
        fichiers_tests = sorted(
            str(c.relative_to(self.racine)) for c in (self.racine / "test").glob("*.test.js")
        )
        if not fichiers_tests:
            return Resultat("aucun fichier de test dans test/", echec=True)

        commande = [PROGRAMME_TESTS, "--test", *fichiers_tests]
        if shutil.which(commande[0]) is None:
            return Resultat("Node.js est introuvable sur cette machine", echec=True)

        try:
            resultat = subprocess.run(
                commande, cwd=self.racine, capture_output=True, text=True, timeout=180
            )
        except subprocess.TimeoutExpired:
            return Resultat("les tests ont dépassé 3 minutes", echec=True)

        sortie = resultat.stdout + resultat.stderr
        passes = _compte(sortie, "# pass ")
        echecs = _compte(sortie, "# fail ")

        if resultat.returncode == 0:
            return Resultat(f"tests au vert — {passes} passés", detail=_extrait(sortie))
        return Resultat(
            f"tests en échec — {passes} passés, {echecs} échoués",
            detail=_extrait(sortie),
            echec=True,
        )

    # -- annulation ----------------------------------------------------- #
    def _op_annuler(self, _: Operation) -> Resultat:
        if not self._instantanes:
            return Resultat("rien à annuler", echec=True)

        precedent = self._instantanes.pop()
        actuel = self._etat()

        # Les fichiers apparus depuis l'instantane sont retires.
        for relatif in set(actuel) - set(precedent):
            self._resoudre(relatif).unlink(missing_ok=True)
        self._ecrire(precedent)

        if (self.racine / SPEC).exists():
            self.intention = Intention.from_dict(
                json.loads((self.racine / SPEC).read_text(encoding="utf-8"))
            )
        self._dernier_diff = self._diff(actuel, precedent)
        return Resultat("dernière modification annulée", detail=self._dernier_diff, modifie=True)


def _compte(sortie: str, prefixe: str) -> int:
    for ligne in sortie.splitlines():
        if ligne.startswith(prefixe):
            try:
                return int(ligne[len(prefixe) :].strip())
            except ValueError:
                return 0
    return 0


def _extrait(sortie: str, lignes: int = 24) -> str:
    """Garde les lignes qui portent l'information, pas le bruit TAP."""
    utiles = [
        l
        for l in sortie.splitlines()
        if l.startswith(("not ok", "# pass", "# fail", "# tests"))
        or "Error" in l
        or "AssertionError" in l
    ]
    return "\n".join(utiles[:lignes]) or "\n".join(sortie.splitlines()[-lignes:])
