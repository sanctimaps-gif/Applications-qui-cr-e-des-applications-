"""Comprendre une instruction de travail, pas seulement une demande d'appli.

L'atelier ne genere pas seulement : il modifie, teste, montre, annule. Chaque
phrase est traduite en une operation nommee, avec ses arguments. Quand rien ne
correspond, l'atelier le dit — il ne tente jamais sa chance.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..intent.lexique import MOTS_VIDES, FONCTIONS_PAR_MOT, capitalise, normalise


@dataclass
class Operation:
    """Une instruction comprise, prete a executer."""

    nom: str
    arguments: dict[str, str] = field(default_factory=dict)
    #: Phrase d'origine, conservee pour les messages et l'historique.
    source: str = ""


class Incomprise(Exception):
    """L'instruction ne correspond a aucune operation connue."""

    def __init__(self, phrase: str, pistes: list[str]) -> None:
        super().__init__(f"instruction non comprise : {phrase}")
        self.phrase = phrase
        self.pistes = pistes


# --------------------------------------------------------------------------- #
# Verbes, par operation. Le premier verbe reconnu l'emporte.
# --------------------------------------------------------------------------- #
#: « veux » et « voudrais » sont volontairement absents : « je veux une
#: application de tâches » decrit une creation, pas un ajout de champ.
_AJOUT = ("ajoute", "ajouter", "rajoute", "mets", "mettre", "insere")
_RETRAIT = ("supprime", "supprimer", "retire", "retirer", "enleve", "enlever", "efface", "vire")
_RENOMME = ("renomme", "renommer", "rebaptise", "appelle")

_MOTS_CHAMP = ("champ", "champs", "colonne", "propriete", "attribut", "information", "donnee")

#: Instructions sans argument : un simple mot-cle suffit.
_SIMPLES: dict[str, tuple[str, ...]] = {
    "tester": ("teste", "tester", "lance les tests", "lancer les tests", "verifie", "verifier", "test"),
    "lister": ("liste", "lister", "fichiers", "montre les fichiers", "arborescence"),
    "decrire": ("decris", "decrire", "resume", "resumer", "etat", "que fait ce projet", "explique"),
    "annuler": ("annule", "annuler", "retour", "reviens", "defaire", "undo"),
    "differences": ("diff", "differences", "changements", "modifications"),
    "historique": ("historique", "journal", "log"),
    "aide": ("aide", "help", "commandes", "?"),
    "quitter": ("quitte", "quitter", "sortir", "exit", "au revoir", "fin"),
}


def _mots_utiles(phrase: str) -> list[str]:
    """Mots signifiants d'une phrase, determinants et bruit retires."""
    jetons = re.findall(r"[^\W_]+", phrase.lower(), re.UNICODE)
    return [m for m in jetons if normalise(m) not in MOTS_VIDES]


def _apres(phrase: str, verbes: tuple[str, ...]) -> str:
    """Ce qui suit le premier verbe reconnu, tel qu'ecrit par l'utilisateur."""
    plat = normalise(phrase)
    for verbe in verbes:
        motif = re.compile(rf"\b{re.escape(normalise(verbe))}\b")
        trouve = motif.search(plat)
        if trouve:
            return phrase[trouve.end() :].strip(" ,:'\"")
    return ""


def _nom_de_champ(fragment: str) -> str:
    """Extrait un nom de champ d'un fragment comme « un champ prix unitaire »."""
    mots = [m for m in _mots_utiles(fragment) if normalise(m) not in _MOTS_CHAMP]
    return " ".join(mots[:3])


def _fonction_citee(phrase: str) -> str | None:
    """Repere une fonction nommee dans la phrase (recherche, tri, export...)."""
    plat = normalise(phrase)
    for mot, fonction in FONCTIONS_PAR_MOT.items():
        if re.search(rf"\b{re.escape(mot)}\b", plat):
            return fonction
    return None


