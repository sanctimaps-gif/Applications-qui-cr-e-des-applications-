"""Tests du compilateur d'intention : francais -> code.

Le test decisif ne verifie pas que le code « ressemble » a du JavaScript : il
l'execute avec Node et fait tourner les tests que le generateur a ecrits.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from brain.intent import analyser, generer
from brain.intent.lexique import normalise, pluriel, singulier, type_du_champ


class TestComprehension(unittest.TestCase):
    def test_repere_l_entite(self) -> None:
        cas = {
            "Une application de gestion de tâches": ("Tâche", "Tâches"),
            "Un gestionnaire de contacts": ("Contact", "Contacts"),
            "Une liste de courses": ("Article", "Courses"),
            "Un carnet de recettes": ("Recette", "Recettes"),
            "Un catalogue de films avec un titre": ("Film", "Films"),
        }
        for phrase, (sing, plur) in cas.items():
            intention = analyser(phrase)
            self.assertEqual((intention.singulier, intention.pluriel), (sing, plur), phrase)

    def test_entite_inconnue_est_flechie(self) -> None:
        # Un mot absent du lexique doit quand meme donner un singulier/pluriel.
        intention = analyser("Une application de gestion de vignobles avec un nom")
        self.assertEqual(intention.singulier, "Vignoble")
        self.assertEqual(intention.pluriel, "Vignobles")

    def test_repere_les_champs_et_leurs_types(self) -> None:
        intention = analyser(
            "Une liste de tâches avec un titre, une priorité, une date d'échéance, "
            "un prix, une description et une case terminé"
        )
        types = {c.libelle: c.type for c in intention.champs}
        self.assertEqual(types.get("Titre"), "texte")
        self.assertEqual(types.get("Priorité"), "choix")
        self.assertEqual(types.get("Date échéance"), "date")
        self.assertEqual(types.get("Prix"), "nombre")
        self.assertEqual(types.get("Description"), "texte_long")
        self.assertEqual(types.get("Terminé"), "booleen")

    def test_les_accents_survivent(self) -> None:
        """Les libelles sont montres a l'utilisateur : ils gardent leurs accents."""
        intention = analyser("Une liste de tâches avec une priorité et une échéance")
        libelles = [c.libelle for c in intention.champs]
        self.assertIn("Priorité", libelles)
        self.assertTrue(any("échéance" in l.lower() for l in libelles))

    def test_champ_choix_recoit_des_options(self) -> None:
        intention = analyser("Une liste de tâches avec un titre et une priorité")
        priorite = next(c for c in intention.champs if c.cle == "priorite")
        self.assertEqual(priorite.options, ["Basse", "Moyenne", "Haute", "Urgente"])

    def test_repere_les_fonctions_demandees(self) -> None:
        intention = analyser(
            "Une liste de livres avec un titre, avec recherche, tri et export CSV"
        )
        for fonction in ("recherche", "tri", "export"):
            self.assertIn(fonction, intention.fonctions)

    def test_fonctions_deduites_des_champs(self) -> None:
        # Un champ « choix » implique un filtre, un booleen implique une case.
        intention = analyser("Une liste de tâches avec un titre, un statut et une case faite")
        self.assertIn("filtre", intention.fonctions)
        self.assertIn("cochage", intention.fonctions)

    def test_sans_champ_un_socle_est_pose(self) -> None:
        intention = analyser("Une application de gestion de projets")
        self.assertGreaterEqual(len(intention.champs), 3)
        self.assertTrue(any("aucun champ nommé" in i or "aucun champ nomme" in i for i in intention.ignore))
        self.assertLess(intention.confiance, 1.0, "la confiance doit refleter l'incertitude")

    def test_la_confiance_est_honnete(self) -> None:
        precise = analyser("Une liste de tâches avec un titre, une priorité et une échéance, avec recherche")
        vague = analyser("Je veux un truc")
        self.assertGreater(precise.confiance, vague.confiance)
        self.assertGreaterEqual(precise.confiance, 0.9)

    def test_demande_vide_refusee(self) -> None:
        with self.assertRaises(ValueError):
            analyser("   ")

    def test_le_resume_est_lisible(self) -> None:
        resume = analyser("Une liste de tâches avec un titre et une priorité").resume()
        self.assertIn("Titre", resume)
        self.assertIn("confiance", resume)

    def test_deterministe(self) -> None:
        phrase = "Une liste de dépenses avec un montant, une catégorie et une date"
        a, b = generer(analyser(phrase)), generer(analyser(phrase))
        self.assertEqual(a, b, "la meme phrase doit donner exactement le meme code")


class TestLexique(unittest.TestCase):
    def test_normalisation(self) -> None:
        self.assertEqual(normalise("  Priorité   Haute "), "priorite haute")

    def test_flexion(self) -> None:
        self.assertEqual(pluriel("tâche"), "tâches")
        self.assertEqual(pluriel("journal"), "journaux")
        self.assertEqual(pluriel("prix"), "prix")
        self.assertEqual(singulier("tâches"), "tâche")
        self.assertEqual(singulier("journaux"), "journal")

    def test_types_par_mot_compose(self) -> None:
        self.assertEqual(type_du_champ("date de livraison"), "date")
        self.assertEqual(type_du_champ("prix unitaire"), "nombre")
        self.assertEqual(type_du_champ("machin inconnu"), "texte")


