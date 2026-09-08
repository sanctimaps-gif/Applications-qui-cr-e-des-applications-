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

from brain.intent import analyse, generer, lexique, referentiel
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
    # Sans aucun champ nomme : c'est le referentiel qui repond.
    "Un carnet de contacts",
    "Une application de gestion de factures",
    "Un suivi de dépenses",
    "Une liste de courses",
    "Une application de gestion de projets",
    # Champs nommes en plus de ce que le domaine prevoit deja.
    "Un carnet de contacts avec un anniversaire",
    # Phrase restrictive : le referentiel doit se taire.
    "Une liste de tâches avec juste un titre et une priorité",
]


def _mot_pour(cle: str) -> str | None:
    """Un mot du lexique dont le pluriel correspond a ce domaine."""
    for mot, (sing, plur) in lexique.ENTITES_CONNUES.items():
        if lexique.normalise(plur) == cle:
            return mot
    return None


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


class TestReferentiel(unittest.TestCase):
    """« Un carnet de contacts » doit suffire : personne ne veut dicter la
    liste des champs, et une application qui existe déjà sait ce qu'elle
    contient."""

    def test_chaque_domaine_est_atteignable(self) -> None:
        """Un modèle qu'aucun mot ne désigne ne servirait jamais."""
        orphelins = [cle for cle in referentiel.domaines() if _mot_pour(cle) is None]
        self.assertEqual(orphelins, [], "modèles sans mot du lexique")

    def test_chaque_domaine_donne_une_application_sensee(self) -> None:
        for cle in referentiel.domaines():
            mot = _mot_pour(cle)
            intention = analyse.analyser(f"Une application de gestion de {mot}")
            with self.subTest(domaine=cle):
                self.assertGreaterEqual(len(intention.champs), 4, "trop pauvre")
                self.assertLessEqual(len(intention.champs), analyse.MAX_CHAMPS)
                self.assertFalse(intention.ignore, "rien ne devrait être ignoré")
                self.assertAlmostEqual(intention.confiance, 1.0)
                # Un champ de tête lisible, sinon les fiches n'ont pas de titre.
                self.assertIn(intention.champ_principal.type, ("texte", "email", "url"))
                # Des clés uniques, sinon deux champs s'écrasent dans le magasin.
                cles = [c.cle for c in intention.champs]
                self.assertEqual(len(cles), len(set(cles)))
                # Des options partout où le type l'exige.
                for champ in intention.champs:
                    if champ.type == "choix":
                        self.assertTrue(champ.options, champ.libelle)

    def test_le_domaine_ne_contredit_jamais_la_phrase(self) -> None:
        intention = analyse.analyser("Un carnet de contacts avec un anniversaire")
        libelles = [c.libelle for c in intention.champs]
        self.assertIn("Anniversaire", libelles)
        self.assertIn("Email", libelles, "le modèle complète toujours")
        anniversaire = next(c for c in intention.champs if c.cle == "anniversaire")
        self.assertEqual(anniversaire.type, "date")

    def test_une_phrase_restrictive_fait_taire_le_referentiel(self) -> None:
        for mot in ("juste", "seulement", "uniquement"):
            intention = analyse.analyser(f"Une liste de tâches avec {mot} un titre")
            with self.subTest(mot=mot):
                self.assertEqual([c.libelle for c in intention.champs], ["Titre"])

    def test_les_exemples_viennent_du_domaine(self) -> None:
        """L'application s'ouvre remplie de valeurs credibles, pas de
        « Titre 1 » : c'est la difference entre une demo et un outil."""
        _, fichiers = construire("Un carnet de contacts")
        self.assertIn("Bernard", fichiers["store.js"])
        self.assertNotIn("Nom 1", fichiers["store.js"])

    def test_chaque_domaine_produit_une_application_qui_passe_ses_tests(self) -> None:
        """Le test qui compte vraiment : les 67 domaines sont générés depuis
        une phrase nue, et chaque application produite fait passer sa propre
        suite de tests sous Node."""
        if not NODE:
            self.skipTest("Node.js absent")
        for cle in referentiel.domaines():
            phrase = f"Une application de gestion de {_mot_pour(cle)}"
            with self.subTest(domaine=cle), tempfile.TemporaryDirectory() as dossier:
                ecrire(phrase, dossier)
                verdict = subprocess.run(
                    ["node", "--test", "test/store.test.js"],
                    cwd=dossier,
                    capture_output=True,
                    text=True,
                    timeout=180,
                )
                self.assertEqual(verdict.returncode, 0, phrase + "\n" + verdict.stdout)

    def test_parite_sur_tous_les_domaines(self) -> None:
        """Les 67 domaines, comparés un par un entre Python et JavaScript."""
        if not NODE:
            self.skipTest("Node.js absent")
        for cle in referentiel.domaines():
            phrase = f"Une application de gestion de {_mot_pour(cle)}"
            js, _ = construire(phrase)
            py = analyse.analyser(phrase)
            with self.subTest(domaine=cle):
                self.assertEqual(
                    [(c["cle"], c["type"], tuple(c["options"])) for c in js["champs"]],
                    [(c.cle, c.type, tuple(c.options)) for c in py.champs],
                )
                self.assertEqual(sorted(js["fonctions"]), sorted(py.fonctions))


