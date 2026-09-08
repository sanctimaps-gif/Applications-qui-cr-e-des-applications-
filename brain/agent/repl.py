"""L'atelier en console : la boucle qui vous repond.

Un tour = une instruction, une action reelle, un compte rendu. Rien n'est
simule : chaque reponse decrit ce qui vient d'etre fait sur le disque.
"""

from __future__ import annotations

import sys
from pathlib import Path

from .atelier import Atelier, Resultat
from .commandes import Incomprise, interpreter

_COULEUR = sys.stdout.isatty()


def _peint(code: str, texte: str) -> str:
    return f"\033[{code}m{texte}\033[0m" if _COULEUR else texte


GRIS = lambda t: _peint("2", t)  # noqa: E731
ROUGE = lambda t: _peint("31", t)  # noqa: E731
VERT = lambda t: _peint("32", t)  # noqa: E731
AMBRE = lambda t: _peint("33", t)  # noqa: E731
BLEU = lambda t: _peint("36", t)  # noqa: E731
GRAS = lambda t: _peint("1", t)  # noqa: E731


def _colorer_diff(diff: str) -> str:
    lignes = []
    for ligne in diff.splitlines():
        if ligne.startswith("+++") or ligne.startswith("---"):
            lignes.append(GRAS(ligne))
        elif ligne.startswith("+"):
            lignes.append(VERT(ligne))
        elif ligne.startswith("-"):
            lignes.append(ROUGE(ligne))
        elif ligne.startswith("@@"):
            lignes.append(BLEU(ligne))
        else:
            lignes.append(GRIS(ligne))
    return "\n".join(lignes)


def _afficher(resultat: Resultat, detail_diff: bool) -> None:
    marque = ROUGE("✖") if resultat.echec else VERT("✔")
    print(f"{marque} {resultat.message}")

    if resultat.detail:
        contenu = resultat.detail
        if detail_diff and (contenu.startswith("---") or "\n---" in contenu or "@@" in contenu):
            contenu = _colorer_diff(contenu)
            lignes = contenu.splitlines()
            if len(lignes) > 40:
                contenu = "\n".join(lignes[:40] + [GRIS(f"… {len(lignes) - 40} lignes de diff en plus")])
        print("\n".join("  " + l for l in contenu.splitlines()))
    print()


def demarrer(projet: str | Path, instructions: list[str] | None = None) -> int:
    """Ouvre l'atelier. `instructions` permet de le piloter sans terminal."""
    atelier = Atelier(projet)

    print(GRAS("\nAtelier Forge") + GRIS("  —  aucun modèle, aucune clé, tout en local"))
    print(GRIS(f"projet : {atelier.racine}"))
    if atelier.intention:
        print(GRIS(f"ouvert : {atelier.intention.titre} — {len(atelier.intention.champs)} champs"))
    else:
        print(GRIS("dossier vide — commencez par « crée une application de … »"))
    print(GRIS("« aide » pour les instructions, « quitte » pour sortir\n"))

    file = list(instructions or [])

    while True:
        if file:
            ligne = file.pop(0)
            print(f"{BLEU('vous ›')} {ligne}")
        else:
            if instructions is not None:
                return 0  # pilotage termine
            try:
                ligne = input(BLEU("vous › ")).strip()
            except (EOFError, KeyboardInterrupt):
                print("\n" + GRIS("à bientôt"))
                return 0

        if not ligne:
            continue

        try:
            operation = interpreter(ligne)
        except Incomprise as probleme:
            print(f"{AMBRE('?')} Je n'ai pas compris. Essayez :")
            for piste in probleme.pistes:
                print(GRIS(f"    {piste}"))
            print()
            continue

        try:
            resultat = atelier.executer(operation)
        except Exception as probleme:  # une erreur d'outil ne tue pas la session
            print(f"{ROUGE('✖')} {probleme}\n")
            continue

        _afficher(resultat, detail_diff=operation.nom not in ("montrer", "aide", "lister"))

        if resultat.fini:
            return 0
