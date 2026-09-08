"""L'atelier : un agent de codage qui travaille sans aucun modele.

Ce que « Claude Code » fait et qui ne demande pas d'IA — la boucle, les
outils, l'edition confinee, l'execution des tests, l'annulation, l'historique
— est ici. L'interpretation des instructions est deterministe : sur son
domaine, l'atelier ne se trompe jamais, et hors de ce domaine il le dit.

    from brain.agent import Atelier, interpreter

    atelier = Atelier("./mon-app")
    print(atelier.executer(interpreter("ajoute un champ prix")).message)
"""

from .atelier import Atelier, Entree, Resultat
from .commandes import AIDE, Incomprise, Operation, interpreter
from .repl import demarrer

__all__ = [
    "AIDE",
    "Atelier",
    "Entree",
    "Incomprise",
    "Operation",
    "Resultat",
    "demarrer",
    "interpreter",
]
