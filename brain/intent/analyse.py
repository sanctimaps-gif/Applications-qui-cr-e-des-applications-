"""Comprendre la phrase : du francais vers une specification exploitable.

Aucun modele statistique. On analyse la phrase avec des regles explicites, et
surtout on rend compte de ce qui a ete compris ET de ce qui a ete ignore : un
generateur qui devine en silence est pire qu'un generateur qui avoue.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .lexique import (
    AMORCES_ENTITE,
    ENTITES_CONNUES,
    FONCTIONS_IMPLICITES,
    FONCTIONS_PAR_MOT,
    MOTS_VIDES,
    capitalise,
    cible_demandee,
    identifiant,
    normalise,
    options_du_champ,
    pluriel,
    singulier,
    type_du_champ,
)
from .referentiel import modele_pour, restreint

#: Au-dela, un formulaire devient illisible. Vaut pour la fusion comme pour
#: l'enumeration explicite.
MAX_CHAMPS = 9

#: Libelles lisibles des cibles de generation.
CIBLES_LISIBLES = {
    "web": "application web (navigateur)",
    "api": "API REST (Node)",
    "cli": "outil en ligne de commande (Node)",
}


@dataclass
class Champ:
    """Une propriete de l'entite manipulee."""

    cle: str  # identifiant JavaScript
    libelle: str  # ce que voit l'utilisateur
    type: str  # texte | texte_long | nombre | date | booleen | choix | email | url
    options: list[str] = field(default_factory=list)
    requis: bool = False
    #: Valeurs credibles pour remplir l'application des l'ouverture. Viennent
    #: du referentiel quand le domaine est reconnu ; vides sinon.
    exemples: list[str] = field(default_factory=list)


@dataclass
class Intention:
    """Ce que le compilateur a compris de la demande."""

    demande: str
    titre: str
    singulier: str
    pluriel: str
    champs: list[Champ]
    fonctions: set[str]
    compris: list[str] = field(default_factory=list)
    ignore: list[str] = field(default_factory=list)
    confiance: float = 0.0
    #: « web » (navigateur), « api » (service REST) ou « cli » (terminal).
    cible: str = "web"

    # ------------------------------------------------------------------ #
    # Persistance : le projet garde sa specification, donc il reste
    # modifiable. C'est ce qui permet a l'atelier de faire evoluer une
    # application sans jamais relire ni deviner le code deja ecrit.
    # ------------------------------------------------------------------ #
    def to_dict(self) -> dict:
        return {
            "version": 1,
            "demande": self.demande,
            "titre": self.titre,
            "singulier": self.singulier,
            "pluriel": self.pluriel,
            "champs": [
                {
                    "cle": c.cle,
                    "libelle": c.libelle,
                    "type": c.type,
                    "options": list(c.options),
                    "requis": c.requis,
                    "exemples": list(c.exemples),
                }
                for c in self.champs
            ],
            "fonctions": sorted(self.fonctions),
            "cible": self.cible,
            "confiance": self.confiance,
        }

    @classmethod
    def from_dict(cls, donnees: dict) -> "Intention":
        return cls(
            demande=donnees.get("demande", ""),
            titre=donnees.get("titre", "Application"),
            singulier=donnees.get("singulier", "Élément"),
            pluriel=donnees.get("pluriel", "Éléments"),
            champs=[
                Champ(
                    cle=c["cle"],
                    libelle=c["libelle"],
                    type=c["type"],
                    options=list(c.get("options", [])),
                    requis=bool(c.get("requis", False)),
                    exemples=list(c.get("exemples", [])),
                )
                for c in donnees.get("champs", [])
            ],
            fonctions=set(donnees.get("fonctions", [])),
            confiance=float(donnees.get("confiance", 1.0)),
            cible=donnees.get("cible", "web"),
        )

    @property
    def champ_principal(self) -> Champ:
        """Le champ qui sert de titre a chaque fiche."""
        for champ in self.champs:
            if champ.type in ("texte", "email", "url"):
                return champ
        return self.champs[0]

    def resume(self) -> str:
        lignes = [
            f"Compris : {self.titre}",
            f"  entite    : {self.singulier} / {self.pluriel}",
            "  champs    :",
        ]
        for champ in self.champs:
            details = f" ({', '.join(champ.options)})" if champ.options else ""
            lignes.append(f"      - {champ.libelle} : {champ.type}{details}")
        for note in self.compris[3:]:
            lignes.append(f"  deduit    : {note}")
        lignes.append(f"  fonctions : {', '.join(sorted(self.fonctions))}")
        lignes.append(f"  cible     : {CIBLES_LISIBLES.get(self.cible, self.cible)}")
        lignes.append(f"  confiance : {self.confiance:.0%}")
        if self.ignore:
            lignes.append("  ignore    : " + ", ".join(self.ignore))
        return "\n".join(lignes)


