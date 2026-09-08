"""De la specification comprise vers une application qui tourne.

La generation est deterministe : la meme phrase donne toujours exactement le
meme code, et ce code est correct par construction — pas par chance. Le
resultat est une application web autonome, avec sa logique metier separee de
l'affichage, et ses tests.
"""

from __future__ import annotations

import json

from .analyse import Champ, Intention

# --------------------------------------------------------------------------- #
# Outils de rendu
# --------------------------------------------------------------------------- #
def _json(valeur: object) -> str:
    """Litteral JavaScript sur : JSON est un sous-ensemble valide de JS."""
    return json.dumps(valeur, ensure_ascii=False)


def _echappe_js(texte: str) -> str:
    return texte.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")


def _echappe_html(texte: str) -> str:
    return (
        texte.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _valeur_vide(champ: Champ) -> str:
    if champ.type == "booleen":
        return "false"
    if champ.type == "nombre":
        return "0"
    if champ.type == "choix":
        return f"'{_echappe_js(champ.options[0])}'" if champ.options else "''"
    return "''"


def _exemple(champ: Champ, indice: int) -> str:
    """Une valeur d'exemple credible, pour que l'app s'ouvre remplie."""
    if champ.type == "booleen":
        return "true" if indice == 1 else "false"
    if champ.type == "nombre":
        return str([3, 12, 7][indice % 3])
    if champ.type == "date":
        return f"'2026-0{indice + 1}-1{indice}'"
    if champ.type == "choix" and champ.options:
        return f"'{_echappe_js(champ.options[indice % len(champ.options)])}'"
    if champ.type == "email":
        return f"'contact{indice + 1}@exemple.fr'"
    if champ.type == "url":
        return f"'https://exemple.fr/{indice + 1}'"
    if champ.type == "texte_long":
        return f"'Note d exemple numero {indice + 1}.'"
    return f"'{_echappe_js(champ.libelle)} {indice + 1}'"


# --------------------------------------------------------------------------- #
# store.js — la logique metier, pure et testable
# --------------------------------------------------------------------------- #
def _store(intention: Intention) -> str:
    champs = intention.champs
    principal = intention.champ_principal

    defauts = ",\n".join(f"      {c.cle}: {_valeur_vide(c)}" for c in champs)
    exemples = ",\n".join(
        "      { " + ", ".join(f"{c.cle}: {_exemple(c, i)}" for c in champs) + " }"
        for i in range(3)
    )

    validations = [
        f"""    if (typeof brouillon.{principal.cle} !== 'string' || !brouillon.{principal.cle}.trim()) {{
      throw new Error('Le champ « {_echappe_js(principal.libelle)} » est obligatoire.');
    }}"""
    ]
    for c in champs:
        if c.type == "nombre":
            validations.append(
                f"""    if (brouillon.{c.cle} !== undefined && Number.isNaN(Number(brouillon.{c.cle}))) {{
      throw new Error('Le champ « {_echappe_js(c.libelle)} » doit être un nombre.');
    }}"""
        )
        elif c.type == "email":
            validations.append(
                f"""    if (brouillon.{c.cle} && !String(brouillon.{c.cle}).includes('@')) {{
      throw new Error('Le champ « {_echappe_js(c.libelle)} » doit être une adresse e-mail.');
    }}"""
            )

    champs_recherche = [c.cle for c in champs if c.type in ("texte", "texte_long", "email", "url")]
    recherche = " || ".join(
        f"String(fiche.{cle} ?? '').toLowerCase().includes(terme)" for cle in champs_recherche
    ) or "true"

    champ_filtre = next((c for c in champs if c.type == "choix"), None)
    champ_coche = next((c for c in champs if c.type == "booleen"), None)
    champ_tri = next((c for c in champs if c.type in ("date", "nombre")), None)

    bloc_filtre = ""
    if champ_filtre:
        bloc_filtre = f"""
    if (criteres.{champ_filtre.cle} && criteres.{champ_filtre.cle} !== 'Tous') {{
      fiches = fiches.filter((fiche) => fiche.{champ_filtre.cle} === criteres.{champ_filtre.cle});
    }}"""

    bloc_tri = f"""
    const sens = criteres.ordre === 'desc' ? -1 : 1;
    const cle = criteres.tri || '{(champ_tri or principal).cle}';
    fiches = [...fiches].sort((a, b) => {{
      const ga = a[cle], gb = b[cle];
      if (typeof ga === 'number' && typeof gb === 'number') return (ga - gb) * sens;
      return String(ga ?? '').localeCompare(String(gb ?? ''), 'fr') * sens;
    }});"""

    bloc_cochage = ""
    if champ_coche:
        bloc_cochage = f"""
  /** Bascule « {champ_coche.libelle} » sur une fiche. */
  basculer(id) {{
    const fiche = this.#fiches.find((f) => f.id === id);
    if (!fiche) return undefined;
    fiche.{champ_coche.cle} = !fiche.{champ_coche.cle};
    this.#enregistrer();
    return fiche;
  }}
"""

    stats_coche = ""
    if champ_coche:
        stats_coche = f"""
      faits: this.#fiches.filter((f) => f.{champ_coche.cle}).length,
      restants: this.#fiches.filter((f) => !f.{champ_coche.cle}).length,"""

    stats_nombre = ""
    champ_nombre = next((c for c in champs if c.type == "nombre"), None)
    if champ_nombre:
        stats_nombre = f"""
      total{champ_nombre.cle.capitalize()}: this.#fiches.reduce((somme, f) => somme + Number(f.{champ_nombre.cle} ?? 0), 0),"""

    colonnes_csv = ", ".join(f"'{_echappe_js(c.libelle)}'" for c in champs)
    valeurs_csv = ", ".join(f"fiche.{c.cle}" for c in champs)

    return f'''/**
 * Logique metier de « {intention.titre} ».
 *
 * Aucune dependance au navigateur : cette classe est testable telle quelle
 * sous Node, et c'est elle que les tests couvrent.
 */

/** @typedef {{{{ id: string, {", ".join(f"{c.cle}: *" for c in champs)} }}}} Fiche */

const CLEF = '{_echappe_js(intention.pluriel.lower().replace(" ", "-"))}';

const CHAMPS = [
{chr(10).join(f"  {{ cle: '{c.cle}', libelle: '{_echappe_js(c.libelle)}', type: '{c.type}', requis: {str(c.requis).lower()}, options: {_json(c.options)} }}," for c in champs)}
];

class Magasin {{
  #fiches = [];
  #stockage;

  /**
   * @param {{Storage|null}} stockage - localStorage, ou null pour rester en memoire.
   */
  constructor(stockage = null) {{
    this.#stockage = stockage;
    this.#fiches = this.#charger();
  }}

  #charger() {{
    if (this.#stockage) {{
      try {{
        const brut = this.#stockage.getItem(CLEF);
        if (brut) return JSON.parse(brut);
      }} catch {{
        // Donnees illisibles : on repart des exemples plutot que de planter.
      }}
    }}
    return this.#exemples();
  }}

  #exemples() {{
    return [
{exemples}
    ].map((fiche, index) => ({{ id: `exemple-${{index + 1}}`, ...fiche }}));
  }}

  #enregistrer() {{
    if (!this.#stockage) return;
    try {{
      this.#stockage.setItem(CLEF, JSON.stringify(this.#fiches));
    }} catch {{
      // Navigation privee ou quota atteint : l'application reste utilisable.
    }}
  }}

  /** Toutes les fiches, sans filtre. */
  tout() {{
    return [...this.#fiches];
  }}

  /** Fiche vierge, prete a remplir. */
  static vide() {{
    return {{
{defauts}
    }};
  }}

  /** Ajoute une fiche. Leve si la saisie est invalide. */
  ajouter(brouillon) {{
{chr(10).join(validations)}

    const fiche = {{
      id: `f-${{Date.now().toString(36)}}-${{Math.random().toString(36).slice(2, 7)}}`,
{",".join(chr(10) + f"      {c.cle}: brouillon.{c.cle} ?? {_valeur_vide(c)}" for c in champs)}
    }};
    this.#fiches.push(fiche);
    this.#enregistrer();
    return fiche;
  }}

  /** Modifie une fiche existante. */
  modifier(id, changements) {{
    const fiche = this.#fiches.find((f) => f.id === id);
    if (!fiche) return undefined;
    Object.assign(fiche, changements, {{ id }});
    this.#enregistrer();
    return fiche;
  }}

  /** Supprime une fiche. Renvoie vrai si elle existait. */
  supprimer(id) {{
    const avant = this.#fiches.length;
    this.#fiches = this.#fiches.filter((f) => f.id !== id);
    const retiree = this.#fiches.length < avant;
    if (retiree) this.#enregistrer();
    return retiree;
  }}
{bloc_cochage}
  /** Recherche, filtre et tri, en une passe. */
  chercher(criteres = {{}}) {{
    let fiches = [...this.#fiches];

    const terme = String(criteres.recherche ?? '').trim().toLowerCase();
    if (terme) {{
      fiches = fiches.filter((fiche) => {recherche});
    }}
{bloc_filtre}{bloc_tri}
    return fiches;
  }}

  /** Chiffres de synthese. */
  statistiques() {{
    return {{
      total: this.#fiches.length,{stats_coche}{stats_nombre}
    }};
  }}

  /** Export CSV, separateur point-virgule (tableurs francophones). */
  versCsv() {{
    const entete = [{colonnes_csv}];
    const lignes = this.#fiches.map((fiche) =>
      [{valeurs_csv}].map((valeur) => {{
        const texte = String(valeur ?? '');
        return texte.includes(';') || texte.includes('"')
          ? `"${{texte.replace(/"/g, '""')}}"`
          : texte;
      }}),
    );
    return [entete, ...lignes].map((ligne) => ligne.join(';')).join('\\n');
  }}
}}

// Charge par <script src> dans le navigateur, par require() dans les tests :
// pas de module ES, car un navigateur les refuse en file:// (double-clic).
if (typeof module !== 'undefined' && module.exports) {{
  module.exports = {{ Magasin, CHAMPS }};
}}
'''


# --------------------------------------------------------------------------- #
# index.html
# --------------------------------------------------------------------------- #
def _champ_html(champ: Champ) -> str:
    identifiant = f"champ-{champ.cle}"
    requis = " required" if champ.requis else ""
    libelle = _echappe_html(champ.libelle)

    if champ.type == "texte_long":
        controle = f'<textarea id="{identifiant}" name="{champ.cle}" rows="2"{requis}></textarea>'
    elif champ.type == "choix":
        options = "".join(f"<option>{_echappe_html(o)}</option>" for o in champ.options)
        controle = f'<select id="{identifiant}" name="{champ.cle}">{options}</select>'
    elif champ.type == "booleen":
        return (
            f'        <label class="case"><input type="checkbox" id="{identifiant}" '
            f'name="{champ.cle}" /> {libelle}</label>'
        )
    else:
        types = {"nombre": "number", "date": "date", "email": "email", "url": "url"}
        controle = (
            f'<input type="{types.get(champ.type, "text")}" id="{identifiant}" '
            f'name="{champ.cle}"{requis} />'
        )

    return f'        <label for="{identifiant}">{libelle}{controle}</label>'


def _html(intention: Intention) -> str:
    champs = "\n".join(_champ_html(c) for c in intention.champs)
    champ_filtre = next((c for c in intention.champs if c.type == "choix"), None)

    barre = ""
    if "recherche" in intention.fonctions:
        barre += (
            '        <input type="search" id="recherche" placeholder="Rechercher…" '
            'aria-label="Rechercher" />\n'
        )
    if champ_filtre and "filtre" in intention.fonctions:
        options = "".join(f"<option>{_echappe_html(o)}</option>" for o in champ_filtre.options)
        barre += (
            f'        <select id="filtre" aria-label="Filtrer par {_echappe_html(champ_filtre.libelle.lower())}">'
            f"<option>Tous</option>{options}</select>\n"
        )
    if "tri" in intention.fonctions:
        options = "".join(
            f'<option value="{c.cle}">{_echappe_html(c.libelle)}</option>' for c in intention.champs
        )
        barre += f'        <select id="tri" aria-label="Trier par">{options}</select>\n'
    if "export" in intention.fonctions:
        barre += '        <button type="button" id="exporter">Exporter en CSV</button>\n'

    return f"""<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{_echappe_html(intention.titre)}</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main>
      <h1>{_echappe_html(intention.titre)}</h1>

      <form id="formulaire" novalidate>
{champs}
        <button type="submit">Ajouter</button>
      </form>

      <p id="erreur" class="erreur" role="alert" hidden></p>

      <div class="barre">
{barre}      </div>

      <ul id="liste"></ul>
      <p id="synthese" class="synthese"></p>
    </main>

    <script src="store.js"></script>
    <script src="ui.js"></script>
  </body>
</html>
"""


# --------------------------------------------------------------------------- #
# ui.js
# --------------------------------------------------------------------------- #
def _ui(intention: Intention) -> str:
    champs = intention.champs
    principal = intention.champ_principal
    champ_coche = next((c for c in champs if c.type == "booleen"), None)
    champ_filtre = next((c for c in champs if c.type == "choix"), None)

    lectures = []
    for c in champs:
        if c.type == "booleen":
            lectures.append(f"    {c.cle}: document.getElementById('champ-{c.cle}').checked,")
        elif c.type == "nombre":
            lectures.append(
                f"    {c.cle}: Number(document.getElementById('champ-{c.cle}').value || 0),"
            )
        else:
            lectures.append(f"    {c.cle}: document.getElementById('champ-{c.cle}').value,")

    remises = []
    for c in champs:
        if c.type == "booleen":
            remises.append(f"  document.getElementById('champ-{c.cle}').checked = false;")
        elif c.type != "choix":
            remises.append(f"  document.getElementById('champ-{c.cle}').value = '';")

    details = []
    for c in champs:
        if c is principal or c.type == "booleen":
            continue
        details.append(
            f"""    if (fiche.{c.cle} !== '' && fiche.{c.cle} !== undefined && fiche.{c.cle} !== null) {{
      const {c.cle} = document.createElement('span');
      {c.cle}.className = 'detail';
      {c.cle}.textContent = '{_echappe_js(c.libelle)} : ' + fiche.{c.cle};
      details.append({c.cle});
    }}"""
        )

    bloc_case = ""
    if champ_coche:
        bloc_case = f"""
    const case_ = document.createElement('input');
    case_.type = 'checkbox';
    case_.checked = Boolean(fiche.{champ_coche.cle});
    case_.setAttribute('aria-label', '{_echappe_js(champ_coche.libelle)}');
    case_.addEventListener('change', () => {{
      magasin.basculer(fiche.id);
      afficher();
    }});
    element.append(case_);
"""

    lecture_filtre = (
        f"    {champ_filtre.cle}: document.getElementById('filtre')?.value ?? 'Tous',"
        if champ_filtre and "filtre" in intention.fonctions
        else ""
    )

    export = ""
    if "export" in intention.fonctions:
        export = """
document.getElementById('exporter')?.addEventListener('click', () => {
  const lien = document.createElement('a');
  lien.href = URL.createObjectURL(new Blob([magasin.versCsv()], { type: 'text/csv;charset=utf-8' }));
  lien.download = 'export.csv';
  lien.click();
  URL.revokeObjectURL(lien.href);
});
"""

    return f"""/** Affichage de « {intention.titre} ». La logique vit dans store.js. */

const magasin = new Magasin(globalThis.localStorage ?? null);

function criteres() {{
  return {{
    recherche: document.getElementById('recherche')?.value ?? '',
{lecture_filtre}
    tri: document.getElementById('tri')?.value,
  }};
}}

function afficher() {{
  const liste = document.getElementById('liste');
  liste.textContent = '';

  const fiches = magasin.chercher(criteres());
  for (const fiche of fiches) {{
    const element = document.createElement('li');
{bloc_case}
    const titre = document.createElement('span');
    titre.className = 'titre';
    titre.textContent = fiche.{principal.cle};
    element.append(titre);

    const details = document.createElement('span');
    details.className = 'details';
{chr(10).join(details)}
    element.append(details);

    const supprimer = document.createElement('button');
    supprimer.type = 'button';
    supprimer.className = 'supprimer';
    supprimer.textContent = '✕';
    supprimer.title = 'Supprimer';
    supprimer.addEventListener('click', () => {{
      magasin.supprimer(fiche.id);
      afficher();
    }});
    element.append(supprimer);

    liste.append(element);
  }}

  const stats = magasin.statistiques();
  document.getElementById('synthese').textContent =
    Object.entries(stats).map(([cle, valeur]) => `${{cle}} : ${{valeur}}`).join(' · ');
}}

document.getElementById('formulaire').addEventListener('submit', (evenement) => {{
  evenement.preventDefault();
  const erreur = document.getElementById('erreur');
  erreur.hidden = true;

  try {{
    magasin.ajouter({{
{chr(10).join(lectures)}
    }});
{chr(10).join(remises)}
    afficher();
  }} catch (probleme) {{
    erreur.textContent = probleme.message;
    erreur.hidden = false;
  }}
}});

for (const identifiant of ['recherche', 'filtre', 'tri']) {{
  document.getElementById(identifiant)?.addEventListener('input', afficher);
  document.getElementById(identifiant)?.addEventListener('change', afficher);
}}
{export}
afficher();
"""


# --------------------------------------------------------------------------- #
# styles.css
# --------------------------------------------------------------------------- #
def _css(intention: Intention) -> str:
    return """:root {
  color-scheme: light dark;
  --encre: #1f2429;
  --papier: #f7f6f3;
  --carte: #ffffff;
  --trait: #dcd9d2;
  --accent: #3d6ea5;
  --alerte: #a93b2e;
}

@media (prefers-color-scheme: dark) {
  :root {
    --encre: #e8eaed;
    --papier: #16191d;
    --carte: #1f2429;
    --trait: #333a42;
    --accent: #7aa7d8;
    --alerte: #e08579;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--papier);
  color: var(--encre);
  font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
}

main { max-width: 720px; margin: 0 auto; padding: 28px 20px 56px; }

h1 { font-size: 24px; margin: 0 0 20px; }

form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
  align-items: end;
  margin-bottom: 16px;
}

label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: inherit; }
label.case { flex-direction: row; align-items: center; gap: 8px; font-size: 14px; }

input, select, textarea, button {
  font: inherit;
  min-width: 0;
  padding: 9px 11px;
  border: 1px solid var(--trait);
  border-radius: 8px;
  background: var(--carte);
  color: inherit;
}

textarea { resize: vertical; }
label.case input { padding: 0; width: auto; }

button {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  cursor: pointer;
  font-weight: 600;
}
button:hover { filter: brightness(1.08); }

:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.erreur { color: var(--alerte); font-size: 14px; margin: 0 0 12px; }

.barre { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.barre input, .barre select { flex: 1 1 150px; }
.barre button { flex: 0 0 auto; }

ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }

li {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--carte);
  border: 1px solid var(--trait);
  border-radius: 8px;
  padding: 10px 12px;
}

.titre { font-weight: 600; }
.details { display: flex; flex-wrap: wrap; gap: 10px; margin-left: auto; }
.detail { font-size: 12px; opacity: 0.72; white-space: nowrap; }

.supprimer {
  background: none;
  border: 0;
  color: var(--alerte);
  cursor: pointer;
  padding: 0 4px;
  font-size: 16px;
}

.synthese { margin-top: 18px; font-size: 13px; opacity: 0.75; }
"""


# --------------------------------------------------------------------------- #
# Tests du projet genere
# --------------------------------------------------------------------------- #
def _tests(intention: Intention) -> str:
    principal = intention.champ_principal
    champ_coche = next((c for c in intention.champs if c.type == "booleen"), None)
    champ_filtre = next((c for c in intention.champs if c.type == "choix"), None)

    bloc_cochage = ""
    if champ_coche:
        bloc_cochage = f"""
test('bascule « {_echappe_js(champ_coche.libelle)} »', () => {{
  const magasin = new Magasin(null);
  const fiche = magasin.ajouter({{ ...Magasin.vide(), {principal.cle}: 'Bascule' }});
  const avant = fiche.{champ_coche.cle};
  magasin.basculer(fiche.id);
  assert.equal(magasin.tout().find((f) => f.id === fiche.id).{champ_coche.cle}, !avant);
}});
"""

    bloc_filtre = ""
    if champ_filtre and champ_filtre.options:
        bloc_filtre = f"""
test('filtre par {_echappe_js(champ_filtre.libelle.lower())}', () => {{
  const magasin = new Magasin(null);
  const valeur = '{_echappe_js(champ_filtre.options[0])}';
  magasin.ajouter({{ ...Magasin.vide(), {principal.cle}: 'Filtrée', {champ_filtre.cle}: valeur }});
  const resultats = magasin.chercher({{ {champ_filtre.cle}: valeur }});
  assert.ok(resultats.every((fiche) => fiche.{champ_filtre.cle} === valeur));
}});
"""

    return f"""const test = require('node:test');
const assert = require('node:assert/strict');
const {{ Magasin }} = require('../store.js');

test('ouvre avec des exemples', () => {{
  assert.ok(new Magasin(null).tout().length > 0);
}});

test('ajoute une fiche', () => {{
  const magasin = new Magasin(null);
  const avant = magasin.tout().length;
  const fiche = magasin.ajouter({{ ...Magasin.vide(), {principal.cle}: 'Nouvelle entrée' }});
  assert.equal(magasin.tout().length, avant + 1);
  assert.equal(fiche.{principal.cle}, 'Nouvelle entrée');
  assert.ok(fiche.id);
}});

test('refuse une fiche sans {_echappe_js(principal.libelle.lower())}', () => {{
  const magasin = new Magasin(null);
  assert.throws(() => magasin.ajouter({{ ...Magasin.vide(), {principal.cle}: '   ' }}), /obligatoire/);
}});

test('modifie une fiche', () => {{
  const magasin = new Magasin(null);
  const fiche = magasin.ajouter({{ ...Magasin.vide(), {principal.cle}: 'Avant' }});
  magasin.modifier(fiche.id, {{ {principal.cle}: 'Après' }});
  assert.equal(magasin.tout().find((f) => f.id === fiche.id).{principal.cle}, 'Après');
}});

test('supprime une fiche', () => {{
  const magasin = new Magasin(null);
  const fiche = magasin.ajouter({{ ...Magasin.vide(), {principal.cle}: 'À supprimer' }});
  assert.equal(magasin.supprimer(fiche.id), true);
  assert.equal(magasin.supprimer('inexistant'), false);
}});

test('recherche par texte', () => {{
  const magasin = new Magasin(null);
  magasin.ajouter({{ ...Magasin.vide(), {principal.cle}: 'Zibeline particulière' }});
  const resultats = magasin.chercher({{ recherche: 'zibeline' }});
  assert.equal(resultats.length, 1);
  assert.equal(magasin.chercher({{ recherche: 'introuvable-xyz' }}).length, 0);
}});

test('trie sans perdre de fiche', () => {{
  const magasin = new Magasin(null);
  assert.equal(magasin.chercher({{ ordre: 'desc' }}).length, magasin.tout().length);
}});
{bloc_cochage}{bloc_filtre}
test('statistiques coherentes', () => {{
  const magasin = new Magasin(null);
  assert.equal(magasin.statistiques().total, magasin.tout().length);
}});

test('export CSV : une ligne d en-tete plus les fiches', () => {{
  const magasin = new Magasin(null);
  const lignes = magasin.versCsv().split('\\n');
  assert.equal(lignes.length, magasin.tout().length + 1);
  assert.ok(lignes[0].includes('{_echappe_js(principal.libelle)}'));
}});
"""


def _package(intention: Intention) -> str:
    nom = intention.pluriel.lower().replace(" ", "-")
    from .lexique import identifiant

    return f"""{{
  "name": "{identifiant(nom).replace("_", "-")}",
  "version": "1.0.0",
  "private": true,
  "scripts": {{
    "test": "node --test test/store.test.js"
  }}
}}
"""


def _lisez_moi(intention: Intention) -> str:
    fonctions = "\n".join(f"- {f}" for f in sorted(intention.fonctions))
    champs = "\n".join(f"| {c.libelle} | {c.type} |" for c in intention.champs)
    return f"""# {intention.titre}

> Généré par le compilateur d'intention de Forge, à partir de cette demande :
>
> « {intention.demande} »

Application web autonome : aucune installation, aucune dépendance, aucun réseau.
Ouvrez `index.html` dans un navigateur.

## Champs

| Champ | Type |
|---|---|
{champs}

## Fonctions

{fonctions}

## Tests

```bash
npm test
```

Les tests couvrent la logique métier (`store.js`), indépendante de l'affichage.
"""


# --------------------------------------------------------------------------- #
# Point d'entree
# --------------------------------------------------------------------------- #
#: Nom du fichier qui conserve la specification comprise. Sa presence rend le
#: projet modifiable par l'atelier, sans jamais avoir a relire le code genere.
SPEC = ".forge-intent.json"


def generer(intention: Intention) -> dict[str, str]:
    """Renvoie tous les fichiers de l'application, chemin -> contenu."""
    return {
        "index.html": _html(intention),
        "styles.css": _css(intention),
        "store.js": _store(intention),
        "ui.js": _ui(intention),
        "test/store.test.js": _tests(intention),
        "package.json": _package(intention),
        "README.md": _lisez_moi(intention),
        SPEC: json.dumps(intention.to_dict(), ensure_ascii=False, indent=2) + "\n",
    }
