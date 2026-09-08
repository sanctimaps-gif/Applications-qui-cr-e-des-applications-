"""Deux autres cibles : une API REST, et un outil en ligne de commande.

La meme specification donne les trois. Seule la peau change : la logique
metier (`store.js`) est identique, avec la persistance sur fichier au lieu du
navigateur. Rien a installer : uniquement la bibliotheque standard de Node.
"""

from __future__ import annotations

import json

from .analyse import Intention
from .generation import NUMERIQUES, SPEC, _echappe_js, _store


def _nom_projet(intention: Intention) -> str:
    from .lexique import identifiant

    return identifiant(intention.pluriel.lower()).replace("_", "-")


def _chemin_api(intention: Intention) -> str:
    from .lexique import identifiant

    return identifiant(intention.pluriel.lower()).replace("_", "-")


# --------------------------------------------------------------------------- #
# Cible « api » : un service REST JSON
# --------------------------------------------------------------------------- #
def _serveur(intention: Intention) -> str:
    ressource = _chemin_api(intention)
    principal = intention.champ_principal
    champ_filtre = next((c for c in intention.champs if c.type == "choix"), None)

    filtre_query = ""
    if champ_filtre:
        filtre_query = f"""
      {champ_filtre.cle}: url.searchParams.get('{champ_filtre.cle}') ?? undefined,"""

    return f"""/**
 * API REST de « {_echappe_js(intention.titre)} ».
 *
 * Bibliotheque standard uniquement : aucun paquet a installer, aucun cadre
 * applicatif. La logique metier vit dans store.js et ne connait pas HTTP.
 */

const http = require('node:http');
const {{ Magasin, CHAMPS }} = require('./store.js');

const RESSOURCE = '/api/{ressource}';

function json(reponse, code, charge) {{
  const corps = JSON.stringify(charge, null, 2);
  reponse.writeHead(code, {{
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(corps),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type',
  }});
  reponse.end(corps);
}}

async function lireCorps(requete) {{
  const morceaux = [];
  let taille = 0;
  for await (const morceau of requete) {{
    taille += morceau.length;
    // Un corps sans limite est une porte ouverte a la saturation memoire.
    if (taille > 1_000_000) throw new Error('corps de requête trop volumineux');
    morceaux.push(morceau);
  }}
  if (morceaux.length === 0) return {{}};
  return JSON.parse(Buffer.concat(morceaux).toString('utf8'));
}}

/**
 * @param {{Magasin}} magasin - injectable, ce qui rend l'API testable sans
 *   toucher au disque.
 */
function creerServeur(magasin = new Magasin()) {{
  return http.createServer(async (requete, reponse) => {{
    const url = new URL(requete.url, `http://${{requete.headers.host ?? 'localhost'}}`);
    const chemin = url.pathname.replace(/\\/+$/, '') || '/';
    const methode = requete.method ?? 'GET';

    if (methode === 'OPTIONS') return json(reponse, 204, {{}});

    try {{
      if (chemin === '/api/sante') {{
        return json(reponse, 200, {{ ok: true, total: magasin.tout().length }});
      }}

      if (chemin === '/api/champs') {{
        return json(reponse, 200, {{ champs: CHAMPS }});
      }}

      if (chemin === '/api/statistiques') {{
        return json(reponse, 200, magasin.statistiques());
      }}

      if (chemin === RESSOURCE) {{
        if (methode === 'GET') {{
          return json(reponse, 200, {{
            fiches: magasin.chercher({{
              recherche: url.searchParams.get('recherche') ?? '',{filtre_query}
              tri: url.searchParams.get('tri') ?? undefined,
              ordre: url.searchParams.get('ordre') ?? undefined,
            }}),
          }});
        }}
        if (methode === 'POST') {{
          const brouillon = await lireCorps(requete);
          return json(reponse, 201, magasin.ajouter({{ ...Magasin.vide(), ...brouillon }}));
        }}
        return json(reponse, 405, {{ erreur: 'méthode non autorisée' }});
      }}

      if (chemin.startsWith(`${{RESSOURCE}}/`)) {{
        const id = decodeURIComponent(chemin.slice(RESSOURCE.length + 1));

        if (methode === 'GET') {{
          const fiche = magasin.tout().find((f) => f.id === id);
          return fiche ? json(reponse, 200, fiche) : json(reponse, 404, {{ erreur: 'introuvable' }});
        }}
        if (methode === 'PUT' || methode === 'PATCH') {{
          const fiche = magasin.modifier(id, await lireCorps(requete));
          return fiche ? json(reponse, 200, fiche) : json(reponse, 404, {{ erreur: 'introuvable' }});
        }}
        if (methode === 'DELETE') {{
          return magasin.supprimer(id)
            ? json(reponse, 204, {{}})
            : json(reponse, 404, {{ erreur: 'introuvable' }});
        }}
        return json(reponse, 405, {{ erreur: 'méthode non autorisée' }});
      }}

      return json(reponse, 404, {{ erreur: 'route inconnue' }});
    }} catch (probleme) {{
      // Une saisie invalide est une erreur du client, pas du serveur.
      return json(reponse, 400, {{ erreur: probleme.message }});
    }}
  }});
}}

if (require.main === module) {{
  const port = Number(process.env.PORT ?? 3000);
  creerServeur().listen(port, () => {{
    console.log(`{_echappe_js(intention.titre)} — http://127.0.0.1:${{port}}${{RESSOURCE}}`);
  }});
}}

module.exports = {{ creerServeur }};
"""