def interpreter(phrase: str) -> Operation:
    """Traduit une instruction francaise en operation. Leve si incomprise."""
    brute = phrase.strip()
    if not brute:
        raise Incomprise(phrase, ["tapez « aide » pour la liste des instructions"])

    plat = normalise(brute)
    significatifs = {normalise(m) for m in _mots_utiles(brute)}

    # 1. Montrer un fichier : « montre store.js », « affiche le code de ui.js »
    fichier = re.search(r"([\w./-]+\.(?:js|html|css|json|md))", brute)
    if fichier and re.search(r"\b(montre|montrer|affiche|afficher|ouvre|voir|cat)\b", plat):
        return Operation("montrer", {"fichier": fichier.group(1)}, source=brute)

    # 2. Instructions simples. Elles ne valent QUE si la phrase se resume au
    #    mot-cle : sans cette exigence, « crée une liste de tâches » serait
    #    pris pour la commande « liste ».
    for nom, mots in _SIMPLES.items():
        for mot in mots:
            attendu = {normalise(m) for m in _mots_utiles(mot)} or {normalise(mot)}
            if plat == normalise(mot) or (significatifs and significatifs <= attendu):
                return Operation(nom, source=brute)

    # 3. Creation d'une application complete.
    if re.search(r"\b(cree|creer|genere|generer|nouvelle application|nouveau projet|construis)\b", plat):
        return Operation("creer", {"demande": brute}, source=brute)

    # 4. Renommage : « renomme titre en nom », « renomme l'application en Suivi »
    if any(re.search(rf"\b{v}\b", plat) for v in map(normalise, _RENOMME)):
        reste = _apres(brute, _RENOMME)
        separation = re.split(r"\ben\b", reste, maxsplit=1, flags=re.IGNORECASE)
        if len(separation) == 2:
            avant, apres = separation[0].strip(), separation[1].strip()
            if re.search(r"\b(application|projet|appli|titre du projet)\b", normalise(avant)):
                return Operation("titre", {"valeur": capitalise(apres)}, source=brute)
            return Operation(
                "renommer_champ",
                {"ancien": _nom_de_champ(avant), "nouveau": _nom_de_champ(apres)},
                source=brute,
            )
        raise Incomprise(brute, ["précisez : « renomme <champ> en <nouveau nom> »"])

    # 5. Ajout : un champ, ou une fonction.
    if any(re.search(rf"\b{v}\b", plat) for v in map(normalise, _AJOUT)):
        reste = _apres(brute, _AJOUT)
        fonction = _fonction_citee(reste)
        mentionne_champ = any(m in normalise(reste) for m in _MOTS_CHAMP)
        if fonction and not mentionne_champ:
            return Operation("ajouter_fonction", {"fonction": fonction}, source=brute)
        nom = _nom_de_champ(reste)
        if nom:
            return Operation("ajouter_champ", {"nom": nom}, source=brute)
        raise Incomprise(brute, ["précisez ce qu'il faut ajouter : un champ, ou une fonction"])

    # 6. Retrait : un champ, ou une fonction.
    if any(re.search(rf"\b{v}\b", plat) for v in map(normalise, _RETRAIT)):
        reste = _apres(brute, _RETRAIT)
        fonction = _fonction_citee(reste)
        mentionne_champ = any(m in normalise(reste) for m in _MOTS_CHAMP)
        if fonction and not mentionne_champ:
            return Operation("retirer_fonction", {"fonction": fonction}, source=brute)
        nom = _nom_de_champ(reste)
        if nom:
            return Operation("retirer_champ", {"nom": nom}, source=brute)
        raise Incomprise(brute, ["précisez ce qu'il faut supprimer : un champ, ou une fonction"])

    # 7. Une phrase qui decrit une application, sans verbe : on la prend pour
    #    une demande de creation plutot que de rejeter sechement.
    if re.search(r"\b(application|appli|liste de|gestion de|carnet de|suivi de|catalogue de)\b", plat):
        return Operation("creer", {"demande": brute}, source=brute)

    raise Incomprise(
        brute,
        [
            "« ajoute un champ prix »",
            "« supprime la recherche »",
            "« renomme titre en nom »",
            "« teste », « liste », « décris », « annule »",
            "« aide » pour tout voir",
        ],
    )


#: Aide affichee par l'atelier.
AIDE = """Instructions comprises par l'atelier

  CRÉER
    crée une application de gestion de tâches avec un titre et une priorité

  MODIFIER
    ajoute un champ prix                 ajoute une date de livraison
    supprime le champ notes              retire la priorité
    renomme titre en nom                 renomme l'application en Suivi client
    ajoute la recherche                  ajoute l'export CSV
    supprime le tri                      retire les statistiques

  INSPECTER
    liste                                les fichiers du projet
    décris                               ce que fait le projet
    montre store.js                      le contenu d'un fichier
    diff                                 ce qui a changé au dernier tour
    historique                           tout ce qui a été fait

  EXÉCUTER
    teste                                lance les tests du projet

  REVENIR
    annule                               défait la dernière modification

  aide · quitte
"""
