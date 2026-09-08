"""Pont vers le moteur de sites, qui vit en JavaScript.

Le moteur (`web/moteur.js`) est l'unique implementation : il tourne dans le
navigateur pour la page publique, et ici sous Node. Une seule source, donc
aucune divergence possible entre les deux.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

MOTEUR = Path(__file__).resolve().parents[2] / "web" / "moteur.js"


class MoteurIndisponible(RuntimeError):
    pass


def _executer(programme: str) -> dict:
    if shutil.which("node") is None:
        raise MoteurIndisponible(
            "Node.js est requis pour le moteur de sites. Installez-le, ou utilisez la page web."
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
    """Analyse la demande et renvoie (specification, fichiers du site)."""
    programme = (
        f"const M = require({json.dumps(str(MOTEUR))});"
        f"const s = M.analyser({json.dumps(demande)});"
        "process.stdout.write(JSON.stringify({spec: s, fichiers: M.generer(s)}));"
    )
    charge = _executer(programme)
    return charge["spec"], charge["fichiers"]


def ecrire(demande: str, sortie: str | Path) -> tuple[dict, list[str]]:
    """Ecrit le site sur le disque. Renvoie (specification, chemins ecrits)."""
    spec, fichiers = construire(demande)
    racine = Path(sortie)
    for chemin, contenu in fichiers.items():
        cible = racine / chemin
        cible.parent.mkdir(parents=True, exist_ok=True)
        cible.write_text(contenu, encoding="utf-8")
    return spec, sorted(fichiers)


def resume(spec: dict) -> str:
    """Fiche lisible de ce que le moteur a compris."""
    lignes = [
        f"Compris : {spec['nom']}",
        f"  activité  : {spec['metierNom']}",
        f"  ambiance  : {spec['ambiance']}",
    ]
    if spec.get("ville"):
        lignes.append(f"  ville     : {spec['ville']}")
    lignes.append(f"  sections  : {', '.join(spec['sections'])}")
    lignes.append(f"  confiance : {spec['confiance']:.0%}")
    return "\n".join(lignes)