def _tests_api(intention: Intention) -> str:
    ressource = _chemin_api(intention)
    principal = intention.champ_principal

    return f"""const test = require('node:test');
const assert = require('node:assert/strict');
const {{ creerServeur }} = require('../server.js');
const {{ Magasin }} = require('../store.js');

/** Demarre le serveur sur un port libre et renvoie de quoi l'interroger. */
async function demarrer() {{
  const serveur = creerServeur(new Magasin(null));
  await new Promise((resoudre) => serveur.listen(0, '127.0.0.1', resoudre));
  const {{ port }} = serveur.address();
  const base = `http://127.0.0.1:${{port}}`;
  return {{
    base,
    appeler: (chemin, options) => fetch(base + chemin, options),
    arreter: () => new Promise((resoudre) => serveur.close(resoudre)),
  }};
}}

test('GET /api/sante répond', async () => {{
  const s = await demarrer();
  try {{
    const reponse = await s.appeler('/api/sante');
    assert.equal(reponse.status, 200);
    assert.equal((await reponse.json()).ok, true);
  }} finally {{
    await s.arreter();
  }}
}});

test('GET /api/{ressource} liste les fiches', async () => {{
  const s = await demarrer();
  try {{
    const corps = await (await s.appeler('/api/{ressource}')).json();
    assert.ok(Array.isArray(corps.fiches));
    assert.ok(corps.fiches.length > 0, 'des exemples doivent être présents');
  }} finally {{
    await s.arreter();
  }}
}});

test('POST puis GET par identifiant', async () => {{
  const s = await demarrer();
  try {{
    const creation = await s.appeler('/api/{ressource}', {{
      method: 'POST',
      headers: {{ 'content-type': 'application/json' }},
      body: JSON.stringify({{ {principal.cle}: 'Créée par le test' }}),
    }});
    assert.equal(creation.status, 201);
    const fiche = await creation.json();
    assert.equal(fiche.{principal.cle}, 'Créée par le test');

    const relue = await (await s.appeler(`/api/{ressource}/${{fiche.id}}`)).json();
    assert.equal(relue.id, fiche.id);
  }} finally {{
    await s.arreter();
  }}
}});

test('PUT modifie, DELETE supprime', async () => {{
  const s = await demarrer();
  try {{
    const fiche = await (
      await s.appeler('/api/{ressource}', {{
        method: 'POST',
        headers: {{ 'content-type': 'application/json' }},
        body: JSON.stringify({{ {principal.cle}: 'Avant' }}),
      }})
    ).json();

    const modifiee = await (
      await s.appeler(`/api/{ressource}/${{fiche.id}}`, {{
        method: 'PUT',
        headers: {{ 'content-type': 'application/json' }},
        body: JSON.stringify({{ {principal.cle}: 'Après' }}),
      }})
    ).json();
    assert.equal(modifiee.{principal.cle}, 'Après');

    assert.equal((await s.appeler(`/api/{ressource}/${{fiche.id}}`, {{ method: 'DELETE' }})).status, 204);
    assert.equal((await s.appeler(`/api/{ressource}/${{fiche.id}}`)).status, 404);
  }} finally {{
    await s.arreter();
  }}
}});

test('une saisie invalide renvoie 400', async () => {{
  const s = await demarrer();
  try {{
    const reponse = await s.appeler('/api/{ressource}', {{
      method: 'POST',
      headers: {{ 'content-type': 'application/json' }},
      body: JSON.stringify({{ {principal.cle}: '   ' }}),
    }});
    assert.equal(reponse.status, 400);
    assert.match((await reponse.json()).erreur, /obligatoire/);
  }} finally {{
    await s.arreter();
  }}
}});

test('une route inconnue renvoie 404', async () => {{
  const s = await demarrer();
  try {{
    assert.equal((await s.appeler('/api/inexistant')).status, 404);
  }} finally {{
    await s.arreter();
  }}
}});

test('la recherche filtre les résultats', async () => {{
  const s = await demarrer();
  try {{
    await s.appeler('/api/{ressource}', {{
      method: 'POST',
      headers: {{ 'content-type': 'application/json' }},
      body: JSON.stringify({{ {principal.cle}: 'Zibeline particulière' }}),
    }});
    const corps = await (await s.appeler('/api/{ressource}?recherche=zibeline')).json();
    assert.equal(corps.fiches.length, 1);
  }} finally {{
    await s.arreter();
  }}
}});
"""