# --------------------------------------------------------------------------- #
# Reperage de l'entite
# --------------------------------------------------------------------------- #
def _trouve_entite(texte: str) -> tuple[str, str, bool]:
    """Renvoie (singulier, pluriel, reconnu_avec_certitude)."""
    plat = normalise(texte)

    for amorce in AMORCES_ENTITE:
        motif = re.compile(rf"\b{re.escape(amorce)}\s+([a-z0-9-]+)")
        trouve = motif.search(plat)
        if not trouve:
            continue
        mot = trouve.group(1)
        if mot in MOTS_VIDES:
            continue
        if mot in ENTITES_CONNUES:
            s, p = ENTITES_CONNUES[mot]
            return s, p, True
        base = singulier(mot)
        return capitalise(base), capitalise(pluriel(base)), True

    # Aucune amorce : un nom connu quelque part dans la phrase fait l'affaire.
    for mot in plat.split():
        if mot in ENTITES_CONNUES:
            s, p = ENTITES_CONNUES[mot]
            return s, p, True

    return "Élément", "Éléments", False


# --------------------------------------------------------------------------- #
# Reperage des champs
# --------------------------------------------------------------------------- #
#: « avec un titre, une priorite et une date » -> la liste des champs.
_AMORCES_CHAMPS = (
    "avec",
    "comportant",
    "contenant",
    "ayant",
    "champs",
    "chaque",
    "avec les champs",
    "possedant",
)

#: Un mot, ou une ponctuation qui separe. L'apostrophe n'est ni l'un ni
#: l'autre : elle disparait, si bien que « d'échéance » devient « d » puis
#: « échéance », et « d » tombe avec les autres determinants.
_JETON = re.compile(r"[^\W_]+|[,;]", re.UNICODE)

#: Ce qui separe deux champs dans une enumeration.
_SEPARATEURS = {"et", "puis", "ainsi", "que", "ou", ",", ";"}


def _libelle_depuis(mots: list[str]) -> str:
    """Construit un libelle lisible en retirant le bruit, accents conserves.

    Les accents comptent : c'est ce libelle que l'utilisateur final verra dans
    son application. On ne normalise que pour comparer, jamais pour afficher.
    """
    utiles = [mot for mot in mots if normalise(mot) not in MOTS_VIDES]
    return " ".join(utiles[:3])


