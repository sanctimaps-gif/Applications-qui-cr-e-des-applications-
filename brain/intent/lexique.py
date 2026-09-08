"""Le vocabulaire francais que le compilateur d'intention sait reconnaitre.

Tout est ici, en clair : les mots qui designent une entite, ceux qui annoncent
un champ, ceux qui reclament une fonction. Ajouter un synonyme, c'est ajouter
une ligne — pas reentrainer un modele.
"""

from __future__ import annotations

import re
import unicodedata


def sans_accents(texte: str) -> str:
    """Retire les accents pour la comparaison, jamais pour l'affichage."""
    decompose = unicodedata.normalize("NFD", texte)
    return "".join(c for c in decompose if unicodedata.category(c) != "Mn")


def normalise(texte: str) -> str:
    """Forme de comparaison : minuscules, sans accents, espaces reduits."""
    return re.sub(r"\s+", " ", sans_accents(texte.lower())).strip()


# --------------------------------------------------------------------------- #
# Types de champs : le mot-cle donne le type, et le type donne le formulaire,
# la validation, le tri et l'affichage.
# --------------------------------------------------------------------------- #
TYPES_PAR_MOT: dict[str, str] = {}


def _enregistre(type_champ: str, *mots: str) -> None:
    for mot in mots:
        TYPES_PAR_MOT[normalise(mot)] = type_champ


_enregistre(
    "date",
    "date", "echeance", "deadline", "jour", "naissance", "debut", "fin",
    "date de debut", "date de fin", "date limite", "peremption", "publication",
)
_enregistre(
    "nombre",
    "prix", "montant", "cout", "tarif", "quantite", "nombre", "age", "duree",
    "poids", "taille", "stock", "note", "score", "points", "calories", "budget",
    "pages", "annee", "numero", "chiffre", "chiffre affaires", "solde",
    "salaire", "revenu", "surface", "distance", "vitesse", "capacite",
)
_enregistre(
    "booleen",
    "fait", "faite", "termine", "terminee", "actif", "active", "favori", "urgent",
    "lu", "lue", "vu", "vue", "paye", "payee", "disponible", "archive", "important",
)
_enregistre(
    "choix",
    "priorite", "statut", "etat", "categorie", "type", "genre", "rayon",
    "niveau", "difficulte", "couleur", "tag", "etiquette",
)
_enregistre("texte_long", "description", "notes", "commentaire", "remarque", "resume", "contenu", "adresse")
_enregistre("email", "email", "courriel", "mail", "e-mail")
_enregistre("url", "url", "lien", "site", "site web", "adresse web", "photo", "image", "illustration")
_enregistre(
    "telephone",
    "telephone", "tel", "portable", "mobile", "fixe", "numero de telephone",
)
_enregistre("couleur_hex", "couleur hex", "teinte", "code couleur")
_enregistre("pourcentage", "pourcentage", "taux", "progression", "avancement", "remise")
_enregistre("heure", "heure", "horaire", "moment")
_enregistre("etoiles", "etoiles", "appreciation", "satisfaction", "evaluation")

#: Valeurs proposees pour les champs de type « choix », selon leur nom.
OPTIONS_PAR_CHAMP: dict[str, list[str]] = {
    "priorite": ["Basse", "Moyenne", "Haute", "Urgente"],
    "statut": ["À faire", "En cours", "Terminé"],
    "etat": ["Neuf", "Bon", "Usé"],
    "difficulte": ["Facile", "Moyen", "Difficile"],
    "niveau": ["Débutant", "Intermédiaire", "Avancé"],
    "categorie": ["Général", "Travail", "Personnel"],
    "type": ["Général", "Travail", "Personnel"],
    "genre": ["Général", "Travail", "Personnel"],
    "rayon": ["Fruits et légumes", "Frais", "Épicerie", "Entretien"],
    "couleur": ["Rouge", "Vert", "Bleu", "Jaune"],
    "tag": ["Important", "Normal", "Plus tard"],
    "etiquette": ["Important", "Normal", "Plus tard"],
    "rayon": ["Fruits et légumes", "Frais", "Épicerie", "Entretien"],
    "saison": ["Printemps", "Été", "Automne", "Hiver"],
    "frequence": ["Quotidien", "Hebdomadaire", "Mensuel"],
    "paiement": ["Carte", "Espèces", "Virement"],
    "civilite": ["Mme", "M.", "Autre"],
    "taille": ["S", "M", "L", "XL"],
}