# --------------------------------------------------------------------------- #
# Cible « cli » : un outil en ligne de commande
# --------------------------------------------------------------------------- #
def _cli(intention: Intention) -> str:
    principal = intention.champ_principal
    champs = intention.champs
    champ_coche = next((c for c in champs if c.type == "booleen"), None)

    options_aide = "\n".join(
        f"  --{c.cle} <valeur>{' ' * max(1, 22 - len(c.cle))}{_echappe_js(c.libelle)}"
        f"{' (obligatoire)' if c.requis else ''}"
        for c in champs
    )

    conversions = []
    for c in champs:
        if c.type in NUMERIQUES:
            conversions.append(f"    if (options.{c.cle} !== undefined) brouillon.{c.cle} = Number(options.{c.cle});")
        elif c.type == "booleen":
            conversions.append(
                f"    if (options.{c.cle} !== undefined) brouillon.{c.cle} = options.{c.cle} !== 'false';"
            )
        else:
            conversions.append(f"    if (options.{c.cle} !== undefined) brouillon.{c.cle} = options.{c.cle};")

    colonnes = ", ".join(f"'{_echappe_js(c.libelle)}'" for c in champs)
    valeurs = ", ".join(f"fiche.{c.cle}" for c in champs)

    bloc_basculer = ""
    if champ_coche:
        bloc_basculer = f"""
  basculer(args) {{
    const id = args[0];
    if (!id) return erreur('identifiant manquant : {_nom_projet(intention)} basculer <id>');
    const fiche = magasin.basculer(id);
    if (!fiche) return erreur(`fiche introuvable : ${{id}}`);
    console.log(`✔ « {_echappe_js(champ_coche.libelle)} » = ${{fiche.{champ_coche.cle}}}`);
  }},
"""

    return f"""#!/usr/bin/env node
/**
 * « {_echappe_js(intention.titre)} » en ligne de commande.
 *
 * Bibliotheque standard uniquement. Les donnees sont conservees dans un
 * fichier JSON a cote du script (variable DONNEES pour en changer).
 */

const {{ Magasin }} = require('./store.js');

const magasin = new Magasin();

function erreur(message) {{
  console.error(`✖ ${{message}}`);
  process.exitCode = 1;
}}

/** Analyse `--cle valeur` en objet. */
function optionsDe(args) {{
  const options = {{}};
  for (let i = 0; i < args.length; i++) {{
    if (!args[i].startsWith('--')) continue;
    const cle = args[i].slice(2);
    const suivant = args[i + 1];
    options[cle] = suivant && !suivant.startsWith('--') ? (i++, suivant) : 'true';
  }}
  return options;
}}

function tableau(fiches) {{
  if (fiches.length === 0) {{
    console.log('(aucune fiche)');
    return;
  }}
  const entetes = ['id', {colonnes}];
  const lignes = fiches.map((fiche) => [fiche.id, {valeurs}].map((v) => String(v ?? '')));
  const largeurs = entetes.map((titre, i) =>
    Math.max(titre.length, ...lignes.map((l) => l[i].length)),
  );
  const rendre = (cellules) => cellules.map((c, i) => c.padEnd(largeurs[i])).join('  ');
  console.log(rendre(entetes));
  console.log(largeurs.map((l) => '─'.repeat(l)).join('  '));
  for (const ligne of lignes) console.log(rendre(ligne));
}}

const commandes = {{
  lister(args) {{
    const options = optionsDe(args);
    tableau(magasin.chercher({{ recherche: options.recherche ?? '', tri: options.tri, ordre: options.ordre }}));
  }},

  ajouter(args) {{
    const options = optionsDe(args);
    const brouillon = Magasin.vide();
{chr(10).join(conversions)}
    try {{
      const fiche = magasin.ajouter(brouillon);
      console.log(`✔ ajoutée : ${{fiche.id}}`);
    }} catch (probleme) {{
      erreur(probleme.message);
    }}
  }},

  modifier(args) {{
    const id = args[0];
    if (!id) return erreur('identifiant manquant : modifier <id> --champ valeur');
    const options = optionsDe(args.slice(1));
    const brouillon = {{}};
{chr(10).join(conversions)}
    const fiche = magasin.modifier(id, brouillon);
    if (!fiche) return erreur(`fiche introuvable : ${{id}}`);
    console.log(`✔ modifiée : ${{id}}`);
  }},

  supprimer(args) {{
    const id = args[0];
    if (!id) return erreur('identifiant manquant : supprimer <id>');
    if (!magasin.supprimer(id)) return erreur(`fiche introuvable : ${{id}}`);
    console.log(`✔ supprimée : ${{id}}`);
  }},
{bloc_basculer}
  chercher(args) {{
    tableau(magasin.chercher({{ recherche: args.join(' ') }}));
  }},

  statistiques() {{
    for (const [cle, valeur] of Object.entries(magasin.statistiques())) {{
      console.log(`${{cle.padEnd(16)}} ${{valeur}}`);
    }}
  }},

  exporter() {{
    console.log(magasin.versCsv());
  }},

  aide() {{
    console.log(`{_echappe_js(intention.titre)}

  lister [--recherche <texte>] [--tri <champ>] [--ordre asc|desc]
  ajouter --{principal.cle} <valeur> [autres options]
  modifier <id> --champ <valeur>
  supprimer <id>
  chercher <texte>
  statistiques
  exporter                      (CSV sur la sortie standard)

Champs disponibles :
{options_aide}`);
  }},
}};

const [commande = 'aide', ...args] = process.argv.slice(2);
const action = commandes[commande] ?? commandes.aide;
action(args);
"""


