"""Compilateur d'intention : du francais vers du code, sans modele.

    from brain.intent import analyser, generer

    intention = analyser("Une liste de taches avec titre, priorite et echeance")
    fichiers = generer(intention)          # chemin -> contenu

Contrairement a un modele de langue, ce compilateur est deterministe : la meme
phrase produit toujours exactement le meme code, et ce code est correct par
construction. En contrepartie, il ne comprend que ce que son lexique couvre —
et il le dit, plutot que d'inventer.
"""

from .analyse import Champ, Intention, analyser
from .generation import generer

__all__ = ["Champ", "Intention", "analyser", "generer"]