# --------------------------------------------------------------------------- #
# Fonctions : ce que l'application doit savoir faire.
# --------------------------------------------------------------------------- #
FONCTIONS_PAR_MOT: dict[str, str] = {}


def _fonction(nom: str, *mots: str) -> None:
    for mot in mots:
        FONCTIONS_PAR_MOT[normalise(mot)] = nom


_fonction("recherche", "recherche", "rechercher", "chercher", "trouver", "filtre texte", "barre de recherche")
_fonction("filtre", "filtre", "filtrer", "filtres", "trier par statut", "par categorie")
_fonction("tri", "tri", "trier", "classer", "ordonner", "ordre")
_fonction("suppression", "supprimer", "effacer", "retirer", "enlever", "suppression")
_fonction("edition", "modifier", "editer", "corriger", "mettre a jour", "edition", "modification")
_fonction("statistiques", "statistiques", "stats", "compteur", "compter", "total", "resume", "bilan")
_fonction("export", "exporter", "export", "csv", "telecharger", "sauvegarder en csv")
_fonction("cochage", "cocher", "marquer", "terminer", "valider", "case a cocher")
_fonction("persistance", "sauvegarde", "sauvegarder", "conserver", "garder", "persistant", "local", "localstorage")

_fonction("pagination", "pagination", "paginer", "pages", "par page")
_fonction("import", "importer", "import", "charger un csv", "reprendre un fichier")
_fonction("impression", "imprimer", "impression", "version papier")
_fonction("theme", "theme sombre", "mode sombre", "clair et sombre")
_fonction("archivage", "archiver", "archivage", "corbeille")
_fonction("doublons", "doublons", "eviter les doublons", "unicite")
_fonction("api", "api", "api rest", "endpoints", "service web")

#: Fonctions presentes par defaut : une application sans ajout ni liste n'a
#: aucun interet, et personne ne pense a les demander.
FONCTIONS_IMPLICITES = {"ajout", "liste", "persistance", "suppression"}

# --------------------------------------------------------------------------- #
# Entites : ce que l'application manipule.
# --------------------------------------------------------------------------- #
#: Amorces qui annoncent l'objet du logiciel.
AMORCES_ENTITE = [
    "application de gestion de",
    "application de gestion des",
    "logiciel de gestion de",
    "outil de gestion de",
    "gestionnaire de",
    "gestion de",
    "gestion des",
    "application de",
    "application pour gerer les",
    "application pour gerer",
    "liste de",
    "liste des",
    "carnet de",
    "carnet d",
    "suivi de",
    "suivi des",
    "catalogue de",
    "catalogue des",
    "journal de",
    "repertoire de",
    "annuaire de",
    "inventaire de",
    "inventaire des",
    "bibliotheque de",
    "registre de",
    "tableau de",
]

