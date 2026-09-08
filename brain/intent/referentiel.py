"""Ce que contiennent reellement les applications qui existent deja.

Le probleme que ce fichier resout : personne n'a envie de dicter la liste des
champs. On dit « un carnet de contacts », pas « un carnet de contacts avec un
nom, un prenom, un email, un telephone, une societe et des notes ». Un humain
qui a deja vu un carnet d'adresses sait ce qu'il y a dedans ; le generateur doit
le savoir aussi.

C'est donc un **referentiel de conventions** : pour chaque domaine, les champs
que portent les applications de ce type, leur nature, leurs valeurs possibles,
les fonctions qu'on y trouve toujours, et de quoi remplir l'application
d'exemples credibles des la premiere ouverture.

Deux precisions honnetes :

* rien n'est consulte sur le reseau au moment de la generation. Ces conventions
  sont **observees puis figees ici**, ce qui les rend deterministes, verifiables
  et utilisables hors ligne — un site distant qui change ne peut pas casser vos
  applications ;
* ce que la phrase dit explicitement l'emporte toujours. Le referentiel
  complete, il ne contredit pas. Et « juste », « seulement » ou « uniquement »
  le desactivent entierement.

Ce fichier est l'unique source : `scripts/exporter_lexique.py` en derive la
version JavaScript que lit la page publique, et un test verifie que les deux
analyses restent identiques.
"""

from __future__ import annotations

from .lexique import normalise

#: Mots par lesquels on demande explicitement de s'en tenir a ce qui est dit.
RESTRICTIFS: tuple[str, ...] = (
    "juste",
    "seulement",
    "uniquement",
    "rien de plus",
    "rien d autre",
    "pas plus",
    "minimaliste",
    "strictement",
)


def c(
    libelle: str,
    type_: str = "texte",
    options: list[str] | None = None,
    exemples: list[str] | None = None,
) -> dict:
    """Un champ du referentiel."""
    return {
        "libelle": libelle,
        "type": type_,
        "options": options or [],
        "exemples": exemples or [],
    }


def m(champs: list[dict], fonctions: list[str], source: str) -> dict:
    """Un modele : les champs d'un domaine, ses fonctions, et d'ou il vient."""
    return {"champs": champs, "fonctions": sorted(set(fonctions)), "source": source}


# --------------------------------------------------------------------------- #
# Valeurs revenant dans beaucoup de domaines
# --------------------------------------------------------------------------- #
_PRIORITE = ["Basse", "Normale", "Haute", "Urgente"]
_PAIEMENT = ["Carte", "Espèces", "Virement", "Prélèvement"]
_JOURS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"]
_PERIODE = ["Mensuel", "Trimestriel", "Annuel"]