def _tests_cli(intention: Intention) -> str:
    principal = intention.champ_principal
    return f"""const test = require('node:test');
const assert = require('node:assert/strict');
const {{ execFileSync }} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli.js');

/** Lance l'outil avec un fichier de donnees jetable. */
function lancer(args, donnees) {{
  return execFileSync(process.execPath, [CLI, ...args], {{
    encoding: 'utf8',
    env: {{ ...process.env, DONNEES: donnees }},
  }});
}}

function fichierTemporaire() {{
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-')), 'donnees.json');
}}

test('affiche l aide', () => {{
  assert.match(lancer(['aide'], fichierTemporaire()), /lister/);
}});

test('liste les exemples', () => {{
  assert.match(lancer(['lister'], fichierTemporaire()), /id/);
}});

test('ajoute puis retrouve une fiche', () => {{
  const donnees = fichierTemporaire();
  const sortie = lancer(['ajouter', '--{principal.cle}', 'Zibeline'], donnees);
  assert.match(sortie, /ajoutée/);
  assert.match(lancer(['chercher', 'Zibeline'], donnees), /Zibeline/);
}});

test('les données survivent entre deux appels', () => {{
  const donnees = fichierTemporaire();
  lancer(['ajouter', '--{principal.cle}', 'Persistante'], donnees);
  assert.match(lancer(['lister'], donnees), /Persistante/);
}});

test('statistiques et export', () => {{
  const donnees = fichierTemporaire();
  assert.match(lancer(['statistiques'], donnees), /total/);

  // Un projet a un seul champ produit un CSV sans separateur : on verifie
  // l'en-tete et le nombre de lignes, pas la presence d'un point-virgule.
  const lignes = lancer(['exporter'], donnees).trim().split('\\n');
  assert.ok(lignes.length >= 2, 'un en-tête et au moins une fiche');
  assert.ok(lignes[0].includes('{_echappe_js(principal.libelle)}'));
}});
"""