#: Entites connues : pluriel normalise -> (singulier, pluriel) affichables.
ENTITES_CONNUES: dict[str, tuple[str, str]] = {
    "taches": ("Tâche", "Tâches"),
    "tache": ("Tâche", "Tâches"),
    "recettes": ("Recette", "Recettes"),
    "recette": ("Recette", "Recettes"),
    "contacts": ("Contact", "Contacts"),
    "contact": ("Contact", "Contacts"),
    "livres": ("Livre", "Livres"),
    "livre": ("Livre", "Livres"),
    "films": ("Film", "Films"),
    "film": ("Film", "Films"),
    "depenses": ("Dépense", "Dépenses"),
    "depense": ("Dépense", "Dépenses"),
    "clients": ("Client", "Clients"),
    "client": ("Client", "Clients"),
    "produits": ("Produit", "Produits"),
    "produit": ("Produit", "Produits"),
    "notes": ("Note", "Notes"),
    "note": ("Note", "Notes"),
    "projets": ("Projet", "Projets"),
    "projet": ("Projet", "Projets"),
    "evenements": ("Événement", "Événements"),
    "evenement": ("Événement", "Événements"),
    "courses": ("Article", "Courses"),
    "articles": ("Article", "Articles"),
    "article": ("Article", "Articles"),
    "factures": ("Facture", "Factures"),
    "facture": ("Facture", "Factures"),
    "rendez-vous": ("Rendez-vous", "Rendez-vous"),
    "employes": ("Employé", "Employés"),
    "employe": ("Employé", "Employés"),
    "eleves": ("Élève", "Élèves"),
    "eleve": ("Élève", "Élèves"),
    "plantes": ("Plante", "Plantes"),
    "plante": ("Plante", "Plantes"),
    "seances": ("Séance", "Séances"),
    "seance": ("Séance", "Séances"),
    "habitudes": ("Habitude", "Habitudes"),
    "habitude": ("Habitude", "Habitudes"),
    "commandes": ("Commande", "Commandes"),
    "commande": ("Commande", "Commandes"),
    "taches": ("Tâche", "Tâches"),
    "abonnements": ("Abonnement", "Abonnements"),
    "abonnement": ("Abonnement", "Abonnements"),
    "fournisseurs": ("Fournisseur", "Fournisseurs"),
    "fournisseur": ("Fournisseur", "Fournisseurs"),
    "vehicules": ("Véhicule", "Véhicules"),
    "vehicule": ("Véhicule", "Véhicules"),
    "outils": ("Outil", "Outils"),
    "outil": ("Outil", "Outils"),
    "musiques": ("Morceau", "Morceaux"),
    "morceaux": ("Morceau", "Morceaux"),
    "series": ("Série", "Séries"),
    "serie": ("Série", "Séries"),
    "jeux": ("Jeu", "Jeux"),
    "jeu": ("Jeu", "Jeux"),
    "voyages": ("Voyage", "Voyages"),
    "voyage": ("Voyage", "Voyages"),
    "adherents": ("Adhérent", "Adhérents"),
    "adherent": ("Adhérent", "Adhérents"),
    "membres": ("Membre", "Membres"),
    "membre": ("Membre", "Membres"),
    "candidatures": ("Candidature", "Candidatures"),
    "candidature": ("Candidature", "Candidatures"),
    "reservations": ("Réservation", "Réservations"),
    "reservation": ("Réservation", "Réservations"),
    "tickets": ("Ticket", "Tickets"),
    "ticket": ("Ticket", "Tickets"),
    "incidents": ("Incident", "Incidents"),
    "incident": ("Incident", "Incidents"),
    "stocks": ("Article", "Stocks"),
    "recolte": ("Récolte", "Récoltes"),
    "recoltes": ("Récolte", "Récoltes"),
    "entrainements": ("Entraînement", "Entraînements"),
    "entrainement": ("Entraînement", "Entraînements"),
    "repas": ("Repas", "Repas"),
    "medicaments": ("Médicament", "Médicaments"),
    "medicament": ("Médicament", "Médicaments"),
    "documents": ("Document", "Documents"),
    "document": ("Document", "Documents"),
    "signets": ("Signet", "Signets"),
    "signet": ("Signet", "Signets"),
    "citations": ("Citation", "Citations"),
    "citation": ("Citation", "Citations"),
    "idees": ("Idée", "Idées"),
    "idee": ("Idée", "Idées"),
    "budgets": ("Budget", "Budgets"),
    "budget": ("Budget", "Budgets"),
    "salles": ("Salle", "Salles"),
    "salle": ("Salle", "Salles"),
    "cours": ("Cours", "Cours"),
    "devis": ("Devis", "Devis"),
    "paiements": ("Paiement", "Paiements"),
    "paiement": ("Paiement", "Paiements"),
}

