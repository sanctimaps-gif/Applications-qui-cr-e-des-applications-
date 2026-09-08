"""Tests de l'atelier : la boucle d'agent, sans aucun modele."""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from brain.agent import Atelier, Incomprise, interpreter
from brain.intent.generation import SPEC


class TestInterpretation(unittest.TestCase):
    def test_operations_reconnues(self) -> None:
        cas = {
            "crée une application de gestion de tâches": "creer",
            "ajoute un champ prix": "ajouter_champ",
            "ajoute une date de livraison": "ajouter_champ",
            "supprime le champ notes": "retirer_champ",
            "retire la priorité": "retirer_champ",
            "ajoute la recherche": "ajouter_fonction",
            "supprime le tri": "retirer_fonction",
            "renomme titre en nom": "renommer_champ",
            "renomme l'application en Suivi client": "titre",
            "teste": "tester",
            "liste": "lister",
            "décris": "decrire",
            "montre store.js": "montrer",
            "annule": "annuler",
            "historique": "historique",
            "aide": "aide",
            "quitte": "quitter",
        }
        for phrase, attendu in cas.items():
            self.assertEqual(interpreter(phrase).nom, attendu, phrase)

    def test_arguments_extraits(self) -> None:
        self.assertEqual(interpreter("ajoute un champ prix").arguments["nom"], "prix")
        self.assertEqual(
            interpreter("ajoute un champ date de livraison").arguments["nom"], "date livraison"
        )
        self.assertEqual(interpreter("ajoute l'export CSV").arguments["fonction"], "export")
        renommage = interpreter("renomme titre en nom").arguments
        self.assertEqual((renommage["ancien"], renommage["nouveau"]), ("titre", "nom"))
        self.assertEqual(interpreter("montre ui.js").arguments["fichier"], "ui.js")

    def test_instruction_incomprise_propose_des_pistes(self) -> None:
        with self.assertRaises(Incomprise) as capture:
            interpreter("fais-moi un café")
        self.assertTrue(capture.exception.pistes, "une instruction refusee doit guider")

    def test_phrase_descriptive_vaut_creation(self) -> None:
        self.assertEqual(interpreter("une liste de recettes avec un nom").nom, "creer")