# --------------------------------------------------------------------------- #
# Assemblage
# --------------------------------------------------------------------------- #
def _package_node(intention: Intention, cible: str) -> str:
    scripts = (
        '"start": "node server.js",\n    "test": "node --test test/store.test.js test/api.test.js"'
        if cible == "api"
        else '"start": "node cli.js aide",\n    "test": "node --test test/store.test.js test/cli.test.js"'
    )
    return f"""{{
  "name": "{_nom_projet(intention)}",
  "version": "1.0.0",
  "private": true,
  "scripts": {{
    {scripts}
  }}
}}
"""


def _lisez_moi_node(intention: Intention, cible: str) -> str:
    ressource = _chemin_api(intention)
    champs = "\n".join(f"| {c.libelle} | `{c.cle}` | {c.type} |" for c in intention.champs)

    if cible == "api":
        usage = f"""## Démarrer

```bash
npm start                 # http://127.0.0.1:3000/api/{ressource}
PORT=8080 npm start
```

## Points d'entrée

| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/api/{ressource}` | lister (`?recherche=`, `?tri=`, `?ordre=`) |
| POST | `/api/{ressource}` | créer |
| GET | `/api/{ressource}/:id` | lire une fiche |
| PUT | `/api/{ressource}/:id` | modifier |
| DELETE | `/api/{ressource}/:id` | supprimer |
| GET | `/api/statistiques` | chiffres de synthèse |
| GET | `/api/champs` | description des champs |
| GET | `/api/sante` | état du service |

```bash
curl -X POST http://127.0.0.1:3000/api/{ressource} \\
  -H 'content-type: application/json' \\
  -d '{{"{intention.champ_principal.cle}": "Exemple"}}'
```"""
    else:
        usage = f"""## Utiliser

```bash
node cli.js aide
node cli.js ajouter --{intention.champ_principal.cle} "Exemple"
node cli.js lister --recherche exemple
node cli.js statistiques
node cli.js exporter > export.csv
```

Les données sont conservées dans un fichier JSON à côté du script.
Changez-en avec la variable `DONNEES`."""

    return f"""# {intention.titre}

> Généré par le compilateur d'intention de Forge, à partir de cette demande :
>
> « {intention.demande} »

Aucune dépendance : uniquement la bibliothèque standard de Node.js.

{usage}

## Champs

| Champ | Clé | Type |
|---|---|---|
{champs}

## Tests

```bash
npm test
```
"""


def generer_node(intention: Intention, cible: str) -> dict[str, str]:
    """Fichiers d'une cible Node : « api » ou « cli »."""
    from .generation import _tests

    fichiers: dict[str, str] = {
        "store.js": _store(intention, backend="fichier"),
        "test/store.test.js": _tests(intention),
        "package.json": _package_node(intention, cible),
        "README.md": _lisez_moi_node(intention, cible),
        SPEC: json.dumps(intention.to_dict(), ensure_ascii=False, indent=2) + "\n",
    }

    if cible == "api":
        fichiers["server.js"] = _serveur(intention)
        fichiers["test/api.test.js"] = _tests_api(intention)
    else:
        fichiers["cli.js"] = _cli(intention)
        fichiers["test/cli.test.js"] = _tests_cli(intention)

    return fichiers