#: Mots qui ne peuvent jamais designer une entite ni un champ.
MOTS_VIDES = {
    "une", "un", "le", "la", "les", "des", "de", "du", "d", "l", "et", "ou", "avec",
    "pour", "par", "sur", "dans", "en", "qui", "que", "application", "app", "site",
    "page", "web", "logiciel", "outil", "programme", "simple", "petite", "petit",
    "mon", "ma", "mes", "je", "veux", "voudrais", "souhaite", "faire", "creer",
    "permet", "permettant", "possibilite", "gerer", "chaque", "leur", "leurs",
    "ainsi", "aussi", "puis", "avoir", "etre", "sa", "son", "ses", "ce", "cette",
    # Mots d'habillage : « une case terminé » designe le champ « terminé ».
    "case", "champ", "champs", "colonne", "colonnes", "rubrique", "zone",
    "possibilite de", "bouton",
}


def singulier(mot: str) -> str:
    """Singulier approximatif d'un nom francais."""
    base = mot.strip()
    if len(base) <= 3:
        return base
    if base.endswith("aux"):
        return base[:-3] + "al"
    if base.endswith("eaux"):
        return base[:-1]
    if base.endswith("s") and not base.endswith("us") and not base.endswith("as"):
        return base[:-1]
    return base


def pluriel(mot: str) -> str:
    """Pluriel approximatif d'un nom francais."""
    base = mot.strip()
    if not base:
        return base
    if base.endswith(("s", "x", "z")):
        return base
    if base.endswith("al"):
        return base[:-2] + "aux"
    if base.endswith(("eau", "eu")):
        return base + "x"
    return base + "s"


def capitalise(mot: str) -> str:
    """Majuscule initiale, sans toucher au reste (« rendez-vous »)."""
    return mot[:1].upper() + mot[1:] if mot else mot


def identifiant(texte: str) -> str:
    """Nom de variable JavaScript valide, derive d'un libelle francais."""
    base = re.sub(r"[^a-z0-9]+", "_", normalise(texte)).strip("_")
    if not base:
        return "champ"
    if base[0].isdigit():
        base = "c_" + base
    return base


def type_du_champ(libelle: str) -> str:
    """Devine le type d'un champ d'apres son nom."""
    cle = normalise(libelle)
    if cle in TYPES_PAR_MOT:
        return TYPES_PAR_MOT[cle]
    # « date de livraison » -> date ; « prix unitaire » -> nombre.
    for mot in cle.split():
        if mot in TYPES_PAR_MOT:
            return TYPES_PAR_MOT[mot]
    return "texte"


def options_du_champ(libelle: str) -> list[str]:
    cle = normalise(libelle)
    if cle in OPTIONS_PAR_CHAMP:
        return list(OPTIONS_PAR_CHAMP[cle])
    for mot in cle.split():
        if mot in OPTIONS_PAR_CHAMP:
            return list(OPTIONS_PAR_CHAMP[mot])
    return ["Option A", "Option B"]


# --------------------------------------------------------------------------- #
# Cibles : le meme plan peut donner une application web, une API ou un outil
# en ligne de commande. La phrase decide.
# --------------------------------------------------------------------------- #
CIBLES_PAR_MOT: dict[str, str] = {}


def _cible(nom: str, *mots: str) -> None:
    for mot in mots:
        CIBLES_PAR_MOT[normalise(mot)] = nom


_cible("api", "api", "api rest", "rest", "backend", "service web", "serveur", "endpoints", "microservice")
_cible("cli", "ligne de commande", "cli", "terminal", "console", "script shell", "en ligne de commande")
_cible("web", "web", "page web", "site", "interface", "navigateur", "application web")


def cible_demandee(texte: str) -> str:
    """Cible de generation deduite de la phrase. « web » par defaut."""
    plat = normalise(texte)
    meilleure, position = "web", len(plat) + 1
    for mot, cible in CIBLES_PAR_MOT.items():
        trouve = re.search(rf"\b{re.escape(mot)}\b", plat)
        if trouve and trouve.start() < position:
            meilleure, position = cible, trouve.start()
    return meilleure