class TestGeneration(unittest.TestCase):
    def test_fichiers_attendus(self) -> None:
        fichiers = generer(analyser("Une liste de tâches avec un titre"))
        for attendu in ("index.html", "styles.css", "store.js", "ui.js", "test/store.test.js", "package.json", "README.md"):
            self.assertIn(attendu, fichiers)
            self.assertTrue(fichiers[attendu].strip(), f"{attendu} est vide")

    def test_package_json_valide(self) -> None:
        fichiers = generer(analyser("Une liste de tâches avec un titre"))
        json.loads(fichiers["package.json"])  # leve si invalide

    def test_pas_de_module_es_dans_le_html(self) -> None:
        """Un navigateur refuse les modules ES en file:// : double-clic casse."""
        html = generer(analyser("Une liste de tâches avec un titre"))["index.html"]
        self.assertNotIn('type="module"', html)
        self.assertIn('<script src="store.js"></script>', html)

    def test_le_libelle_avec_apostrophe_est_conserve(self) -> None:
        fichiers = generer(analyser("Une liste de tâches avec un titre et une date d'échéance"))
        self.assertIn("échéance", fichiers["store.js"])


@unittest.skipUnless(shutil.which("node"), "Node.js absent")
class TestCodeExecutable(unittest.TestCase):
    """Le test qui compte : le code genere s'execute et ses tests passent."""

    def _genere_et_teste(self, phrase: str) -> str:
        with tempfile.TemporaryDirectory() as dossier:
            racine = Path(dossier)
            for chemin, contenu in generer(analyser(phrase)).items():
                cible = racine / chemin
                cible.parent.mkdir(parents=True, exist_ok=True)
                cible.write_text(contenu, encoding="utf-8")

            resultat = subprocess.run(
                ["node", "--test", "test/store.test.js"],
                cwd=racine,
                capture_output=True,
                text=True,
                timeout=120,
            )
            self.assertEqual(
                resultat.returncode,
                0,
                f"les tests generes echouent pour « {phrase} » :\n{resultat.stdout[-2500:]}",
            )
            return resultat.stdout

    def test_taches(self) -> None:
        sortie = self._genere_et_teste(
            "Une application de gestion de tâches avec un titre, une priorité, "
            "une date d'échéance et une case terminé, avec recherche et export CSV"
        )
        self.assertIn("# fail 0", sortie)

    def test_depenses(self) -> None:
        self._genere_et_teste(
            "Un suivi de dépenses avec un libellé, un montant, une catégorie et une date"
        )

    def test_contacts(self) -> None:
        self._genere_et_teste(
            "Un carnet de contacts avec un nom, un email, un téléphone et des notes"
        )

    def test_sans_champ_explicite(self) -> None:
        # Meme le socle par defaut doit produire une application qui tourne.
        self._genere_et_teste("Une application de gestion de projets")

    def test_apostrophe_ne_casse_pas_le_code(self) -> None:
        """« Date d'échéance » a deja casse le JavaScript genere : plus jamais.

        Seul l'analyseur de Node tranche : une heuristique sur les quotes se
        trompe des qu'un commentaire contient « c'est ».
        """
        with tempfile.TemporaryDirectory() as dossier:
            racine = Path(dossier)
            phrases = [
                "Une liste de tâches avec un titre et une date d'échéance",
                "Un suivi d'affaires avec un nom, un chiffre d'affaires et une date",
            ]
            for phrase in phrases:
                for nom, contenu in generer(analyser(phrase)).items():
                    if not nom.endswith(".js"):
                        continue
                    fichier = racine / Path(nom).name
                    fichier.write_text(contenu, encoding="utf-8")
                    resultat = subprocess.run(
                        ["node", "--check", fichier.name],
                        cwd=racine,
                        capture_output=True,
                        text=True,
                        timeout=60,
                    )
                    self.assertEqual(
                        resultat.returncode, 0, f"{nom} invalide pour « {phrase} » :\n{resultat.stderr}"
                    )

    def test_le_script_npm_test_declare_fonctionne(self) -> None:
        """Le README dit « npm test » : la commande declaree doit marcher.

        Elle ne marchait pas : `node --test test/` fait interpreter le dossier
        comme un module sur certaines versions de Node.
        """
        with tempfile.TemporaryDirectory() as dossier:
            racine = Path(dossier)
            for chemin, contenu in generer(analyser("Une liste de tâches avec un titre")).items():
                cible = racine / chemin
                cible.parent.mkdir(parents=True, exist_ok=True)
                cible.write_text(contenu, encoding="utf-8")

            script = json.loads((racine / "package.json").read_text(encoding="utf-8"))["scripts"]["test"]
            resultat = subprocess.run(
                script, cwd=racine, shell=True, capture_output=True, text=True, timeout=120
            )
            self.assertEqual(
                resultat.returncode,
                0,
                f"« {script} » echoue :\n{resultat.stdout[-1500:]}{resultat.stderr[-800:]}",
            )

    def test_le_javascript_est_syntaxiquement_valide(self) -> None:
        with tempfile.TemporaryDirectory() as dossier:
            racine = Path(dossier)
            fichiers = generer(
                analyser("Une liste de recettes avec un nom, une durée et une difficulté")
            )
            for nom in ("store.js", "ui.js"):
                (racine / nom).write_text(fichiers[nom], encoding="utf-8")
                resultat = subprocess.run(
                    ["node", "--check", nom], cwd=racine, capture_output=True, text=True, timeout=60
                )
                self.assertEqual(resultat.returncode, 0, f"{nom} invalide :\n{resultat.stderr}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