def _trouve_champs(texte: str) -> tuple[list[Champ], list[str]]:
    ignore: list[str] = []

    # On travaille sur le texte d'origine (minuscules, accents gardes) et on
    # ne normalise qu'au moment de comparer.
    mots = [m.group(0) for m in _JETON.finditer(texte.lower())]
    plats = [normalise(m) for m in mots]

    debut = -1
    for i, mot in enumerate(plats):
        if mot in {normalise(a.split()[0]) for a in _AMORCES_CHAMPS}:
            debut = i + 1
            break
    if debut == -1:
        return [], ignore

    champs: list[Champ] = []
    vus: set[str] = set()
    groupe: list[str] = []

    def ajoute(groupe_mots: list[str]) -> bool:
        """Enregistre un champ. Renvoie faux si la liste est pleine."""
        libelle = _libelle_depuis(groupe_mots)
        if not libelle:
            return True
        plat = normalise(libelle)
        # Un fragment qui ne designe qu'une fonction n'est pas un champ.
        if plat in FONCTIONS_PAR_MOT or plat in MOTS_VIDES:
            return True

        cle = identifiant(libelle)
        if cle in vus:
            return True
        vus.add(cle)

        type_champ = type_du_champ(libelle)
        champs.append(
            Champ(
                cle=cle,
                libelle=capitalise(libelle),
                type=type_champ,
                options=options_du_champ(libelle) if type_champ == "choix" else [],
                requis=not champs,  # le premier champ est obligatoire
            )
        )
        if len(champs) >= MAX_CHAMPS:
            ignore.append(f"champs au-delà du {MAX_CHAMPS}e")
            return False
        return True

    for mot, plat in zip(mots[debut:], plats[debut:]):
        # Une demande de fonction termine l'enumeration des champs.
        if plat in FONCTIONS_PAR_MOT and normalise(_libelle_depuis(groupe)) != plat:
            if groupe and not ajoute(groupe):
                return champs, ignore
            groupe = []
            continue
        if plat in _SEPARATEURS:
            if groupe and not ajoute(groupe):
                return champs, ignore
            groupe = []
            continue
        groupe.append(mot)

    if groupe:
        ajoute(groupe)

    return champs, ignore


# --------------------------------------------------------------------------- #
# Reperage des fonctions
# --------------------------------------------------------------------------- #
def _trouve_fonctions(texte: str, champs: list[Champ]) -> set[str]:
    plat = normalise(texte)
    fonctions = set(FONCTIONS_IMPLICITES)

    for mot, fonction in FONCTIONS_PAR_MOT.items():
        if re.search(rf"\b{re.escape(mot)}\b", plat):
            fonctions.add(fonction)

    # Un champ « choix » appelle naturellement un filtre ; un booleen, une case.
    if any(c.type == "choix" for c in champs):
        fonctions.add("filtre")
    if any(c.type == "booleen" for c in champs):
        fonctions.add("cochage")
    if any(c.type in ("date", "nombre") for c in champs):
        fonctions.add("tri")
    return fonctions


def _titre(intention_entite: str, texte: str) -> str:
    plat = normalise(texte)
    for amorce in ("application de gestion de", "gestionnaire de", "gestion de", "liste de", "carnet de"):
        if amorce in plat:
            return f"{capitalise(amorce.split()[0])} de {intention_entite.lower()}"
    return intention_entite


def _champ_du_modele(donnees: dict) -> Champ:
    """Convertit une entree du referentiel en champ."""
    libelle = donnees["libelle"]
    return Champ(
        cle=identifiant(libelle),
        libelle=libelle,
        type=donnees["type"],
        options=list(donnees.get("options", [])),
        exemples=list(donnees.get("exemples", [])),
    )


