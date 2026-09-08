"""Pont vers le moteur d'applications, qui vit en JavaScript.

Même principe que `site.py` : `web/moteur-app.js` est l'unique implémentation
navigateur du compilateur d'intentions. Elle tourne dans la page publique, et
ici sous Node — donc ce que voit un visiteur et ce que testent les tests sont
littéralement le même code.

Le compilateur Python (`generation.py`) reste, lui, la référence : les tests de
parité comparent les deux analyses champ par champ.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

RACINE = Path(__file__).resolve().parents[2]
MOTEUR = RACINE / "web" / "moteur-app.js"


class MoteurIndisponible(RuntimeError):
    pass


def _executer(programme: str) -> dict:
    if shutil.which("node") is None:
        raise MoteurIndisponible(
            "Node.js est requis pour le moteur d'applications. "
            "Installez-le, ou utilisez la page web."
        )
    if not MOTEUR.exists():
        raise MoteurIndisponible(f"moteur introuvable : {MOTEUR}")

    resultat = subprocess.run(
        ["node", "-e", programme], capture_output=True, text=True, timeout=120
    )
    if resultat.returncode != 0:
        raise MoteurIndisponible(resultat.stderr.strip()[:600] or "le moteur a échoué")
    return json.loads(resultat.stdout)


def construire(demande: str) -> tuple[dict, dict[str, str]]:
    """Analyse la demande et renvoie (spécification, fichiers de l'application)."""
    programme = (
        f"const M = require({json.dumps(str(MOTEUR))});"
        f"const s = M.analyser({json.dumps(demande)});"
        "process.stdout.write(JSON.stringify({spec: s, fichiers: M.generer(s)}));"
    )
    charge = _executer(programme)
    return charge["spec"], charge["fichiers"]


def ecrire(demande: str, sortie: str | Path) -> tuple[dict, list[str]]:
    """Écrit l'application sur le disque. Renvoie (spécification, chemins écrits)."""
    spec, fichiers = construire(demande)
    racine = Path(sortie)
    for chemin, contenu in fichiers.items():
        cible = racine / chemin
        cible.parent.mkdir(parents=True, exist_ok=True)
        cible.write_text(contenu, encoding="utf-8")
    return spec, sorted(fichiers)


def resume(spec: dict) -> str:
    """Fiche lisible de ce que le moteur a compris."""
    lignes = [f"Compris : {spec['titre']}", f"  objet     : {spec['singulier']}"]
    for champ in spec["champs"]:
        lignes.append(f"  champ     : {champ['libelle']} ({champ['type']})")
    lignes.append(f"  fonctions : {', '.join(spec['fonctions'])}")
    return "\n".join(lignes)