class TestAtelier(unittest.TestCase):
    def setUp(self) -> None:
        self.dossier = tempfile.mkdtemp()
        self.atelier = Atelier(self.dossier)

    def tearDown(self) -> None:
        shutil.rmtree(self.dossier, ignore_errors=True)

    def _faire(self, phrase: str):
        return self.atelier.executer(interpreter(phrase))

    def test_cycle_complet(self) -> None:
        creation = self._faire("crée une application de gestion de tâches avec un titre et une priorité")
        self.assertFalse(creation.echec)
        self.assertTrue((Path(self.dossier) / "store.js").exists())
        self.assertTrue((Path(self.dossier) / SPEC).exists())

        ajout = self._faire("ajoute un champ prix")
        self.assertFalse(ajout.echec)
        self.assertIn("prix", (Path(self.dossier) / "store.js").read_text(encoding="utf-8"))
        self.assertTrue(ajout.detail, "une modification doit montrer un diff")

        retrait = self._faire("supprime le champ prix")
        self.assertFalse(retrait.echec)
        self.assertNotIn("prix:", (Path(self.dossier) / "store.js").read_text(encoding="utf-8"))

    def test_la_specification_survit_au_rechargement(self) -> None:
        self._faire("crée une liste de tâches avec un titre et une priorité")
        self._faire("ajoute un champ échéance")

        # Un nouvel atelier sur le meme dossier retrouve l'etat exact.
        rouvert = Atelier(self.dossier)
        self.assertIsNotNone(rouvert.intention)
        libelles = [c.libelle for c in rouvert.intention.champs]
        self.assertIn("Échéance", libelles)

    def test_annulation(self) -> None:
        self._faire("crée une liste de tâches avec un titre")
        avant = (Path(self.dossier) / "store.js").read_text(encoding="utf-8")

        self._faire("ajoute un champ prix")
        self.assertNotEqual((Path(self.dossier) / "store.js").read_text(encoding="utf-8"), avant)

        annulation = self._faire("annule")
        self.assertFalse(annulation.echec)
        self.assertEqual((Path(self.dossier) / "store.js").read_text(encoding="utf-8"), avant)
        self.assertNotIn("prix", [c.cle for c in self.atelier.intention.champs])

    def test_annulation_sans_rien_a_annuler(self) -> None:
        self.assertTrue(self._faire("annule").echec)

    def test_refus_des_operations_impossibles(self) -> None:
        self._faire("crée une liste de tâches avec un titre")
        self.assertTrue(self._faire("supprime le champ titre").echec, "dernier champ")
        self.assertTrue(self._faire("supprime le champ inexistant").echec)
        self.assertTrue(self._faire("supprime l'ajout").echec, "fonction indispensable")

    def test_champ_en_double_refuse(self) -> None:
        self._faire("crée une liste de tâches avec un titre")
        self.assertFalse(self._faire("ajoute un champ prix").echec)
        self.assertTrue(self._faire("ajoute un champ prix").echec)

    def test_renommage(self) -> None:
        self._faire("crée une liste de tâches avec un titre")
        self.assertFalse(self._faire("renomme titre en intitulé").echec)
        store = (Path(self.dossier) / "store.js").read_text(encoding="utf-8")
        self.assertIn("intitule", store)

    def test_titre_du_projet(self) -> None:
        self._faire("crée une liste de tâches avec un titre")
        self._faire("renomme l'application en Suivi client")
        self.assertEqual(self.atelier.intention.titre, "Suivi client")
        self.assertIn("Suivi client", (Path(self.dossier) / "index.html").read_text(encoding="utf-8"))

    def test_ecriture_confinee_au_projet(self) -> None:
        self._faire("crée une liste de tâches avec un titre")
        with self.assertRaises(ValueError):
            self.atelier._resoudre("../evasion.txt")
        with self.assertRaises(ValueError):
            self.atelier._resoudre("/etc/passwd")

    def test_inspection(self) -> None:
        self._faire("crée une liste de tâches avec un titre")
        self.assertFalse(self._faire("liste").echec)
        self.assertFalse(self._faire("décris").echec)
        self.assertFalse(self._faire("montre store.js").echec)
        self.assertTrue(self._faire("montre absent.js").echec)
        self.assertFalse(self._faire("historique").echec)

    def test_historique_enregistre_tout(self) -> None:
        self._faire("crée une liste de tâches avec un titre")
        self._faire("ajoute un champ prix")
        self.assertEqual(len(self.atelier.historique), 2)
        self.assertEqual(self.atelier.historique[-1].operation, "ajouter_champ")

    def test_operation_sans_projet(self) -> None:
        self.assertTrue(self._faire("ajoute un champ prix").echec)

    def test_specification_relue_est_valide(self) -> None:
        self._faire("crée une liste de tâches avec un titre et une priorité")
        donnees = json.loads((Path(self.dossier) / SPEC).read_text(encoding="utf-8"))
        self.assertEqual(donnees["version"], 1)
        self.assertTrue(donnees["champs"])


@unittest.skipUnless(shutil.which("node"), "Node.js absent")
class TestAtelierExecution(unittest.TestCase):
    """L'atelier lance vraiment les tests du projet qu'il vient d'ecrire."""

    def test_tests_au_vert_apres_modifications(self) -> None:
        with tempfile.TemporaryDirectory() as dossier:
            atelier = Atelier(dossier)
            faire = lambda p: atelier.executer(interpreter(p))  # noqa: E731

            faire("crée une application de gestion de tâches avec un titre et une priorité")
            for instruction in ("ajoute un champ prix", "ajoute une case terminé", "ajoute la recherche"):
                self.assertFalse(faire(instruction).echec, instruction)

            resultat = faire("teste")
            self.assertFalse(resultat.echec, f"les tests doivent passer :\n{resultat.detail}")
            self.assertIn("vert", resultat.message)


if __name__ == "__main__":
    unittest.main(verbosity=2)
