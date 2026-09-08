"""Tests du client GitHub du navigateur (`web/github.js`) et de la page.

Aucun appel réseau : `fetch` est remplacé par un faux GitHub, et on vérifie ce
qui *serait* parti — l'ordre des appels, l'encodage, le commit sans parent d'un
dépôt neuf, et la reprise sur un dépôt qui existe déjà.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

RACINE = Path(__file__).resolve().parents[2]
CLIENT = RACINE / "web" / "github.js"
PAGE = RACINE / "index.html"
NODE = shutil.which("node")


def _executer(scenario: str) -> dict:
    """Joue un scénario JavaScript avec un faux `fetch`, et renvoie son bilan."""
    programme = f"""
const GitHub = require({json.dumps(str(CLIENT))});

// Le faux GitHub : il enregistre tout ce qu'on lui envoie.
const journal = [];
function faux(reponses) {{
  globalThis.fetch = (url, options) => {{
    const chemin = url.replace('https://api.github.com', '');
    const corps = options.body ? JSON.parse(options.body) : null;
    journal.push({{ methode: options.method, chemin, corps, entetes: options.headers }});
    for (const [motif, repondre] of reponses) {{
      if (new RegExp(motif).test(options.method + ' ' + chemin)) {{
        const r = repondre(corps);
        return Promise.resolve({{
          ok: r.statut < 400,
          status: r.statut,
          text: () => Promise.resolve(JSON.stringify(r.charge ?? {{}})),
        }});
      }}
    }}
    return Promise.resolve({{ ok: false, status: 404, text: () => Promise.resolve('{{"message":"Not Found"}}') }});
  }};
}}

