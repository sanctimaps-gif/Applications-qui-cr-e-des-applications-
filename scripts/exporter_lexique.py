"""Exporte le lexique Python vers un fichier JavaScript.

Le vocabulaire est defini une seule fois, en Python (`brain/intent/lexique.py`).
Ce script en derive `web/lexique.js`, que le moteur du navigateur consomme.
Un test verifie que le fichier commite correspond bien a l'export courant :
sans cela, les deux cotes divergeraient en silence.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))

from brain.intent import lexique as L  # noqa: E402
from brain.intent import referentiel as R  # noqa: E402
from brain.intent.analyse import MAX_CHAMPS  # noqa: E402


def contenu() -> str:
    donnees = {
        "typesParMot": L.TYPES_PAR_MOT,
        "optionsParChamp": L.OPTIONS_PAR_CHAMP,
        "fonctionsParMot": L.FONCTIONS_PAR_MOT,
        "fonctionsImplicites": sorted(L.FONCTIONS_IMPLICITES),
        "amorcesEntite": L.AMORCES_ENTITE,
        "entitesConnues": {k: list(v) for k, v in L.ENTITES_CONNUES.items()},
        "motsVides": sorted(L.MOTS_VIDES),
        # Ce que contiennent reellement les applications de chaque domaine :
        # c'est ce qui evite d'avoir a dicter la liste des champs.
        "modeles": R.MODELES,
        "restrictifs": list(R.RESTRICTIFS),
        "maxChamps": MAX_CHAMPS,
    }
    return (
        "/* Fichier genere par scripts/exporter_lexique.py — ne pas modifier a la main.\n"
        "   Le vocabulaire est defini dans brain/intent/lexique.py, et exporte ici pour\n"
        "   que le navigateur et la ligne de commande partagent exactement le meme. */\n"
        "(function (racine) {\n"
        "  'use strict';\n"
        "  var LEXIQUE = "
        + json.dumps(donnees, ensure_ascii=False, indent=2, sort_keys=True)
        + ";\n"
        "  if (typeof module !== 'undefined' && module.exports) module.exports = LEXIQUE;\n"
        "  else racine.LEXIQUE = LEXIQUE;\n"
        "})(typeof globalThis !== 'undefined' ? globalThis : this);\n"
    )


def main() -> int:
    cible = RACINE / "web" / "lexique.js"
    cible.parent.mkdir(parents=True, exist_ok=True)
    cible.write_text(contenu(), encoding="utf-8")
    print(f"ecrit : {cible} ({cible.stat().st_size:,} o)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