# --------------------------------------------------------------------------- #
# Le referentiel
#
# La cle est le pluriel de l'entite, normalise (sans accent, en minuscules) :
# c'est exactement ce que produit `lexique.normalise` sur ce que renvoie
# l'analyse, donc la correspondance ne demande aucune table d'alias.
# --------------------------------------------------------------------------- #
MODELES: dict[str, dict] = {
    # ------------------------------------------------------ vie quotidienne
    "taches": m(
        [
            c("Titre", "texte", exemples=["Préparer la réunion", "Acheter du pain", "Relancer le devis"]),
            c("Priorité", "choix", _PRIORITE),
            c("Échéance", "date"),
            c("Projet", "texte", exemples=["Refonte du site", "Personnel", "Commercial"]),
            c("Terminé", "booleen"),
            c("Notes", "texte_long"),
        ],
        ["recherche", "filtre", "tri", "cochage", "statistiques"],
        "les gestionnaires de tâches",
    ),
    "courses": m(
        [
            c("Article", "texte", exemples=["Pain complet", "Tomates cerises", "Lessive"]),
            c("Quantité", "nombre"),
            c("Rayon", "choix", ["Fruits et légumes", "Frais", "Épicerie", "Boissons", "Entretien", "Hygiène"]),
            c("Prix", "nombre"),
            c("Acheté", "booleen"),
        ],
        ["filtre", "tri", "cochage", "statistiques"],
        "les listes de courses",
    ),
    "habitudes": m(
        [
            c("Nom", "texte", exemples=["Courir 30 minutes", "Lire", "Boire 2 L d'eau"]),
            c("Fréquence", "choix", ["Quotidien", "Hebdomadaire", "Mensuel"]),
            c("Objectif", "nombre"),
            c("Série en cours", "nombre"),
            c("Dernière fois", "date"),
            c("Fait aujourd'hui", "booleen"),
        ],
        ["cochage", "statistiques", "tri"],
        "les suivis d'habitudes",
    ),
    "objectifs": m(
        [
            c("Intitulé", "texte", exemples=["Apprendre l'espagnol", "Courir un semi-marathon", "Épargner 3 000 €"]),
            c("Catégorie", "choix", ["Santé", "Travail", "Finances", "Apprentissage", "Personnel"]),
            c("Échéance", "date"),
            c("Avancement", "pourcentage"),
            c("Priorité", "choix", _PRIORITE),
            c("Atteint", "booleen"),
        ],
        ["filtre", "tri", "statistiques"],
        "les suivis d'objectifs",
    ),
    "idees": m(
        [
            c("Titre", "texte", exemples=["Newsletter mensuelle", "Atelier découverte", "Programme de parrainage"]),
            c("Description", "texte_long"),
            c("Catégorie", "choix", ["Produit", "Marketing", "Organisation", "Personnel"]),
            c("Impact", "choix", ["Faible", "Moyen", "Fort"]),
            c("Effort", "choix", ["Faible", "Moyen", "Fort"]),
            c("Retenue", "booleen"),
        ],
        ["filtre", "tri", "recherche"],
        "les carnets d'idées",
    ),
    "notes": m(
        [
            c("Titre", "texte", exemples=["Compte rendu du 12 mars", "Idées de lecture", "Mot de passe wifi"]),
            c("Contenu", "texte_long"),
            c("Étiquette", "choix", ["Important", "Normal", "Plus tard"]),
            c("Date", "date"),
            c("Épinglée", "booleen"),
        ],
        ["recherche", "filtre", "tri"],
        "les applications de prise de notes",
    ),
    "citations": m(
        [
            c("Citation", "texte_long"),
            c("Auteur", "texte", exemples=["Simone Weil", "Marc Aurèle", "Anonyme"]),
            c("Source", "texte", exemples=["La Pesanteur et la Grâce", "Pensées", "Entretien"]),
            c("Thème", "choix", ["Travail", "Vie", "Art", "Science"]),
            c("Favorite", "booleen"),
        ],
        ["recherche", "filtre"],
        "les recueils de citations",
    ),
    "signets": m(
        [
            c("Titre", "texte", exemples=["Documentation MDN", "Recette du pain", "Article sur le sommeil"]),
            c("Adresse", "url"),
            c("Catégorie", "choix", ["Travail", "Lecture", "Outils", "Loisirs"]),
            c("Description", "texte"),
            c("Favori", "booleen"),
        ],
        ["recherche", "filtre", "doublons"],
        "les gestionnaires de favoris",
    ),
    "documents": m(
        [
            c("Titre", "texte", exemples=["Contrat de bail", "Facture EDF janvier", "Attestation d'assurance"]),
            c("Type", "choix", ["Contrat", "Facture", "Attestation", "Courrier", "Autre"]),
            c("Date", "date"),
            c("Emplacement", "texte", exemples=["Classeur bleu", "Dossier « Impôts »", "Coffre"]),
            c("Lien", "url"),
            c("Archivé", "booleen"),
        ],
        ["recherche", "filtre", "tri", "archivage"],
        "les classeurs de documents",
    ),
    "cadeaux": m(
        [
            c("Idée", "texte", exemples=["Casque audio", "Cours de poterie", "Livre de cuisine"]),
            c("Pour qui", "texte", exemples=["Camille", "Papa", "Sofia"]),
            c("Occasion", "choix", ["Anniversaire", "Noël", "Mariage", "Naissance", "Autre"]),
            c("Budget", "nombre"),
            c("Lien", "url"),
            c("Acheté", "booleen"),
        ],
        ["filtre", "tri", "cochage", "statistiques"],
        "les listes de cadeaux",
    ),
    "prets": m(
        [
            c("Objet", "texte", exemples=["Perceuse", "Le Comte de Monte-Cristo", "Remorque"]),
            c("Emprunteur", "texte", exemples=["Julien", "Voisine du 3e", "Club de rando"]),
            c("Date de prêt", "date"),
            c("Retour prévu", "date"),
            c("Rendu", "booleen"),
            c("Notes", "texte_long"),
        ],
        ["filtre", "tri", "cochage"],
        "les carnets de prêts",
    ),
    # ------------------------------------------------------------- personnes
    "contacts": m(
        [
            c("Nom", "texte", exemples=["Bernard", "Nguyen", "Ferreira"]),
            c("Prénom", "texte", exemples=["Claire", "Minh", "Ana"]),
            c("Email", "email"),
            c("Téléphone", "telephone"),
            c("Société", "texte", exemples=["Atelier Bertin", "Indépendante", "Mairie de Lyon"]),
            c("Adresse", "texte", exemples=["12 rue des Lilas, Lyon", "8 place du Marché, Nantes", "—"]),
            c("Notes", "texte_long"),
        ],
        ["recherche", "tri", "export", "doublons"],
        "les carnets d'adresses",
    ),
    "clients": m(
        [
            c("Nom", "texte", exemples=["Boulangerie Mercier", "Cabinet Lambert", "Studio Vert"]),
            c("Interlocuteur", "texte", exemples=["Claire Bernard", "Paul Lambert", "Ana Ferreira"]),
            c("Email", "email"),
            c("Téléphone", "telephone"),
            c("Statut", "choix", ["Prospect", "Actif", "Inactif"]),
            c("Chiffre d'affaires", "nombre"),
            c("Notes", "texte_long"),
        ],
        ["recherche", "filtre", "tri", "statistiques", "export"],
        "les fichiers clients",
    ),
    "fournisseurs": m(
        [
            c("Nom", "texte", exemples=["Métro", "Papeterie du Centre", "Transports Roy"]),
            c("Contact", "texte", exemples=["Karim Aït", "Service commercial", "Léa Dubois"]),
            c("Email", "email"),
            c("Téléphone", "telephone"),
            c("Catégorie", "choix", ["Matières premières", "Fournitures", "Services", "Transport"]),
            c("Délai de livraison", "nombre"),
            c("Notes", "texte_long"),
        ],
        ["recherche", "filtre", "tri", "export"],
        "les fichiers fournisseurs",
    ),
    "employes": m(
        [
            c("Nom", "texte", exemples=["Bernard", "Nguyen", "Ferreira"]),
            c("Prénom", "texte", exemples=["Claire", "Minh", "Ana"]),
            c("Poste", "texte", exemples=["Développeuse", "Comptable", "Responsable atelier"]),
            c("Service", "choix", ["Direction", "Production", "Commercial", "Administratif", "Technique"]),
            c("Email", "email"),
            c("Date d'embauche", "date"),
            c("Salaire", "nombre"),
        ],
        ["recherche", "filtre", "tri", "statistiques", "export"],
        "les registres du personnel",
    ),
    "adherents": m(
        [
            c("Nom", "texte", exemples=["Bernard", "Nguyen", "Ferreira"]),
            c("Prénom", "texte", exemples=["Claire", "Minh", "Ana"]),
            c("Email", "email"),
            c("Téléphone", "telephone"),
            c("Date d'adhésion", "date"),
            c("Cotisation", "nombre"),
            c("À jour", "booleen"),
        ],
        ["recherche", "filtre", "tri", "statistiques", "export"],
        "les registres d'adhérents",
    ),
    "membres": m(
        [
            c("Nom", "texte", exemples=["Bernard", "Nguyen", "Ferreira"]),
            c("Prénom", "texte", exemples=["Claire", "Minh", "Ana"]),
            c("Email", "email"),
            c("Rôle", "choix", ["Membre", "Bénévole", "Bureau", "Président"]),
            c("Date d'inscription", "date"),
            c("Actif", "booleen"),
        ],
        ["recherche", "filtre", "tri", "export"],
        "les annuaires de membres",
    ),
    "eleves": m(
        [
            c("Nom", "texte", exemples=["Bernard", "Nguyen", "Ferreira"]),
            c("Prénom", "texte", exemples=["Claire", "Minh", "Ana"]),
            c("Classe", "texte", exemples=["6e B", "3e A", "Terminale"]),
            c("Date de naissance", "date"),
            c("Email du responsable", "email"),
            c("Téléphone", "telephone"),
            c("Moyenne", "nombre"),
        ],
        ["recherche", "filtre", "tri", "statistiques", "export"],
        "les listes de classe",
    ),
    "invites": m(
        [
            c("Nom", "texte", exemples=["Claire Bernard", "Minh Nguyen", "Famille Ferreira"]),
            c("Email", "email"),
            c("Téléphone", "telephone"),
            c("Nombre de personnes", "nombre"),
            c("Table", "texte", exemples=["Table 1", "Table 2", "Table d'honneur"]),
            c("Régime alimentaire", "choix", ["Aucun", "Végétarien", "Sans gluten", "Autre"]),
            c("Confirmé", "booleen"),
        ],
        ["recherche", "filtre", "cochage", "statistiques", "export"],
        "les listes d'invités",
    ),
    "joueurs": m(
        [
            c("Nom", "texte", exemples=["Bernard", "Nguyen", "Ferreira"]),
            c("Prénom", "texte", exemples=["Claire", "Minh", "Ana"]),
            c("Poste", "texte", exemples=["Attaquante", "Milieu", "Gardien"]),
            c("Numéro", "nombre"),
            c("Date de naissance", "date"),
            c("Buts", "nombre"),
            c("Actif", "booleen"),
        ],
        ["recherche", "filtre", "tri", "statistiques"],
        "les effectifs sportifs",
    ),
    "candidatures": m(
        [
            c("Poste", "texte", exemples=["Développeuse front", "Chargé de communication", "Comptable"]),
            c("Entreprise", "texte", exemples=["Atelier Bertin", "Studio Vert", "Mairie de Lyon"]),
            c("Date de candidature", "date"),
            c("Statut", "choix", ["Envoyée", "Relancée", "Entretien", "Refusée", "Acceptée"]),
            c("Contact", "texte", exemples=["Claire Bernard", "recrutement@", "—"]),
            c("Lien", "url"),
            c("Notes", "texte_long"),
        ],
        ["recherche", "filtre", "tri", "statistiques"],
        "les suivis de candidatures",
    ),
    "conges": m(
        [
            c("Personne", "texte", exemples=["Claire Bernard", "Minh Nguyen", "Ana Ferreira"]),
            c("Type", "choix", ["Congés payés", "RTT", "Maladie", "Sans solde"]),
            c("Début", "date"),
            c("Fin", "date"),
            c("Jours", "nombre"),
            c("Approuvé", "booleen"),
        ],
        ["filtre", "tri", "statistiques", "cochage"],
        "les suivis de congés",
    ),
    # -------------------------------------------------------------- argent
    "depenses": m(
        [
            c("Libellé", "texte", exemples=["Courses du samedi", "Abonnement train", "Restaurant"]),
            c("Montant", "nombre"),
            c("Date", "date"),
            c("Catégorie", "choix", ["Alimentation", "Logement", "Transport", "Loisirs", "Santé", "Autre"]),
            c("Moyen de paiement", "choix", _PAIEMENT),
            c("Remboursé", "booleen"),
        ],
        ["recherche", "filtre", "tri", "statistiques", "export"],
        "les suivis de dépenses",
    ),
    "budgets": m(
        [
            c("Poste", "texte", exemples=["Alimentation", "Logement", "Loisirs"]),
            c("Montant prévu", "nombre"),
            c("Montant réalisé", "nombre"),
            c("Période", "choix", _PERIODE),
            c("Catégorie", "choix", ["Fixe", "Variable", "Exceptionnel"]),
        ],
        ["filtre", "tri", "statistiques", "export"],
        "les budgets prévisionnels",
    ),
    "factures": m(
        [
            c("Numéro", "texte", exemples=["2026-001", "2026-002", "2026-003"]),
            c("Client", "texte", exemples=["Boulangerie Mercier", "Cabinet Lambert", "Studio Vert"]),
            c("Montant HT", "nombre"),
            c("TVA", "pourcentage"),
            c("Date d'émission", "date"),
            c("Échéance", "date"),
            c("Statut", "choix", ["Brouillon", "Envoyée", "Payée", "En retard"]),
        ],
        ["recherche", "filtre", "tri", "statistiques", "export", "impression"],
        "les logiciels de facturation",
    ),
    "devis": m(
        [
            c("Numéro", "texte", exemples=["D2026-014", "D2026-015", "D2026-016"]),
            c("Client", "texte", exemples=["Boulangerie Mercier", "Cabinet Lambert", "Studio Vert"]),
            c("Montant", "nombre"),
            c("Date", "date"),
            c("Valable jusqu'au", "date"),
            c("Statut", "choix", ["Brouillon", "Envoyé", "Accepté", "Refusé"]),
        ],
        ["recherche", "filtre", "tri", "statistiques", "impression"],
        "les logiciels de devis",
    ),
    "paiements": m(
        [
            c("Libellé", "texte", exemples=["Facture 2026-001", "Salaire janvier", "Loyer"]),
            c("Montant", "nombre"),
            c("Date", "date"),
            c("Moyen", "choix", _PAIEMENT),
            c("Bénéficiaire", "texte", exemples=["Atelier Bertin", "Claire Bernard", "SCI du Parc"]),
            c("Validé", "booleen"),
        ],
        ["filtre", "tri", "statistiques", "export"],
        "les registres de paiements",
    ),
    "abonnements": m(
        [
            c("Nom", "texte", exemples=["Forfait mobile", "Salle de sport", "Streaming musique"]),
            c("Montant", "nombre"),
            c("Fréquence", "choix", _PERIODE),
            c("Prochain prélèvement", "date"),
            c("Catégorie", "choix", ["Loisirs", "Travail", "Maison", "Santé"]),
            c("Actif", "booleen"),
        ],
        ["filtre", "tri", "statistiques"],
        "les suivis d'abonnements",
    ),
    "dons": m(
        [
            c("Donateur", "texte", exemples=["Claire Bernard", "Anonyme", "Entreprise Roy"]),
            c("Montant", "nombre"),
            c("Date", "date"),
            c("Moyen", "choix", _PAIEMENT),
            c("Reçu envoyé", "booleen"),
        ],
        ["recherche", "filtre", "tri", "statistiques", "export"],
        "les suivis de dons associatifs",
    ),
    "ventes": m(
        [
            c("Produit", "texte", exemples=["Pain complet", "Tarte aux pommes", "Café"]),
            c("Client", "texte", exemples=["Comptoir", "Boulangerie Mercier", "Studio Vert"]),
            c("Quantité", "nombre"),
            c("Prix unitaire", "nombre"),
            c("Date", "date"),
            c("Payée", "booleen"),
        ],
        ["recherche", "filtre", "tri", "statistiques", "export"],
        "les journaux de ventes",
    ),
    # ------------------------------------------------------------ commerce
    "produits": m(
        [
            c("Nom", "texte", exemples=["Pain complet", "Tarte aux pommes", "Café en grains"]),
            c("Référence", "texte", exemples=["PC-500", "TP-01", "CG-250"]),
            c("Prix", "nombre"),
            c("Catégorie", "choix", ["Boulangerie", "Pâtisserie", "Boissons", "Épicerie"]),
            c("Stock", "nombre"),
            c("Disponible", "booleen"),
            c("Description", "texte_long"),
        ],
        ["recherche", "filtre", "tri", "statistiques", "export"],
        "les catalogues produits",
    ),
    "stocks": m(
        [
            c("Article", "texte", exemples=["Farine T65", "Beurre doux", "Sachets kraft"]),
            c("Référence", "texte", exemples=["FAR-65", "BEU-DX", "SAC-KR"]),
            c("Quantité", "nombre"),
            c("Seuil d'alerte", "nombre"),
            c("Emplacement", "texte", exemples=["Réserve A", "Chambre froide", "Étagère 3"]),
            c("Prix unitaire", "nombre"),
        ],
        ["recherche", "filtre", "tri", "statistiques", "export"],
        "les logiciels de gestion de stock",
    ),
    "commandes": m(
        [
            c("Numéro", "texte", exemples=["CM-1041", "CM-1042", "CM-1043"]),
            c("Client", "texte", exemples=["Claire Bernard", "Boulangerie Mercier", "Studio Vert"]),
            c("Date", "date"),
            c("Montant", "nombre"),
            c("Statut", "choix", ["En attente", "Préparée", "Expédiée", "Livrée", "Annulée"]),
            c("Transporteur", "texte", exemples=["Colissimo", "Retrait boutique", "Chronopost"]),
            c("Adresse de livraison", "texte_long"),
        ],
        ["recherche", "filtre", "tri", "statistiques", "export"],
        "les back-offices de commandes",
    ),
    "reservations": m(
        [
            c("Nom", "texte", exemples=["Claire Bernard", "Minh Nguyen", "Famille Ferreira"]),
            c("Date", "date"),
            c("Heure", "heure"),
            c("Personnes", "nombre"),
            c("Téléphone", "telephone"),
            c("Statut", "choix", ["En attente", "Confirmée", "Annulée"]),
            c("Notes", "texte_long"),
        ],
        ["recherche", "filtre", "tri", "statistiques"],
        "les carnets de réservation",
    ),
    "biens": m(
        [
            c("Adresse", "texte", exemples=["12 rue des Lilas", "8 place du Marché", "3 impasse Verte"]),
            c("Type", "choix", ["Studio", "T2", "T3", "T4", "Maison"]),
            c("Surface", "nombre"),
            c("Loyer", "nombre"),
            c("Charges", "nombre"),
            c("Locataire", "texte", exemples=["Claire Bernard", "Minh Nguyen", "Libre"]),
            c("Disponible", "booleen"),
        ],
        ["recherche", "filtre", "tri", "statistiques"],
        "les logiciels de gestion locative",
    ),
    "licences": m(
        [
            c("Logiciel", "texte", exemples=["Suite bureautique", "Antivirus", "Outil de design"]),
            c("Clé", "texte", exemples=["XXXX-1111", "XXXX-2222", "XXXX-3333"]),
            c("Type", "choix", ["Perpétuelle", "Abonnement", "Gratuite"]),
            c("Date d'achat", "date"),
            c("Expiration", "date"),
            c("Postes", "nombre"),
        ],
        ["recherche", "filtre", "tri"],
        "les inventaires de licences",
    ),
    # ------------------------------------------------------------- travail
    "projets": m(
        [
            c("Nom", "texte", exemples=["Refonte du site", "Ouverture boutique", "Migration serveur"]),
            c("Client", "texte", exemples=["Boulangerie Mercier", "Interne", "Studio Vert"]),
            c("Statut", "choix", ["À faire", "En cours", "En pause", "Terminé"]),
            c("Début", "date"),
            c("Échéance", "date"),
            c("Avancement", "pourcentage"),
            c("Budget", "nombre"),
        ],
        ["recherche", "filtre", "tri", "statistiques"],
        "les outils de gestion de projet",
    ),
    "tickets": m(
        [
            c("Sujet", "texte", exemples=["Impossible de se connecter", "Facture erronée", "Demande d'accès"]),
            c("Demandeur", "texte", exemples=["Claire Bernard", "Minh Nguyen", "Ana Ferreira"]),
            c("Priorité", "choix", _PRIORITE),
            c("Statut", "choix", ["Ouvert", "En cours", "Résolu", "Fermé"]),
            c("Ouvert le", "date"),
            c("Assigné à", "texte", exemples=["Support niveau 1", "Karim", "Non assigné"]),
            c("Description", "texte_long"),
        ],
        ["recherche", "filtre", "tri", "statistiques"],
        "les outils de support",
    ),
    "incidents": m(
        [
            c("Titre", "texte", exemples=["Panne de la caisse", "Site indisponible", "Fuite réserve"]),
            c("Gravité", "choix", ["Mineure", "Majeure", "Critique"]),
            c("Date", "date"),
            c("Système", "texte", exemples=["Caisse", "Site web", "Bâtiment"]),
            c("Statut", "choix", ["Ouvert", "En cours", "Résolu"]),
            c("Description", "texte_long"),
        ],
        ["recherche", "filtre", "tri", "statistiques"],
        "les registres d'incidents",
    ),
    "bugs": m(
        [
            c("Titre", "texte", exemples=["Le total ignore la remise", "Bouton invisible sur mobile", "Export CSV vide"]),
            c("Sévérité", "choix", ["Mineur", "Majeur", "Bloquant"]),
            c("Statut", "choix", ["Ouvert", "En cours", "Corrigé", "Fermé"]),
            c("Version", "texte", exemples=["1.2.0", "1.2.1", "1.3.0"]),
            c("Assigné à", "texte", exemples=["Claire", "Minh", "Non assigné"]),
            c("Étapes de reproduction", "texte_long"),
        ],
        ["recherche", "filtre", "tri", "statistiques"],
        "les outils de suivi de bugs",
    ),
    "outils": m(
        [
            c("Nom", "texte", exemples=["Perceuse", "Scie circulaire", "Échelle"]),
            c("Catégorie", "choix", ["Électroportatif", "Manuel", "Mesure", "Sécurité"]),
            c("Emplacement", "texte", exemples=["Atelier", "Camion", "Réserve"]),
            c("État", "choix", ["Neuf", "Bon", "Usé"]),
            c("Prêté à", "texte", exemples=["—", "Julien", "Chantier nord"]),
            c("Valeur", "nombre"),
        ],
        ["recherche", "filtre", "tri", "statistiques"],
        "les inventaires d'outillage",
    ),
    "salles": m(
        [
            c("Nom", "texte", exemples=["Salle Bleue", "Atelier", "Amphi"]),
            c("Capacité", "nombre"),
            c("Étage", "texte", exemples=["Rez-de-chaussée", "1er", "2e"]),
            c("Équipement", "texte", exemples=["Vidéoprojecteur", "Tableau blanc", "Visioconférence"]),
            c("Disponible", "booleen"),
        ],
        ["filtre", "tri", "recherche"],
        "les plannings de salles",
    ),
    "rendez-vous": m(
        [
            c("Objet", "texte", exemples=["Point d'avancement", "Visite du local", "Entretien annuel"]),
            c("Personne", "texte", exemples=["Claire Bernard", "Minh Nguyen", "Ana Ferreira"]),
            c("Date", "date"),
            c("Heure", "heure"),
            c("Durée", "nombre"),
            c("Lieu", "texte", exemples=["Bureau", "Visioconférence", "Sur place"]),
            c("Confirmé", "booleen"),
        ],
        ["recherche", "filtre", "tri", "cochage"],
        "les agendas professionnels",
    ),
    "evenements": m(
        [
            c("Titre", "texte", exemples=["Assemblée générale", "Portes ouvertes", "Concert de printemps"]),
            c("Date", "date"),
            c("Heure", "heure"),
            c("Lieu", "texte", exemples=["Salle des fêtes", "Parc municipal", "Locaux"]),
            c("Type", "choix", ["Réunion", "Atelier", "Spectacle", "Sortie"]),
            c("Participants", "nombre"),
            c("Description", "texte_long"),
        ],
        ["recherche", "filtre", "tri", "statistiques"],
        "les agendas d'événements",
    ),
    "articles": m(
        [
            c("Titre", "texte", exemples=["Bien choisir sa farine", "Cinq idées de goûter", "Notre nouvelle boutique"]),
            c("Auteur", "texte", exemples=["Claire Bernard", "Rédaction", "Minh Nguyen"]),
            c("Catégorie", "choix", ["Actualité", "Conseil", "Recette", "Coulisses"]),
            c("Date de publication", "date"),
            c("Statut", "choix", ["Brouillon", "Relecture", "Publié"]),
            c("Contenu", "texte_long"),
        ],
        ["recherche", "filtre", "tri"],
        "les systèmes de publication",
    ),
    # ------------------------------------------------------------- culture
    "livres": m(
        [
            c("Titre", "texte", exemples=["Le Comte de Monte-Cristo", "La Horde du Contrevent", "Le Petit Prince"]),
            c("Auteur", "texte", exemples=["Alexandre Dumas", "Alain Damasio", "Antoine de Saint-Exupéry"]),
            c("Genre", "choix", ["Roman", "Essai", "Policier", "Science-fiction", "BD", "Jeunesse"]),
            c("Pages", "nombre"),
            c("Note", "etoiles"),
            c("Lu", "booleen"),
            c("Commentaire", "texte_long"),
        ],
        ["recherche", "filtre", "tri", "statistiques", "cochage"],
        "les bibliothèques personnelles",
    ),
    "films": m(
        [
            c("Titre", "texte", exemples=["Les Temps modernes", "Le Voyage de Chihiro", "Les Choses humaines"]),
            c("Réalisateur", "texte", exemples=["Charlie Chaplin", "Hayao Miyazaki", "Yvan Attal"]),
            c("Année", "nombre"),
            c("Genre", "choix", ["Action", "Comédie", "Drame", "Documentaire", "Animation", "Thriller"]),
            c("Durée", "nombre"),
            c("Note", "etoiles"),
            c("Vu", "booleen"),
        ],
        ["recherche", "filtre", "tri", "statistiques", "cochage"],
        "les catalogues de films",
    ),
    "series": m(
        [
            c("Titre", "texte", exemples=["Le Bureau des légendes", "Kaamelott", "En thérapie"]),
            c("Plateforme", "texte", exemples=["Canal+", "France TV", "Netflix"]),
            c("Saisons", "nombre"),
            c("Épisode en cours", "nombre"),
            c("Genre", "choix", ["Drame", "Comédie", "Policier", "Documentaire"]),
            c("Note", "etoiles"),
            c("Terminée", "booleen"),
        ],
        ["recherche", "filtre", "tri", "cochage"],
        "les suivis de séries",
    ),
    "morceaux": m(
        [
            c("Titre", "texte", exemples=["Ne me quitte pas", "La Bohème", "Formidable"]),
            c("Artiste", "texte", exemples=["Jacques Brel", "Charles Aznavour", "Stromae"]),
            c("Album", "texte", exemples=["La Valse à mille temps", "Bobino 68", "Racine carrée"]),
            c("Genre", "choix", ["Chanson", "Rock", "Jazz", "Électro", "Classique"]),
            c("Durée", "nombre"),
            c("Note", "etoiles"),
            c("Favori", "booleen"),
        ],
        ["recherche", "filtre", "tri"],
        "les bibliothèques musicales",
    ),
    "jeux": m(
        [
            c("Titre", "texte", exemples=["Les Aventuriers du rail", "Catan", "Dixit"]),
            c("Plateforme", "choix", ["Plateau", "PC", "Console", "Mobile"]),
            c("Genre", "choix", ["Stratégie", "Ambiance", "Coopératif", "Aventure"]),
            c("Durée", "nombre"),
            c("Joueurs", "nombre"),
            c("Note", "etoiles"),
            c("Terminé", "booleen"),
        ],
        ["recherche", "filtre", "tri", "statistiques"],
        "les ludothèques",
    ),
    "photos": m(
        [
            c("Titre", "texte", exemples=["Lever de soleil", "Portrait atelier", "Rue de Nantes"]),
            c("Date", "date"),
            c("Lieu", "texte", exemples=["Annecy", "Nantes", "Atelier"]),
            c("Album", "texte", exemples=["Vacances 2026", "Travail", "Famille"]),
            c("Note", "etoiles"),
            c("Favorite", "booleen"),
        ],
        ["recherche", "filtre", "tri"],
        "les photothèques",
    ),
    "voyages": m(
        [
            c("Destination", "texte", exemples=["Lisbonne", "Édimbourg", "Annecy"]),
            c("Pays", "texte", exemples=["Portugal", "Écosse", "France"]),
            c("Départ", "date"),
            c("Retour", "date"),
            c("Budget", "nombre"),
            c("Transport", "choix", ["Avion", "Train", "Voiture", "Bateau"]),
            c("Réservé", "booleen"),
        ],
        ["recherche", "filtre", "tri", "statistiques"],
        "les carnets de voyage",
    ),
    # ------------------------------------------------ maison, santé, sport
    "recettes": m(
        [
            c("Nom", "texte", exemples=["Tarte aux pommes", "Soupe de potiron", "Risotto aux champignons"]),
            c("Catégorie", "choix", ["Entrée", "Plat", "Dessert", "Boisson"]),
            c("Temps de préparation", "nombre"),
            c("Portions", "nombre"),
            c("Difficulté", "choix", ["Facile", "Moyen", "Difficile"]),
            c("Ingrédients", "texte_long"),
            c("Préparation", "texte_long"),
        ],
        ["recherche", "filtre", "tri", "impression"],
        "les carnets de recettes",
    ),
    "repas": m(
        [
            c("Plat", "texte", exemples=["Soupe de potiron", "Gratin de courgettes", "Salade de lentilles"]),
            c("Jour", "choix", _JOURS),
            c("Moment", "choix", ["Petit-déjeuner", "Déjeuner", "Dîner"]),
            c("Calories", "nombre"),
            c("Préparé", "booleen"),
        ],
        ["filtre", "tri", "cochage", "statistiques"],
        "les plannings de repas",
    ),
    "plantes": m(
        [
            c("Nom", "texte", exemples=["Monstera", "Basilic", "Ficus"]),
            c("Espèce", "texte", exemples=["Monstera deliciosa", "Ocimum basilicum", "Ficus elastica"]),
            c("Emplacement", "texte", exemples=["Salon", "Cuisine", "Balcon"]),
            c("Arrosage", "choix", ["Quotidien", "Hebdomadaire", "Bimensuel", "Mensuel"]),
            c("Dernier arrosage", "date"),
            c("Exposition", "choix", ["Plein soleil", "Mi-ombre", "Ombre"]),
            c("Notes", "texte_long"),
        ],
        ["recherche", "filtre", "tri"],
        "les carnets de plantes",
    ),
    "animaux": m(
        [
            c("Nom", "texte", exemples=["Pilou", "Nala", "Gribouille"]),
            c("Espèce", "choix", ["Chien", "Chat", "Cheval", "NAC", "Autre"]),
            c("Race", "texte", exemples=["Berger australien", "Européen", "Lapin bélier"]),
            c("Date de naissance", "date"),
            c("Poids", "nombre"),
            c("Vétérinaire", "texte", exemples=["Dr Lambert", "Clinique du Parc", "—"]),
            c("Vaccins à jour", "booleen"),
        ],
        ["recherche", "filtre", "tri", "cochage"],
        "les carnets de santé animale",
    ),
    "medicaments": m(
        [
            c("Nom", "texte", exemples=["Vitamine D", "Antihistaminique", "Fer"]),
            c("Dosage", "texte", exemples=["1000 UI", "10 mg", "80 mg"]),
            c("Fréquence", "choix", ["Quotidien", "Hebdomadaire", "Mensuel"]),
            c("Heure", "heure"),
            c("Début", "date"),
            c("Fin", "date"),
            c("Pris", "booleen"),
        ],
        ["filtre", "tri", "cochage"],
        "les piluliers numériques",
    ),
    "seances": m(
        [
            c("Titre", "texte", exemples=["Sortie longue", "Renforcement", "Natation"]),
            c("Date", "date"),
            c("Durée", "nombre"),
            c("Type", "choix", ["Cardio", "Renforcement", "Souplesse", "Repos actif"]),
            c("Intensité", "choix", ["Légère", "Modérée", "Intense"]),
            c("Terminée", "booleen"),
            c("Notes", "texte_long"),
        ],
        ["filtre", "tri", "cochage", "statistiques"],
        "les carnets d'entraînement",
    ),
    "entrainements": m(
        [
            c("Exercice", "texte", exemples=["Squat", "Développé couché", "Gainage"]),
            c("Date", "date"),
            c("Séries", "nombre"),
            c("Répétitions", "nombre"),
            c("Charge", "nombre"),
            c("Durée", "nombre"),
            c("Notes", "texte_long"),
        ],
        ["recherche", "filtre", "tri", "statistiques"],
        "les carnets de musculation",
    ),
    "matchs": m(
        [
            c("Adversaire", "texte", exemples=["AS Vallée", "FC Rivière", "US Coteaux"]),
            c("Date", "date"),
            c("Lieu", "choix", ["Domicile", "Extérieur"]),
            c("Score", "texte", exemples=["2-1", "0-0", "3-2"]),
            c("Compétition", "texte", exemples=["Championnat", "Coupe", "Amical"]),
            c("Résultat", "choix", ["Victoire", "Nul", "Défaite"]),
        ],
        ["filtre", "tri", "statistiques"],
        "les suivis de résultats sportifs",
    ),
    "trajets": m(
        [
            c("Départ", "texte", exemples=["Lyon", "Bureau", "Domicile"]),
            c("Arrivée", "texte", exemples=["Annecy", "Chantier nord", "Gare"]),
            c("Date", "date"),
            c("Distance", "nombre"),
            c("Durée", "nombre"),
            c("Motif", "choix", ["Professionnel", "Personnel"]),
            c("Coût", "nombre"),
        ],
        ["filtre", "tri", "statistiques", "export"],
        "les carnets de bord kilométriques",
    ),
    "vehicules": m(
        [
            c("Immatriculation", "texte", exemples=["AA-123-BB", "CC-456-DD", "EE-789-FF"]),
            c("Marque", "texte", exemples=["Renault", "Peugeot", "Citroën"]),
            c("Modèle", "texte", exemples=["Kangoo", "Partner", "Berlingo"]),
            c("Année", "nombre"),
            c("Kilométrage", "nombre"),
            c("Carburant", "choix", ["Essence", "Diesel", "Électrique", "Hybride"]),
            c("Prochain contrôle technique", "date"),
        ],
        ["recherche", "filtre", "tri", "statistiques"],
        "les parcs de véhicules",
    ),
    "recoltes": m(
        [
            c("Culture", "texte", exemples=["Tomates", "Courgettes", "Pommes"]),
            c("Parcelle", "texte", exemples=["Serre", "Verger", "Potager nord"]),
            c("Date", "date"),
            c("Quantité", "nombre"),
            c("Unité", "choix", ["kg", "g", "L", "pièce"]),
            c("Qualité", "choix", ["Excellente", "Bonne", "Moyenne"]),
        ],
        ["filtre", "tri", "statistiques", "export"],
        "les carnets de culture",
    ),
    # ---------------------------------------------------------- éducation
    "cours": m(
        [
            c("Intitulé", "texte", exemples=["Mathématiques", "Histoire-géographie", "Anglais"]),
            c("Enseignant", "texte", exemples=["Mme Bernard", "M. Nguyen", "Mme Ferreira"]),
            c("Jour", "choix", _JOURS),
            c("Heure", "heure"),
            c("Durée", "nombre"),
            c("Salle", "texte", exemples=["B12", "A04", "Amphi"]),
            c("Niveau", "choix", ["Débutant", "Intermédiaire", "Avancé"]),
        ],
        ["recherche", "filtre", "tri"],
        "les emplois du temps",
    ),
    "devoirs": m(
        [
            c("Matière", "texte", exemples=["Mathématiques", "Histoire", "Anglais"]),
            c("Intitulé", "texte", exemples=["Exercices 12 à 18", "Fiche de lecture", "Rédaction"]),
            c("À rendre le", "date"),
            c("Difficulté", "choix", ["Facile", "Moyen", "Difficile"]),
            c("Fait", "booleen"),
            c("Notes", "texte_long"),
        ],
        ["filtre", "tri", "cochage", "statistiques"],
        "les cahiers de textes",
    ),
    "formations": m(
        [
            c("Intitulé", "texte", exemples=["Secourisme", "Comptabilité", "Prise de parole"]),
            c("Organisme", "texte", exemples=["Croix-Rouge", "CCI", "Interne"]),
            c("Durée", "nombre"),
            c("Date", "date"),
            c("Coût", "nombre"),
            c("Validée", "booleen"),
        ],
        ["recherche", "filtre", "tri", "statistiques"],
        "les plans de formation",
    ),
    "inscriptions": m(
        [
            c("Nom", "texte", exemples=["Bernard", "Nguyen", "Ferreira"]),
            c("Prénom", "texte", exemples=["Claire", "Minh", "Ana"]),
            c("Email", "email"),
            c("Formation", "texte", exemples=["Secourisme", "Poterie", "Anglais"]),
            c("Date", "date"),
            c("Payée", "booleen"),
        ],
        ["recherche", "filtre", "tri", "statistiques", "export"],
        "les registres d'inscription",
    ),
}


# --------------------------------------------------------------------------- #
# Consultation
# --------------------------------------------------------------------------- #
def modele_pour(*noms: str) -> dict | None:
    """Le modele du premier nom reconnu, sinon None.

    On essaie le pluriel puis le singulier : `analyser` transmet les deux, et
    certains domaines n'existent qu'au pluriel (« courses », « stocks »).
    """
    for nom in noms:
        modele = MODELES.get(normalise(nom))
        if modele is not None:
            return modele
    return None


def restreint(texte: str) -> bool:
    """La phrase demande-t-elle de s'en tenir strictement a ce qui est dit ?"""
    plat = normalise(texte)
    return any(mot in plat for mot in RESTRICTIFS)


def domaines() -> list[str]:
    """Les domaines connus, tries — utile a l'affichage et aux tests."""
    return sorted(MODELES)