(async () => {{
  const bilan = {{}};
  {scenario}
  bilan.journal = journal;
  process.stdout.write(JSON.stringify(bilan));
}})().catch((e) => {{
  process.stdout.write(JSON.stringify({{ erreur: e.message, journal }}));
}});
"""
    resultat = subprocess.run(
        ["node", "-e", programme], capture_output=True, text=True, timeout=60
    )
    if resultat.returncode != 0:
        raise AssertionError(resultat.stderr[:800])
    return json.loads(resultat.stdout)


@unittest.skipUnless(NODE, "Node.js absent")
class TestClientGitHub(unittest.TestCase):
    def test_le_jeton_part_en_en_tete_et_nulle_part_ailleurs(self) -> None:
        bilan = _executer("""
          faux([['GET /user', () => ({ statut: 200, charge: { login: 'moi' } })]]);
          bilan.moi = await new GitHub.Client('secret-abc').moi();
        """)
        appel = bilan["journal"][0]
        self.assertEqual(bilan["moi"]["login"], "moi")
        self.assertEqual(appel["entetes"]["authorization"], "Bearer secret-abc")
        # Jamais dans l'URL : une adresse finit dans les journaux et l'historique.
        self.assertNotIn("secret-abc", appel["chemin"])

    def test_un_depot_neuf_recoit_un_commit_sans_parent(self) -> None:
        bilan = _executer("""
          faux([
            ['POST .*/git/blobs', () => ({ statut: 201, charge: { sha: 'b1' } })],
            ['GET .*/git/ref/heads/', () => ({ statut: 404, charge: { message: 'Not Found' } })],
            ['POST .*/git/trees', () => ({ statut: 201, charge: { sha: 't1' } })],
            ['POST .*/git/commits', () => ({ statut: 201, charge: { sha: 'c1' } })],
            ['POST .*/git/refs', () => ({ statut: 201, charge: {} })],
          ]);
          bilan.envoi = await new GitHub.Client('j').publier({
            proprietaire: 'moi', depot: 'projet', branche: 'main',
            message: 'premier', fichiers: { 'index.html': '<p>Bonjour</p>', 'a/b.js': 'const x = 1;' },
          });
        """)
        self.assertEqual(bilan["envoi"]["fichiers"], 2)
        appels = [a["methode"] + " " + a["chemin"] for a in bilan["journal"]]
        # Un blob par fichier, puis l'arbre, le commit, et la référence créée.
        self.assertEqual(sum(1 for a in appels if a.endswith("/git/blobs")), 2)
        self.assertTrue(any(a.endswith("/git/refs") for a in appels))
        self.assertFalse(any("PATCH" in a for a in appels), "pas de ref à mettre à jour")
        commit = next(a for a in bilan["journal"] if a["chemin"].endswith("/git/commits"))
        self.assertEqual(commit["corps"]["parents"], [])
        arbre = next(a for a in bilan["journal"] if a["chemin"].endswith("/git/trees"))
        self.assertNotIn("base_tree", arbre["corps"])
        self.assertEqual(
            sorted(e["path"] for e in arbre["corps"]["tree"]), ["a/b.js", "index.html"]
        )

    def test_un_depot_existant_recoit_un_commit_enfant(self) -> None:
        bilan = _executer("""
          faux([
            ['POST .*/git/blobs', () => ({ statut: 201, charge: { sha: 'b1' } })],
            ['GET .*/git/ref/heads/', () => ({ statut: 200, charge: { object: { sha: 'vieux' } } })],
            ['GET .*/git/commits/', () => ({ statut: 200, charge: { tree: { sha: 'arbre0' } } })],
            ['POST .*/git/trees', () => ({ statut: 201, charge: { sha: 't2' } })],
            ['POST .*/git/commits', () => ({ statut: 201, charge: { sha: 'c2' } })],
            ['PATCH .*/git/refs/heads/', () => ({ statut: 200, charge: {} })],
          ]);
          bilan.envoi = await new GitHub.Client('j').publier({
            proprietaire: 'moi', depot: 'projet', branche: 'main',
            message: 'suite', fichiers: { 'index.html': 'x' },
          });
        """)
        commit = next(a for a in bilan["journal"] if a["chemin"].endswith("/git/commits") and a["methode"] == "POST")
        self.assertEqual(commit["corps"]["parents"], ["vieux"])
        arbre = next(a for a in bilan["journal"] if a["chemin"].endswith("/git/trees"))
        self.assertEqual(arbre["corps"]["base_tree"], "arbre0")
        self.assertTrue(any(a["methode"] == "PATCH" for a in bilan["journal"]))

    def test_les_accents_traversent_l_encodage(self) -> None:
        """`btoa` ne sait traiter que des octets : un « é » le ferait lever si
        le contenu n'était pas encodé en UTF-8 d'abord."""
        bilan = _executer("""
          faux([
            ['POST .*/git/blobs', () => ({ statut: 201, charge: { sha: 'b1' } })],
            ['GET .*/git/ref/heads/', () => ({ statut: 404, charge: {} })],
            ['POST .*/git/trees', () => ({ statut: 201, charge: { sha: 't' } })],
            ['POST .*/git/commits', () => ({ statut: 201, charge: { sha: 'c' } })],
            ['POST .*/git/refs', () => ({ statut: 201, charge: {} })],
          ]);
          await new GitHub.Client('j').publier({
            proprietaire: 'moi', depot: 'p', branche: 'main', message: 'm',
            fichiers: { 'a.txt': 'Date d’échéance — priorité « haute » ✓' },
          });
        """)
        blob = next(a for a in bilan["journal"] if a["chemin"].endswith("/git/blobs"))
        self.assertEqual(blob["corps"]["encoding"], "base64")
        import base64

        rendu = base64.b64decode(blob["corps"]["content"]).decode("utf-8")
        self.assertEqual(rendu, "Date d’échéance — priorité « haute » ✓")

    def test_les_erreurs_sont_expliquees_en_francais(self) -> None:
        for statut, attendu in ((401, "Jeton refusé"), (403, "permission"), (404, "Introuvable")):
            bilan = _executer(
                "faux([['GET /user', () => ({ statut: %d, charge: { message: 'nope' } })]]);\n"
                "try { await new GitHub.Client('j').moi(); } catch (e) { bilan.message = e.message; bilan.statut = e.statut; }"
                % statut
            )
            self.assertEqual(bilan["statut"], statut)
            self.assertIn(attendu, bilan["message"])

    def test_un_echec_reseau_le_dit(self) -> None:
        bilan = _executer("""
          globalThis.fetch = () => Promise.reject(new Error('offline'));
          try { await new GitHub.Client('j').moi(); } catch (e) { bilan.message = e.message; }
        """)
        self.assertIn("joindre GitHub", bilan["message"])

    def test_pages_absentes_ne_font_pas_echouer(self) -> None:
        """Pages est un bonus : un refus ne doit pas casser la publication."""
        bilan = _executer("""
          faux([['POST .*/pages', () => ({ statut: 403, charge: { message: 'non' } })]]);
          bilan.pages = await new GitHub.Client('j').activerPages('moi', 'p', 'main');
        """)
        self.assertIsNone(bilan["pages"])

    def test_nom_de_depot_valide(self) -> None:
        bilan = _executer("""
          bilan.noms = ['Gestion de tâches', 'Le Tilleul — Restaurant', '   ', '.cache.']
            .map(GitHub.nomDepot);
        """)
        self.assertEqual(
            bilan["noms"],
            ["gestion-de-taches", "le-tilleul-restaurant", "projet-forge", "cache"],
        )
        for nom in bilan["noms"]:
            self.assertRegex(nom, r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class TestPagePublique(unittest.TestCase):
    def setUp(self) -> None:
        self.html = PAGE.read_text(encoding="utf-8")

    def test_l_apercu_a_bien_disparu(self) -> None:
        for trace in ("<iframe", "id=\"apercu\"", "srcdoc", "id=\"largeurs\"", "id=\"ouvrir\""):
            self.assertNotIn(trace, self.html, trace)

    def test_les_onglets_sont_fichiers_et_github(self) -> None:
        onglets = re.findall(r'id="tab-([a-z]+)"', self.html)
        self.assertEqual(onglets, ["fichiers", "github"])

    def test_le_client_github_est_charge(self) -> None:
        self.assertIn('<script src="web/github.js"></script>', self.html)

    def test_le_champ_du_jeton_est_masque_et_hors_formulaire_automatique(self) -> None:
        champ = re.search(r'<input[^>]*id="jeton"[^>]*>', self.html)
        self.assertIsNotNone(champ)
        self.assertIn('type="password"', champ.group(0))
        self.assertIn('autocomplete="off"', champ.group(0))

    def test_les_liens_sortants_sont_surs(self) -> None:
        """`target="_blank"` sans `rel` laisse la page ouverte manipuler celle-ci."""
        for lien in re.findall(r"<a[^>]*target=\"_blank\"[^>]*>", self.html):
            self.assertIn("noopener", lien, lien)

    def test_la_page_dit_ou_va_le_jeton(self) -> None:
        self.assertIn("api.github.com", self.html)
        self.assertIn("aucun autre serveur", self.html)

    def test_la_page_ne_promet_plus_que_rien_ne_sort(self) -> None:
        """Publier envoie le projet chez GitHub : la promesse d'origine
        (« rien ne sort de votre navigateur ») serait devenue fausse."""
        for promesse in ("rien ne sort de votre navigateur", "aucune donnée envoyée nulle part"):
            self.assertNotIn(promesse, self.html, promesse)


if __name__ == "__main__":
    unittest.main()