def _fusionne(modele: list[Champ], dits: list[Champ]) -> list[Champ]:
    """Combine ce que le domaine impose et ce que la phrase demande.

    Le referentiel donne la structure ; la phrase l'emporte partout ou elle
    parle. Un champ nomme dans la phrase et deja prevu par le modele garde sa
    place dans l'ordre — un formulaire ou « Nom » passe derriere « Notes »
    parce que l'utilisateur l'a cite en dernier serait absurde — mais il prend
    le libelle et le type dits, tout en heritant des exemples du modele.
    """
    par_cle = {champ.cle: champ for champ in dits}
    fusion: list[Champ] = []
    places: set[str] = set()

    for champ in modele:
        dit = par_cle.get(champ.cle)
        if dit is None:
            fusion.append(champ)
        else:
            fusion.append(
                Champ(
                    cle=dit.cle,
                    libelle=dit.libelle,
                    type=dit.type,
                    options=list(dit.options or champ.options),
                    exemples=list(champ.exemples),
                )
            )
            places.add(champ.cle)

    # Ce que la phrase ajoute et que le modele ne prevoyait pas vient ensuite.
    ajouts = [champ for champ in dits if champ.cle not in places]
    fusion.extend(ajouts)

    # Si le formulaire deborde, on sacrifie les champs deduits, jamais ceux
    # qui ont ete demandes.
    if len(fusion) > MAX_CHAMPS:
        demandes = {champ.cle for champ in dits}
        garde = [c for c in fusion if c.cle in demandes]
        for champ in fusion:
            if len(garde) >= MAX_CHAMPS:
                break
            if champ.cle not in demandes:
                garde.append(champ)
        fusion = [c for c in fusion if c in garde]

    for indice, champ in enumerate(fusion):
        champ.requis = indice == 0
    return fusion


def analyser(demande: str) -> Intention:
    """Analyse une demande en francais et renvoie la specification comprise."""
    if not demande or not demande.strip():
        raise ValueError("la demande est vide")

    singulier_nom, pluriel_nom, entite_sure = _trouve_entite(demande)
    dits, ignore = _trouve_champs(demande)

    # Le referentiel sait ce que contient une application de ce type. C'est ce
    # qui evite d'avoir a dicter les champs : « un carnet de contacts » suffit.
    modele = modele_pour(pluriel_nom, singulier_nom)
    a_la_lettre = restreint(demande)
    deduits = 0
    depuis: str | None = None

    if modele is not None and not (dits and a_la_lettre):
        champs_modele = [_champ_du_modele(d) for d in modele["champs"]]
        champs = _fusionne(champs_modele, dits)
        deduits = sum(1 for c in champs if c.cle not in {d.cle for d in dits})
        depuis = modele["source"]
    elif dits:
        champs = dits
        for indice, champ in enumerate(champs):
            champ.requis = indice == 0
    else:
        # Domaine inconnu et rien de nomme : un socle utilisable plutot que rien.
        champs = [
            Champ(cle="titre", libelle="Titre", type="texte", requis=True),
            Champ(
                cle="statut",
                libelle="Statut",
                type="choix",
                options=options_du_champ("statut"),
            ),
            Champ(cle="notes", libelle="Notes", type="texte_long"),
        ]
        ignore.append("domaine inconnu et aucun champ nomme : socle titre/statut/notes")

    fonctions = _trouve_fonctions(demande, champs)
    if modele is not None and not (dits and a_la_lettre):
        # Une phrase restrictive vaut aussi pour les fonctions : on ne fait pas
        # entrer par la fenetre ce qu'elle a mis dehors.
        fonctions |= set(modele["fonctions"])

    # La confiance dit a l'utilisateur a quel point la phrase a ete comprise,
    # au lieu de laisser croire a une certitude qui n'existe pas.
    confiance = 0.35
    if entite_sure:
        confiance += 0.3
    if modele is not None or dits:
        confiance += 0.25
    if len(fonctions) > len(FONCTIONS_IMPLICITES):
        confiance += 0.1

    compris = [f"entite : {pluriel_nom}", f"{len(champs)} champ(s)", f"{len(fonctions)} fonction(s)"]
    if deduits and depuis:
        compris.append(f"{deduits} champ(s) deduit(s) de ce que font {depuis}")
    if dits and a_la_lettre:
        compris.append("phrase restrictive : rien n'a ete ajoute")

    return Intention(
        demande=demande.strip(),
        titre=_titre(pluriel_nom, demande),
        singulier=singulier_nom,
        pluriel=pluriel_nom,
        champs=champs,
        fonctions=fonctions,
        cible=cible_demandee(demande),
        compris=compris,
        ignore=ignore,
        confiance=min(1.0, confiance),
    )
