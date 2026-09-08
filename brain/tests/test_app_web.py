"""Tests du moteur d'applications du navigateur (`web/moteur-app.js`).

Trois garanties, et ce sont les trois qui comptent :

1. l'application produite est une vraie application — ses propres tests
   s'exécutent réellement sous Node et passent ;
2. le moteur JavaScript comprend une phrase exactement comme le compilateur
   Python : mêmes champs, mêmes types, mêmes fonctions ;
3. `web/lexique.js` est bien l'export courant de `brain/intent/lexique.py`,
   sinon les deux vocabulaires divergeraient en silence.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from brain.intent import analyse
from brain.intent.app_web import MOTEUR, construire, ecrire, resume

RACINE = Path(__file__).resolve().parents[2]
NODE = shutil.which("node")

#: Les phrases servent aux deux moteurs : toute divergence se voit ici.
PHRASES = [
    "Une application de gestion de tâches avec un titre, une priorité, "
    "une date d'échéance et une case terminé",
    "Un carnet de contacts avec nom, email, téléphone et une note",
    "Une application de gestion de recettes avec un nom, un temps de cuisson "
    "et une description",
    "Un suivi de dépenses avec un libellé, un montant, une date et une catégorie",
    "Une liste de livres avec titre, auteur, nombre de pages et une case lu",
]


@unittest.skipUnless(NODE, "Node.js absent")
class TestMoteurApplication(unittest.TestCase):
    def test_les_fichiers_attendus_sont_la(self) -> None:
        _, fichiers = construire(PHRASES[0])
        for attendu in (
            "index.html",
            "styles.css",
            "store.js",
            "ui.js",
            "test/store.test.js",
            "package.json",
            "README.md",
            ".forge-intent.json",
        ):
            self.assertIn(attendu, fichiers)

    def test_la_logique_est_separee_de_l_affichage(self) -> None:
        """`store.js` ne doit toucher à aucun élément du DOM : c'est ce qui
        rend l'application testable, et ce qui en fait une application plutôt
        qu'une maquette."""
        _, fichiers = construire(PHRASES[0])
        for interdit in ("document.", "window.", "querySelector"):
            self.assertNotIn(interdit, fichiers["store.js"])

    def test_le_javascript_produit_est_valide(self) -> None:
        with tempfile.TemporaryDirectory() as dossier:
            for phrase in PHRASES:
                _, fichiers = construire(phrase)
                for nom in ("store.js", "ui.js"):
                    chemin = Path(dossier) / "v.js"
                    chemin.write_text(fichiers[nom], encoding="utf-8")
                    verdict = subprocess.run(
                        ["node", "--check", str(chemin)], capture_output=True, text=True
                    )
                    self.assertEqual(verdict.returncode, 0, f"{phrase} / {nom}\n{verdict.stderr}")

    def test_les_tests_de_l_application_passent(self) -> None:
        """La preuve : on lance le `npm test` déclaré par l'application."""
        with tempfile.TemporaryDirectory() as dossier:
            spec, _ = ecrire(PHRASES[0], dossier)
            script = json.loads(
                (Path(dossier) / "package.json").read_text(encoding="utf-8")
            )["scripts"]["test"]
            verdict = subprocess.run(
                script.split(), cwd=dossier, capture_output=True, text=True, timeout=180
            )
            self.assertEqual(verdict.returncode, 0, verdict.stdout + verdict.stderr)
            self.assertIn("# fail 0", verdict.stdout)
            self.assertEqual(spec["singulier"], "Tâche")

    def test_les_tests_passent_pour_chaque_phrase(self) -> None:
        for phrase in PHRASES[1:]:
            with tempfile.TemporaryDirectory() as dossier:
                ecrire(phrase, dossier)
                verdict = subprocess.run(
                    ["node", "--test", "test/store.test.js"],
                    cwd=dossier,
                    capture_output=True,
                    text=True,
                    timeout=180,
                )
                self.assertEqual(verdict.returncode, 0, phrase + "\n" + verdict.stdout)

    def test_l_interface_ne_redessine_pas_pendant_un_clic(self) -> None:
        """Régression : un écouteur « change » sur la zone de recherche se
        déclenche à la perte du focus. Cliquer « Modifier » redessinait alors
        la liste entre le mousedown et le mouseup, le bouton disparaissait
        sous la souris, et la modification devenait un ajout."""
        _, fichiers = construire(PHRASES[0])
        self.assertNotIn("addEventListener('change', afficher)", fichiers["ui.js"])
        self.assertIn("tagName === 'SELECT'", fichiers["ui.js"])

    def test_l_acces_a_localstorage_est_protege(self) -> None:
        """Dans un cadre isolé, le simple *accès* à localStorage lève."""
        _, fichiers = construire(PHRASES[0])
        self.assertIn("function stockageDisponible()", fichiers["ui.js"])

    def test_la_specification_est_conservee(self) -> None:
        spec, fichiers = construire(PHRASES[0])
        garde = json.loads(fichiers[".forge-intent.json"])
        self.assertEqual(garde["champs"], spec["champs"])
        self.assertEqual(garde["demande"], PHRASES[0])

    def test_resume_lisible(self) -> None:
        spec, _ = construire(PHRASES[0])
        texte = resume(spec)
        self.assertIn("Tâche", texte)
        self.assertIn("Titre", texte)


@unittest.skipUnless(NODE, "Node.js absent")
class TestParitePythonJavaScript(unittest.TestCase):
    """Les deux compilateurs doivent comprendre la même chose."""

    def test_memes_champs_memes_types(self) -> None:
        for phrase in PHRASES:
            js, _ = construire(phrase)
            py = analyse.analyser(phrase)

            self.assertEqual(
                [(c["cle"], c["type"]) for c in js["champs"]],
                [(c.cle, c.type) for c in py.champs],
                phrase,
            )
            self.assertEqual(
                [c["libelle"] for c in js["champs"]],
                [c.libelle for c in py.champs],
                phrase,
            )

    def test_memes_fonctions(self) -> None:
        for phrase in PHRASES:
            js, _ = construire(phrase)
            py = analyse.analyser(phrase)
            self.assertEqual(sorted(js["fonctions"]), sorted(py.fonctions), phrase)

    def test_meme_entite(self) -> None:
        for phrase in PHRASES:
            js, _ = construire(phrase)
            py = analyse.analyser(phrase)
            self.assertEqual(
                (js["singulier"], js["pluriel"]), (py.singulier, py.pluriel), phrase
            )

    def test_memes_options_de_choix(self) -> None:
        js, _ = construire(PHRASES[0])
        py = analyse.analyser(PHRASES[0])
        options_js = {c["cle"]: c.get("options", []) for c in js["champs"]}
        options_py = {c.cle: c.options for c in py.champs}
        self.assertEqual(options_js, options_py)


class TestLexiquePartage(unittest.TestCase):
    def test_le_fichier_js_est_l_export_courant(self) -> None:
        """Sans ce test, Python et le navigateur divergeraient en silence."""
        sys.path.insert(0, str(RACINE))
        from scripts.exporter_lexique import contenu  # noqa: PLC0415

        publie = (RACINE / "web" / "lexique.js").read_text(encoding="utf-8")
        self.assertEqual(
            publie,
            contenu(),
            "web/lexique.js est périmé : relancez « python3 scripts/exporter_lexique.py »",
        )

    def test_le_moteur_existe(self) -> None:
        self.assertTrue(MOTEUR.exists(), MOTEUR)


if __name__ == "__main__":
    unittest.main()
