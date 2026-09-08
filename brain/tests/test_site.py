"""Tests du moteur de sites : aucune IA, aucun réseau, tout déterministe."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from brain.intent.site import MOTEUR, construire, ecrire, resume

NODE = shutil.which("node")


@unittest.skipUnless(NODE, "Node.js absent")
class TestMoteurSite(unittest.TestCase):
    def test_reconnait_les_metiers(self) -> None:
        cas = {
            "Un site pour mon restaurant": "Restaurant",
            "Site pour une photographe de mariage": "Photographe",
            "Site de mon salon de coiffure": "Salon de coiffure",
            "Un site pour mon association de quartier": "Association",
            "Site pour un garage automobile": "Garage",
            "Site pour un gîte à la montagne": "Hébergement",
            "Site pour mon cabinet d'avocat": "Cabinet",
            "Un site pour ma boutique de fleurs": "Boutique",
        }
        for phrase, attendu in cas.items():
            spec, _ = construire(phrase)
            self.assertEqual(spec["metierNom"], attendu, phrase)

    def test_metier_inconnu_reste_coherent(self) -> None:
        spec, fichiers = construire("Un site pour mon activité de dresseur de fougères")
        self.assertEqual(spec["metierNom"], "Activité")
        self.assertIn("index.html", fichiers)
        self.assertGreater(len(fichiers["index.html"]), 2000)

    def test_nom_ville_et_ambiance(self) -> None:
        spec, _ = construire(
            "Un site chaleureux pour mon restaurant Le Tilleul à Annecy avec les horaires"
        )
        self.assertEqual(spec["nom"], "Le Tilleul")
        self.assertEqual(spec["ville"], "Annecy")
        self.assertEqual(spec["ambiance"], "chaleureux")

    def test_les_sections_demandees_s_ajoutent(self) -> None:
        base, _ = construire("Un site pour mon restaurant")
        enrichi, _ = construire("Un site pour mon restaurant avec une FAQ et une newsletter")
        self.assertIn("faq", enrichi["sections"])
        self.assertIn("newsletter", enrichi["sections"])
        # Elles s'ajoutent, elles ne remplacent pas.
        for section in base["sections"]:
            self.assertIn(section, enrichi["sections"])

    def test_contact_toujours_present(self) -> None:
        for phrase in ("Un site pour mon garage", "Site vitrine pour une école"):
            spec, _ = construire(phrase)
            self.assertIn("contact", spec["sections"])

    def test_deterministe(self) -> None:
        phrase = "Un site élégant pour une photographe à Bordeaux avec galerie et tarifs"
        a, b = construire(phrase), construire(phrase)
        self.assertEqual(a[1], b[1], "la même phrase doit donner exactement le même site")

    def test_demande_trop_courte_refusee(self) -> None:
        with self.assertRaises(Exception):
            construire("a")

    def test_aucune_ressource_distante(self) -> None:
        """Un site autonome ne doit charger ni police, ni script, ni image externe."""
        _, fichiers = construire("Un site pour mon restaurant avec galerie et tarifs")
        html = fichiers["index.html"]
        for interdit in ("http://", "https://", "//fonts.", "cdn."):
            self.assertNotIn(interdit, html, f"ressource distante trouvée : {interdit}")
        self.assertIn("<svg", fichiers["index.html"] + fichiers["styles.css"])

    def test_fichiers_attendus(self) -> None:
        _, fichiers = construire("Un site pour mon association")
        for attendu in ("index.html", "styles.css", "script.js", "README.md", "robots.txt", "sitemap.xml"):
            self.assertIn(attendu, fichiers)
            self.assertTrue(fichiers[attendu].strip())

    def test_html_bien_forme(self) -> None:
        _, fichiers = construire("Un site pour mon restaurant avec galerie, tarifs et FAQ")
        html = fichiers["index.html"]
        self.assertTrue(html.startswith("<!doctype html>"))
        self.assertEqual(html.count("<html"), 1)
        self.assertEqual(html.count("</html>"), 1)
        # Autant de sections ouvertes que fermées.
        self.assertEqual(html.count("<section"), html.count("</section>"))
        self.assertIn('lang="fr"', html)
        self.assertIn('name="viewport"', html)

    def test_javascript_valide(self) -> None:
        with tempfile.TemporaryDirectory() as dossier:
            _, fichiers = construire("Un site pour mon restaurant avec une newsletter")
            chemin = Path(dossier) / "script.js"
            chemin.write_text(fichiers["script.js"], encoding="utf-8")
            resultat = subprocess.run(
                ["node", "--check", "script.js"], cwd=dossier, capture_output=True, text=True, timeout=60
            )
            self.assertEqual(resultat.returncode, 0, resultat.stderr)

    def test_le_moteur_lui_meme_est_valide(self) -> None:
        resultat = subprocess.run(
            ["node", "--check", str(MOTEUR)], capture_output=True, text=True, timeout=60
        )
        self.assertEqual(resultat.returncode, 0, resultat.stderr)

    def test_ecriture_sur_disque(self) -> None:
        with tempfile.TemporaryDirectory() as dossier:
            spec, chemins = ecrire("Un site pour ma boulangerie à Lyon", dossier)
            self.assertIn("index.html", chemins)
            self.assertTrue((Path(dossier) / "index.html").exists())
            garde = json.loads((Path(dossier) / ".forge-site.json").read_text(encoding="utf-8"))
            self.assertEqual(garde["nom"], spec["nom"])
            self.assertIn("Compris", resume(spec))

    def test_toutes_les_sections_se_generent(self) -> None:
        """Chaque bloc doit produire du HTML : aucun trou dans le catalogue."""
        programme = (
            f"const M = require({json.dumps(str(MOTEUR))});"
            "const noms = Object.keys(M.SECTIONS);"
            "const spec = M.analyser('Un site pour mon restaurant');"
            "spec.sections = noms;"
            "const f = M.generer(spec);"
            "const manquantes = noms.filter((n) => !f['index.html'].includes('id=\"' + n + '\"'));"
            "process.stdout.write(JSON.stringify({manquantes, taille: f['index.html'].length}));"
        )
        resultat = subprocess.run(["node", "-e", programme], capture_output=True, text=True, timeout=60)
        self.assertEqual(resultat.returncode, 0, resultat.stderr)
        charge = json.loads(resultat.stdout)
        self.assertEqual(charge["manquantes"], [], "sections sans bloc de génération")


if __name__ == "__main__":
    unittest.main(verbosity=2)