@unittest.skipUnless(NODE, "Node.js absent")
class TestPariteDesFichiers(unittest.TestCase):
    """Comparer les analyses ne suffit pas.

    Les deux moteurs ont compris exactement la même chose pendant des semaines
    tout en produisant des interfaces différentes : celle du navigateur savait
    modifier une fiche, celle de Python non. Une application où l'on ajoute et
    supprime mais où l'on ne peut rien corriger n'est pas une application.
    On compare donc aussi ce qui est écrit.
    """

    #: Ce que toute interface produite doit savoir faire, et par quoi cela se
    #: reconnaît dans le code émis.
    CAPACITES_UI = {
        "état d’édition": "enEdition",
        "remplir le formulaire depuis une fiche": "function remplirFormulaire(",
        "vider le formulaire": "function viderFormulaire(",
        "revenir à l’ajout": "function reinitialiser(",
        "bouton Modifier": "'Modifier'",
        "bouton Annuler": "getElementById('annuler')",
        "bascule Ajouter / Enregistrer": "'Enregistrer'",
        "modification réelle": "magasin.modifier(enEdition",
        "accès protégé à localStorage": "function stockageDisponible(",
        "un seul écouteur par champ": "tagName === 'SELECT'",
    }

    CAPACITES_HTML = {
        "bouton de validation identifiable": 'id="valider"',
        "bouton d’annulation": 'id="annuler"',
    }

    def _paire(self, phrase: str) -> tuple[dict, dict]:
        _, js = construire(phrase)
        py = generer(analyse.analyser(phrase))
        return js, py

    def test_les_deux_interfaces_ont_les_memes_capacites(self) -> None:
        for phrase in ("Un carnet de contacts", "Une liste de tâches", "Un suivi de dépenses"):
            js, py = self._paire(phrase)
            for quoi, marqueur in self.CAPACITES_UI.items():
                with self.subTest(phrase=phrase, capacite=quoi):
                    self.assertIn(marqueur, js["ui.js"], "manque côté navigateur")
                    self.assertIn(marqueur, py["ui.js"], "manque côté Python")
            for quoi, marqueur in self.CAPACITES_HTML.items():
                with self.subTest(phrase=phrase, capacite=quoi):
                    self.assertIn(marqueur, js["index.html"], "manque côté navigateur")
                    self.assertIn(marqueur, py["index.html"], "manque côté Python")

    def test_les_deux_produisent_les_memes_fichiers(self) -> None:
        js, py = self._paire("Un carnet de contacts")
        self.assertEqual(sorted(js), sorted(py))

    def test_les_deux_logiques_metier_exposent_la_meme_interface(self) -> None:
        js, py = self._paire("Une liste de tâches")
        for methode in ("ajouter(", "modifier(", "supprimer(", "chercher(", "statistiques(", "versCsv("):
            self.assertIn(methode, js["store.js"], methode)
            self.assertIn(methode, py["store.js"], methode)

    def test_ni_l_un_ni_l_autre_ne_touche_au_dom_dans_store(self) -> None:
        js, py = self._paire("Un carnet de contacts")
        for interdit in ("document.", "window.", "querySelector"):
            self.assertNotIn(interdit, js["store.js"], interdit)
            self.assertNotIn(interdit, py["store.js"], interdit)


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
