/**
 * Moteur d'applications — une vraie application, pas une maquette.
 *
 * Ce que produit ce moteur a une logique métier séparée de l'affichage :
 * validation des saisies, persistance, recherche, filtre, tri, statistiques,
 * export CSV, et des tests qui s'exécutent sous Node. L'interface n'est que
 * la peau posée dessus.
 *
 * Le vocabulaire vient de `lexique.js`, exporté depuis Python : les deux
 * moteurs comprennent donc exactement les mêmes phrases.
 */

(function (racine) {
  'use strict';

  var LEXIQUE =
    typeof module !== 'undefined' && module.exports
      ? require('./lexique.js')
      : racine.LEXIQUE;

  // ===================================================================== //
  // Langue
  // ===================================================================== //
  var sansAccents = function (t) { return String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, ''); };
  var normalise = function (t) { return sansAccents(String(t || '').toLowerCase()).replace(/\s+/g, ' ').trim(); };
  var capitale = function (t) { return t ? t[0].toUpperCase() + t.slice(1) : t; };

  var MOTS_VIDES = new Set(LEXIQUE.motsVides);

  function pluriel(mot) {
    if (!mot) return mot;
    if (/(s|x|z)$/.test(mot)) return mot;
    if (/al$/.test(mot)) return mot.slice(0, -2) + 'aux';
    if (/(eau|eu)$/.test(mot)) return mot + 'x';
    return mot + 's';
  }

  function singulier(mot) {
    if (mot.length <= 3) return mot;
    if (/aux$/.test(mot)) return mot.slice(0, -3) + 'al';
    if (/eaux$/.test(mot)) return mot.slice(0, -1);
    if (/s$/.test(mot) && !/us$/.test(mot) && !/as$/.test(mot)) return mot.slice(0, -1);
    return mot;
  }

  function identifiant(texte) {
    var base = normalise(texte).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base) return 'champ';
    return /^[0-9]/.test(base) ? 'c_' + base : base;
  }

  function typeDuChamp(libelle) {
    var cle = normalise(libelle);
    if (LEXIQUE.typesParMot[cle]) return LEXIQUE.typesParMot[cle];
    var mots = cle.split(' ');
    for (var i = 0; i < mots.length; i++) {
      if (LEXIQUE.typesParMot[mots[i]]) return LEXIQUE.typesParMot[mots[i]];
    }
    return 'texte';
  }

  function optionsDuChamp(libelle) {
    var cle = normalise(libelle);
    if (LEXIQUE.optionsParChamp[cle]) return LEXIQUE.optionsParChamp[cle].slice();
    var mots = cle.split(' ');
    for (var i = 0; i < mots.length; i++) {
      if (LEXIQUE.optionsParChamp[mots[i]]) return LEXIQUE.optionsParChamp[mots[i]].slice();
    }
    return ['Option A', 'Option B'];
  }

  var NUMERIQUES = ['nombre', 'pourcentage', 'etoiles'];
  var TEXTUELS = ['texte', 'texte_long', 'email', 'url', 'telephone', 'couleur_hex'];
  var estNumerique = function (t) { return NUMERIQUES.indexOf(t) !== -1; };

  // ===================================================================== //
  // Analyse
  // ===================================================================== //
  function trouveEntite(plat) {
    var amorces = LEXIQUE.amorcesEntite;
    for (var i = 0; i < amorces.length; i++) {
      var motif = new RegExp('(^|\\s)' + amorces[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+([a-z0-9-]+)');
      var trouve = plat.match(motif);
      if (!trouve) continue;
      var mot = trouve[2];
      if (MOTS_VIDES.has(mot)) continue;
      if (LEXIQUE.entitesConnues[mot]) {
        return { singulier: LEXIQUE.entitesConnues[mot][0], pluriel: LEXIQUE.entitesConnues[mot][1], sur: true };
      }
      var base = singulier(mot);
      return { singulier: capitale(base), pluriel: capitale(pluriel(base)), sur: true };
    }
    var mots = plat.split(' ');
    for (var j = 0; j < mots.length; j++) {
      if (LEXIQUE.entitesConnues[mots[j]]) {
        return { singulier: LEXIQUE.entitesConnues[mots[j]][0], pluriel: LEXIQUE.entitesConnues[mots[j]][1], sur: true };
      }
    }
    return { singulier: 'Élément', pluriel: 'Éléments', sur: false };
  }

  var AMORCES_CHAMPS = ['avec', 'comportant', 'contenant', 'ayant', 'champs', 'chaque', 'possedant'];
  var SEPARATEURS = new Set(['et', 'puis', 'ainsi', 'que', 'ou', ',', ';']);
  // Attention : en JavaScript, `\w` reste ASCII même avec le drapeau `u`.
  // Écrire `[^\W_]` comme en Python amputerait « Priorité » de son accent et
  // lui ferait perdre son type. Les classes Unicode sont donc explicites.
  var JETON = /[\p{L}\p{N}]+|[,;]/gu;

  function libelleDepuis(mots) {
    var utiles = mots.filter(function (m) { return !MOTS_VIDES.has(normalise(m)); });
    return utiles.slice(0, 3).join(' ');
  }

  function trouveChamps(texte) {
    var mots = String(texte).toLowerCase().match(JETON) || [];
    var plats = mots.map(normalise);
    var ignore = [];

    var debut = -1;
    for (var i = 0; i < plats.length; i++) {
      if (AMORCES_CHAMPS.indexOf(plats[i]) !== -1) { debut = i + 1; break; }
    }
    if (debut === -1) return { champs: [], ignore: ignore };

    var champs = [];
    var vus = new Set();
    var groupe = [];

    function ajoute(groupeMots) {
      var libelle = libelleDepuis(groupeMots);
      if (!libelle) return true;
      var plat = normalise(libelle);
      if (LEXIQUE.fonctionsParMot[plat] || MOTS_VIDES.has(plat)) return true;

      var cle = identifiant(libelle);
      if (vus.has(cle)) return true;
      vus.add(cle);

      var type = typeDuChamp(libelle);
      champs.push({
        cle: cle,
        libelle: capitale(libelle),
        type: type,
        options: type === 'choix' ? optionsDuChamp(libelle) : [],
        requis: champs.length === 0,
      });
      if (champs.length >= 8) { ignore.push('champs au-delà du huitième'); return false; }
      return true;
    }

    for (var k = debut; k < mots.length; k++) {
      var plat2 = plats[k];
      if (LEXIQUE.fonctionsParMot[plat2] && normalise(libelleDepuis(groupe)) !== plat2) {
        if (groupe.length && !ajoute(groupe)) return { champs: champs, ignore: ignore };
        groupe = [];
        continue;
      }
      if (SEPARATEURS.has(plat2)) {
        if (groupe.length && !ajoute(groupe)) return { champs: champs, ignore: ignore };
        groupe = [];
        continue;
      }
      groupe.push(mots[k]);
    }
    if (groupe.length) ajoute(groupe);

    return { champs: champs, ignore: ignore };
  }

  function trouveFonctions(plat, champs) {
    var fonctions = new Set(LEXIQUE.fonctionsImplicites);
    Object.keys(LEXIQUE.fonctionsParMot).forEach(function (mot) {
      if (new RegExp('(^|\\s)' + mot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)').test(plat)) {
        fonctions.add(LEXIQUE.fonctionsParMot[mot]);
      }
    });
    if (champs.some(function (c) { return c.type === 'choix'; })) fonctions.add('filtre');
    if (champs.some(function (c) { return c.type === 'booleen'; })) fonctions.add('cochage');
    if (champs.some(function (c) { return c.type === 'date' || estNumerique(c.type); })) fonctions.add('tri');
    return fonctions;
  }

  /** Analyse une demande d'application et renvoie sa spécification. */
  function analyser(phrase) {
    var brute = String(phrase || '').trim();
    if (!brute) throw new Error('Décrivez l’application en quelques mots.');

    var plat = normalise(brute);
    var entite = trouveEntite(plat);
    var resultat = trouveChamps(brute);
    var champs = resultat.champs;
    var ignore = resultat.ignore;

    if (champs.length === 0) {
      champs = [
        { cle: 'titre', libelle: 'Titre', type: 'texte', options: [], requis: true },
        { cle: 'statut', libelle: 'Statut', type: 'choix', options: optionsDuChamp('statut'), requis: false },
        { cle: 'notes', libelle: 'Notes', type: 'texte_long', options: [], requis: false },
      ];
      ignore.push('aucun champ nommé : socle titre/statut/notes appliqué');
    }

    var fonctions = trouveFonctions(plat, champs);

    var confiance = 0.35;
    if (entite.sur) confiance += 0.3;
    if (!ignore.some(function (i) { return i.indexOf('aucun champ') === 0; })) confiance += 0.25;
    if (fonctions.size > LEXIQUE.fonctionsImplicites.length) confiance += 0.1;

    var titre = entite.pluriel;
    ['gestion de', 'liste de', 'carnet de', 'suivi de'].forEach(function (amorce) {
      if (plat.indexOf(amorce) !== -1) titre = capitale(amorce.split(' ')[0]) + ' de ' + entite.pluriel.toLowerCase();
    });

    return {
      demande: brute,
      titre: titre,
      singulier: entite.singulier,
      pluriel: entite.pluriel,
      champs: champs,
      fonctions: Array.from(fonctions).sort(),
      ignore: ignore,
      confiance: Math.min(1, confiance),
    };
  }

  // ===================================================================== //
  // Génération
  // ===================================================================== //
  var echappeJs = function (t) { return String(t).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n'); };
  var echappeHtml = function (t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  function champPrincipal(spec) {
    for (var i = 0; i < spec.champs.length; i++) {
      if (['texte', 'email', 'url'].indexOf(spec.champs[i].type) !== -1) return spec.champs[i];
    }
    return spec.champs[0];
  }

  function valeurVide(champ) {
    if (champ.type === 'booleen') return 'false';
    if (estNumerique(champ.type)) return '0';
    if (champ.type === 'choix') return champ.options.length ? "'" + echappeJs(champ.options[0]) + "'" : "''";
    return "''";
  }

  function exemple(champ, i) {
    if (champ.type === 'booleen') return i === 1 ? 'true' : 'false';
    if (champ.type === 'nombre') return String([3, 12, 7][i % 3]);
    if (champ.type === 'pourcentage') return String([25, 60, 90][i % 3]);
    if (champ.type === 'etoiles') return String([3, 5, 4][i % 3]);
    if (champ.type === 'date') return "'2026-0" + (i + 1) + '-1' + i + "'";
    if (champ.type === 'heure') return "'0" + (i + 8) + ":30'";
    if (champ.type === 'telephone') return "'06 12 34 56 7" + i + "'";
    if (champ.type === 'couleur_hex') return "'" + ['#c9613f', '#3d6ea5', '#4b7b5a'][i % 3] + "'";
    if (champ.type === 'choix' && champ.options.length) return "'" + echappeJs(champ.options[i % champ.options.length]) + "'";
    if (champ.type === 'email') return "'contact" + (i + 1) + "@exemple.fr'";
    if (champ.type === 'url') return "'https://exemple.fr/" + (i + 1) + "'";
    if (champ.type === 'texte_long') return "'Note d exemple numero " + (i + 1) + ".'";
    return "'" + echappeJs(champ.libelle) + ' ' + (i + 1) + "'";
  }

  // ------------------------------------------------------------ store.js
  function store(spec) {
    var champs = spec.champs;
    var principal = champPrincipal(spec);
    var filtre = champs.filter(function (c) { return c.type === 'choix'; })[0];
    var coche = champs.filter(function (c) { return c.type === 'booleen'; })[0];
    var tri = champs.filter(function (c) { return c.type === 'date' || c.type === 'heure' || estNumerique(c.type); })[0];
    var nombre = champs.filter(function (c) { return estNumerique(c.type); })[0];

    var validations = [
      "    if (typeof brouillon." + principal.cle + " !== 'string' || !brouillon." + principal.cle + ".trim()) {\n" +
      "      throw new Error('Le champ « " + echappeJs(principal.libelle) + " » est obligatoire.');\n    }",
    ];
    champs.forEach(function (c) {
      if (estNumerique(c.type)) {
        validations.push(
          '    if (brouillon.' + c.cle + ' !== undefined && Number.isNaN(Number(brouillon.' + c.cle + '))) {\n' +
          "      throw new Error('Le champ « " + echappeJs(c.libelle) + " » doit être un nombre.');\n    }",
        );
      } else if (c.type === 'email') {
        validations.push(
          '    if (brouillon.' + c.cle + " && !String(brouillon." + c.cle + ").includes('@')) {\n" +
          "      throw new Error('Le champ « " + echappeJs(c.libelle) + " » doit être une adresse e-mail.');\n    }",
        );
      }
    });

    var recherche =
      champs.filter(function (c) { return TEXTUELS.indexOf(c.type) !== -1; })
        .map(function (c) { return "String(fiche." + c.cle + " ?? '').toLowerCase().includes(terme)"; })
        .join(' || ') || 'true';

    return (
      '/**\n * Logique métier de « ' + spec.titre + ' ».\n *\n' +
      " * Aucune dépendance au navigateur : cette classe s'exécute telle quelle\n" +
      ' * sous Node, et c\'est elle que les tests couvrent.\n */\n\n' +
      "const CLEF = '" + echappeJs(identifiant(spec.pluriel).replace(/_/g, '-')) + "';\n\n" +
      'const CHAMPS = [\n' +
      champs.map(function (c) {
        return "  { cle: '" + c.cle + "', libelle: '" + echappeJs(c.libelle) + "', type: '" + c.type +
          "', requis: " + c.requis + ', options: ' + JSON.stringify(c.options) + ' },';
      }).join('\n') +
      '\n];\n\nclass Magasin {\n  #fiches = [];\n  #stockage;\n\n' +
      '  /**\n   * @param {Storage|null} stockage - localStorage, ou null pour rester en mémoire.\n   */\n' +
      '  constructor(stockage = null) {\n    this.#stockage = stockage;\n    this.#fiches = this.#charger();\n  }\n\n' +
      '  #charger() {\n    if (this.#stockage) {\n      try {\n        const brut = this.#stockage.getItem(CLEF);\n' +
      '        if (brut) return JSON.parse(brut);\n      } catch {\n' +
      '        // Données illisibles : on repart des exemples plutôt que de planter.\n      }\n    }\n' +
      '    return this.#exemples();\n  }\n\n  #exemples() {\n    return [\n' +
      [0, 1, 2].map(function (i) {
        return '      { ' + champs.map(function (c) { return c.cle + ': ' + exemple(c, i); }).join(', ') + ' }';
      }).join(',\n') +
      '\n    ].map((fiche, index) => ({ id: `exemple-${index + 1}`, ...fiche }));\n  }\n\n' +
      '  #enregistrer() {\n    if (!this.#stockage) return;\n    try {\n' +
      '      this.#stockage.setItem(CLEF, JSON.stringify(this.#fiches));\n    } catch {\n' +
      "      // Navigation privée ou quota atteint : l'application reste utilisable.\n    }\n  }\n\n" +
      '  /** Toutes les fiches, sans filtre. */\n  tout() {\n    return [...this.#fiches];\n  }\n\n' +
      '  /** Fiche vierge, prête à remplir. */\n  static vide() {\n    return {\n' +
      champs.map(function (c) { return '      ' + c.cle + ': ' + valeurVide(c); }).join(',\n') +
      '\n    };\n  }\n\n  /** Ajoute une fiche. Lève si la saisie est invalide. */\n  ajouter(brouillon) {\n' +
      validations.join('\n') + '\n\n    const fiche = {\n' +
      '      id: `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,\n' +
      champs.map(function (c) { return '      ' + c.cle + ': brouillon.' + c.cle + ' ?? ' + valeurVide(c); }).join(',\n') +
      '\n    };\n    this.#fiches.push(fiche);\n    this.#enregistrer();\n    return fiche;\n  }\n\n' +
      '  /** Modifie une fiche existante. */\n  modifier(id, changements) {\n' +
      '    const fiche = this.#fiches.find((f) => f.id === id);\n    if (!fiche) return undefined;\n' +
      '    Object.assign(fiche, changements, { id });\n    this.#enregistrer();\n    return fiche;\n  }\n\n' +
      '  /** Supprime une fiche. Renvoie vrai si elle existait. */\n  supprimer(id) {\n' +
      '    const avant = this.#fiches.length;\n    this.#fiches = this.#fiches.filter((f) => f.id !== id);\n' +
      '    const retiree = this.#fiches.length < avant;\n    if (retiree) this.#enregistrer();\n    return retiree;\n  }\n' +
      (coche
        ? '\n  /** Bascule « ' + coche.libelle + ' » sur une fiche. */\n  basculer(id) {\n' +
          '    const fiche = this.#fiches.find((f) => f.id === id);\n    if (!fiche) return undefined;\n' +
          '    fiche.' + coche.cle + ' = !fiche.' + coche.cle + ';\n    this.#enregistrer();\n    return fiche;\n  }\n'
        : '') +
      '\n  /** Recherche, filtre et tri, en une passe. */\n  chercher(criteres = {}) {\n' +
      '    let fiches = [...this.#fiches];\n\n' +
      "    const terme = String(criteres.recherche ?? '').trim().toLowerCase();\n" +
      '    if (terme) {\n      fiches = fiches.filter((fiche) => ' + recherche + ');\n    }\n' +
      (filtre
        ? "\n    if (criteres." + filtre.cle + " && criteres." + filtre.cle + " !== 'Tous') {\n" +
          '      fiches = fiches.filter((fiche) => fiche.' + filtre.cle + ' === criteres.' + filtre.cle + ');\n    }\n'
        : '') +
      "\n    const sens = criteres.ordre === 'desc' ? -1 : 1;\n" +
      "    const cle = criteres.tri || '" + (tri || principal).cle + "';\n" +
      '    fiches = [...fiches].sort((a, b) => {\n      const ga = a[cle], gb = b[cle];\n' +
      "      if (typeof ga === 'number' && typeof gb === 'number') return (ga - gb) * sens;\n" +
      "      return String(ga ?? '').localeCompare(String(gb ?? ''), 'fr') * sens;\n    });\n\n" +
      '    return fiches;\n  }\n\n  /** Chiffres de synthèse. */\n  statistiques() {\n    return {\n' +
      '      total: this.#fiches.length,' +
      (coche
        ? '\n      faits: this.#fiches.filter((f) => f.' + coche.cle + ').length,' +
          '\n      restants: this.#fiches.filter((f) => !f.' + coche.cle + ').length,'
        : '') +
      (nombre
        ? '\n      total' + capitale(nombre.cle) + ': this.#fiches.reduce((s, f) => s + Number(f.' + nombre.cle + ' ?? 0), 0),'
        : '') +
      '\n    };\n  }\n\n  /** Export CSV, séparateur point-virgule (tableurs francophones). */\n  versCsv() {\n' +
      '    const entete = [' + champs.map(function (c) { return "'" + echappeJs(c.libelle) + "'"; }).join(', ') + '];\n' +
      '    const lignes = this.#fiches.map((fiche) =>\n      [' + champs.map(function (c) { return 'fiche.' + c.cle; }).join(', ') + '].map((valeur) => {\n' +
      "        const texte = String(valeur ?? '');\n" +
      '        return texte.includes(\';\') || texte.includes(\'"\')\n' +
      '          ? `"${texte.replace(/"/g, \'""\')}"`\n          : texte;\n      }),\n    );\n' +
      "    return [entete, ...lignes].map((ligne) => ligne.join(';')).join('\\n');\n  }\n}\n\n" +
      '// Chargé par <script src> dans le navigateur, par require() dans les tests :\n' +
      '// pas de module ES, car un navigateur les refuse en file:// (double-clic).\n' +
      "if (typeof module !== 'undefined' && module.exports) {\n  module.exports = { Magasin, CHAMPS };\n}\n"
    );
  }

  // ----------------------------------------------------------- index.html
  function champHtml(champ) {
    var id = 'champ-' + champ.cle;
    var requis = champ.requis ? ' required' : '';
    var libelle = echappeHtml(champ.libelle);

    if (champ.type === 'texte_long') {
      return '        <label for="' + id + '">' + libelle + '<textarea id="' + id + '" name="' + champ.cle + '" rows="2"' + requis + '></textarea></label>';
    }
    if (champ.type === 'choix') {
      var options = champ.options.map(function (o) { return '<option>' + echappeHtml(o) + '</option>'; }).join('');
      return '        <label for="' + id + '">' + libelle + '<select id="' + id + '" name="' + champ.cle + '">' + options + '</select></label>';
    }
    if (champ.type === 'booleen') {
      return '        <label class="case"><input type="checkbox" id="' + id + '" name="' + champ.cle + '" /> ' + libelle + '</label>';
    }
    var types = {
      nombre: 'number', pourcentage: 'number', etoiles: 'number', date: 'date',
      heure: 'time', email: 'email', url: 'url', telephone: 'tel', couleur_hex: 'color',
    };
    var bornes = '';
    if (champ.type === 'pourcentage') bornes = ' min="0" max="100" step="1"';
    else if (champ.type === 'etoiles') bornes = ' min="1" max="5" step="1"';
    else if (champ.type === 'nombre') bornes = ' step="any"';
    return '        <label for="' + id + '">' + libelle + '<input type="' + (types[champ.type] || 'text') +
      '" id="' + id + '" name="' + champ.cle + '"' + bornes + requis + ' /></label>';
  }

  function html(spec) {
    var filtre = spec.champs.filter(function (c) { return c.type === 'choix'; })[0];
    var a = function (f) { return spec.fonctions.indexOf(f) !== -1; };

    var barre = '';
    if (a('recherche')) barre += '        <input type="search" id="recherche" placeholder="Rechercher…" aria-label="Rechercher" />\n';
    if (filtre && a('filtre')) {
      barre += '        <select id="filtre" aria-label="Filtrer par ' + echappeHtml(filtre.libelle.toLowerCase()) + '"><option>Tous</option>' +
        filtre.options.map(function (o) { return '<option>' + echappeHtml(o) + '</option>'; }).join('') + '</select>\n';
    }
    if (a('tri')) {
      barre += '        <select id="tri" aria-label="Trier par">' +
        spec.champs.map(function (c) { return '<option value="' + c.cle + '">' + echappeHtml(c.libelle) + '</option>'; }).join('') +
        '</select>\n';
    }
    if (a('export')) barre += '        <button type="button" id="exporter">Exporter en CSV</button>\n';

    return '<!doctype html>\n<html lang="fr">\n  <head>\n    <meta charset="utf-8" />\n' +
      '    <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
      '    <title>' + echappeHtml(spec.titre) + '</title>\n' +
      '    <link rel="stylesheet" href="styles.css" />\n  </head>\n  <body>\n    <main>\n' +
      '      <h1>' + echappeHtml(spec.titre) + '</h1>\n\n' +
      '      <form id="formulaire" novalidate>\n' + spec.champs.map(champHtml).join('\n') +
      '\n        <button type="submit" id="valider">Ajouter</button>\n' +
      '        <button type="button" id="annuler" hidden>Annuler</button>\n      </form>\n\n' +
      '      <p id="erreur" class="erreur" role="alert" hidden></p>\n\n' +
      '      <div class="barre">\n' + barre + '      </div>\n\n' +
      '      <ul id="liste"></ul>\n      <p id="vide" class="vide" hidden>Aucune fiche ne correspond.</p>\n' +
      '      <p id="synthese" class="synthese"></p>\n    </main>\n\n' +
      '    <script src="store.js"></script>\n    <script src="ui.js"></script>\n  </body>\n</html>\n';
  }

  // --------------------------------------------------------------- ui.js
  function ui(spec) {
    var principal = champPrincipal(spec);
    var coche = spec.champs.filter(function (c) { return c.type === 'booleen'; })[0];
    var filtre = spec.champs.filter(function (c) { return c.type === 'choix'; })[0];
    var a = function (f) { return spec.fonctions.indexOf(f) !== -1; };

    var lectures = spec.champs.map(function (c) {
      if (c.type === 'booleen') return "    " + c.cle + ": document.getElementById('champ-" + c.cle + "').checked,";
      if (estNumerique(c.type)) return "    " + c.cle + ": Number(document.getElementById('champ-" + c.cle + "').value || 0),";
      return "    " + c.cle + ": document.getElementById('champ-" + c.cle + "').value,";
    }).join('\n');

    var ecritures = spec.champs.map(function (c) {
      if (c.type === 'booleen') return "  document.getElementById('champ-" + c.cle + "').checked = Boolean(fiche." + c.cle + ');';
      return "  document.getElementById('champ-" + c.cle + "').value = fiche." + c.cle + " ?? '';";
    }).join('\n');

    var remises = spec.champs.map(function (c) {
      if (c.type === 'booleen') return "  document.getElementById('champ-" + c.cle + "').checked = false;";
      if (c.type === 'choix') return '';
      return "  document.getElementById('champ-" + c.cle + "').value = '';";
    }).filter(Boolean).join('\n');

    var details = spec.champs.filter(function (c) { return c !== principal && c.type !== 'booleen'; })
      .map(function (c) {
        return "    if (fiche." + c.cle + " !== '' && fiche." + c.cle + ' !== undefined && fiche.' + c.cle + ' !== null) {\n' +
          "      const d = document.createElement('span');\n      d.className = 'detail';\n" +
          "      d.textContent = '" + echappeJs(c.libelle) + " : ' + fiche." + c.cle + ';\n' +
          '      details.append(d);\n    }';
      }).join('\n');

    return '/** Affichage de « ' + spec.titre + ' ». La logique vit dans store.js. */\n\n' +
      '/**\n * Le simple ACCÈS à localStorage lève dans un cadre isolé ou en\n' +
      " * navigation privée stricte : il faut donc l'entourer, pas seulement\n" +
      ' * son usage.\n */\n' +
      'function stockageDisponible() {\n  try {\n    return globalThis.localStorage ?? null;\n' +
      '  } catch {\n    return null;   // l’application reste utilisable, en mémoire\n  }\n}\n\n' +
      'const magasin = new Magasin(stockageDisponible());\n' +
      "let enEdition = null;   // identifiant de la fiche en cours de modification\n\n" +
      'function criteres() {\n  return {\n' +
      "    recherche: document.getElementById('recherche')?.value ?? '',\n" +
      (filtre && a('filtre') ? "    " + filtre.cle + ": document.getElementById('filtre')?.value ?? 'Tous',\n" : '') +
      "    tri: document.getElementById('tri')?.value,\n  };\n}\n\n" +
      'function remplirFormulaire(fiche) {\n' + ecritures + '\n}\n\n' +
      'function viderFormulaire() {\n' + remises + '\n}\n\n' +
      'function afficher() {\n' +
      "  const liste = document.getElementById('liste');\n  liste.textContent = '';\n\n" +
      '  const fiches = magasin.chercher(criteres());\n' +
      "  document.getElementById('vide').hidden = fiches.length > 0;\n\n" +
      '  for (const fiche of fiches) {\n    const element = document.createElement(\'li\');\n' +
      (coche
        ? "    const case_ = document.createElement('input');\n    case_.type = 'checkbox';\n" +
          '    case_.checked = Boolean(fiche.' + coche.cle + ');\n' +
          "    case_.setAttribute('aria-label', '" + echappeJs(coche.libelle) + "');\n" +
          "    case_.addEventListener('change', () => { magasin.basculer(fiche.id); afficher(); });\n" +
          '    element.append(case_);\n'
        : '') +
      "    const titre = document.createElement('span');\n    titre.className = 'titre';\n" +
      '    titre.textContent = fiche.' + principal.cle + ';\n    element.append(titre);\n\n' +
      "    const details = document.createElement('span');\n    details.className = 'details';\n" +
      details + '\n    element.append(details);\n\n' +
      "    const modifier = document.createElement('button');\n    modifier.type = 'button';\n" +
      "    modifier.className = 'lien';\n    modifier.textContent = 'Modifier';\n" +
      "    modifier.addEventListener('click', () => {\n      enEdition = fiche.id;\n      remplirFormulaire(fiche);\n" +
      "      document.getElementById('valider').textContent = 'Enregistrer';\n" +
      "      document.getElementById('annuler').hidden = false;\n" +
      "      document.getElementById('champ-" + principal.cle + "').focus();\n    });\n    element.append(modifier);\n\n" +
      "    const supprimer = document.createElement('button');\n    supprimer.type = 'button';\n" +
      "    supprimer.className = 'supprimer';\n    supprimer.textContent = '✕';\n    supprimer.title = 'Supprimer';\n" +
      "    supprimer.addEventListener('click', () => {\n      magasin.supprimer(fiche.id);\n" +
      '      if (enEdition === fiche.id) reinitialiser();\n      afficher();\n    });\n    element.append(supprimer);\n\n' +
      '    liste.append(element);\n  }\n\n' +
      '  const stats = magasin.statistiques();\n' +
      "  document.getElementById('synthese').textContent =\n" +
      "    Object.entries(stats).map(([cle, valeur]) => `${cle} : ${valeur}`).join(' · ');\n}\n\n" +
      'function reinitialiser() {\n  enEdition = null;\n  viderFormulaire();\n' +
      "  document.getElementById('valider').textContent = 'Ajouter';\n" +
      "  document.getElementById('annuler').hidden = true;\n" +
      "  document.getElementById('erreur').hidden = true;\n}\n\n" +
      "document.getElementById('annuler').addEventListener('click', reinitialiser);\n\n" +
      "document.getElementById('formulaire').addEventListener('submit', (evenement) => {\n" +
      '  evenement.preventDefault();\n' +
      "  const erreur = document.getElementById('erreur');\n  erreur.hidden = true;\n\n" +
      '  const brouillon = {\n' + lectures + '\n  };\n\n  try {\n' +
      '    if (enEdition) magasin.modifier(enEdition, brouillon);\n    else magasin.ajouter(brouillon);\n' +
      '    reinitialiser();\n    afficher();\n  } catch (probleme) {\n' +
      '    erreur.textContent = probleme.message;\n    erreur.hidden = false;\n  }\n});\n\n' +
      '/*\n * Un seul écouteur par champ, et surtout PAS « change » sur une zone de\n' +
      " * texte : « change » part à la perte du focus, donc cliquer « Modifier »\n" +
      ' * redessinerait la liste entre le mousedown et le mouseup — le bouton\n' +
      " * disparaîtrait sous la souris et le clic n'arriverait jamais.\n */\n" +
      "for (const identifiant of ['recherche', 'filtre', 'tri']) {\n" +
      '  const champ = document.getElementById(identifiant);\n' +
      "  champ?.addEventListener(champ.tagName === 'SELECT' ? 'change' : 'input', afficher);\n}\n" +
      (a('export')
        ? "\ndocument.getElementById('exporter')?.addEventListener('click', () => {\n" +
          "  const lien = document.createElement('a');\n" +
          "  lien.href = URL.createObjectURL(new Blob([magasin.versCsv()], { type: 'text/csv;charset=utf-8' }));\n" +
          "  lien.download = 'export.csv';\n  lien.click();\n  URL.revokeObjectURL(lien.href);\n});\n"
        : '') +
      '\nafficher();\n';
  }

  // ------------------------------------------------------------ styles.css
  function css() {
    return ':root {\n  color-scheme: light dark;\n  --encre: #1f2429;\n  --papier: #f7f6f3;\n' +
      '  --carte: #ffffff;\n  --trait: #dcd9d2;\n  --accent: #3d6ea5;\n  --alerte: #a93b2e;\n}\n\n' +
      '@media (prefers-color-scheme: dark) {\n  :root {\n    --encre: #e8eaed;\n    --papier: #16191d;\n' +
      '    --carte: #1f2429;\n    --trait: #333a42;\n    --accent: #7aa7d8;\n    --alerte: #e08579;\n  }\n}\n\n' +
      '* { box-sizing: border-box; }\n\nbody {\n  margin: 0;\n  background: var(--papier);\n  color: var(--encre);\n' +
      '  font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;\n}\n\n' +
      'main { max-width: 760px; margin: 0 auto; padding: 28px 20px 56px; }\n' +
      'h1 { font-size: 24px; margin: 0 0 20px; }\n\n' +
      'form {\n  display: grid;\n  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));\n' +
      '  gap: 12px;\n  align-items: end;\n  margin-bottom: 16px;\n}\n\n' +
      'label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; }\n' +
      'label.case { flex-direction: row; align-items: center; gap: 8px; font-size: 14px; }\n\n' +
      'input, select, textarea, button {\n  font: inherit;\n  min-width: 0;\n  padding: 9px 11px;\n' +
      '  border: 1px solid var(--trait);\n  border-radius: 8px;\n  background: var(--carte);\n  color: inherit;\n}\n' +
      'textarea { resize: vertical; }\nlabel.case input { padding: 0; width: auto; }\n\n' +
      'button {\n  background: var(--accent);\n  border-color: var(--accent);\n  color: #fff;\n' +
      '  cursor: pointer;\n  font-weight: 600;\n}\nbutton:hover { filter: brightness(1.08); }\n' +
      ':focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }\n\n' +
      '.erreur { color: var(--alerte); font-size: 14px; margin: 0 0 12px; }\n' +
      '.vide { color: var(--encre); opacity: .6; font-size: 14px; }\n\n' +
      '.barre { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }\n' +
      '.barre input, .barre select { flex: 1 1 150px; }\n.barre button { flex: 0 0 auto; }\n\n' +
      'ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }\n' +
      'li {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  background: var(--carte);\n' +
      '  border: 1px solid var(--trait);\n  border-radius: 8px;\n  padding: 10px 12px;\n}\n\n' +
      '.titre { font-weight: 600; }\n' +
      '.details { display: flex; flex-wrap: wrap; gap: 10px; margin-left: auto; }\n' +
      '.detail { font-size: 12px; opacity: .72; white-space: nowrap; }\n\n' +
      '.lien, .supprimer {\n  background: none;\n  border: 0;\n  cursor: pointer;\n  padding: 0 4px;\n' +
      '  font-weight: 500;\n  font-size: 13px;\n}\n.lien { color: var(--accent); }\n' +
      '.supprimer { color: var(--alerte); font-size: 16px; }\n\n' +
      '.synthese { margin-top: 18px; font-size: 13px; opacity: .75; }\n';
  }

  // ---------------------------------------------------------------- tests
  function tests(spec) {
    var principal = champPrincipal(spec);
    var coche = spec.champs.filter(function (c) { return c.type === 'booleen'; })[0];
    var filtre = spec.champs.filter(function (c) { return c.type === 'choix'; })[0];

    return "const test = require('node:test');\nconst assert = require('node:assert/strict');\n" +
      "const { Magasin } = require('../store.js');\n\n" +
      "test('ouvre avec des exemples', () => {\n  assert.ok(new Magasin(null).tout().length > 0);\n});\n\n" +
      "test('ajoute une fiche', () => {\n  const magasin = new Magasin(null);\n" +
      '  const avant = magasin.tout().length;\n' +
      "  const fiche = magasin.ajouter({ ...Magasin.vide(), " + principal.cle + ": 'Nouvelle entrée' });\n" +
      '  assert.equal(magasin.tout().length, avant + 1);\n' +
      "  assert.equal(fiche." + principal.cle + ", 'Nouvelle entrée');\n  assert.ok(fiche.id);\n});\n\n" +
      "test('refuse une fiche sans " + echappeJs(principal.libelle.toLowerCase()) + "', () => {\n" +
      '  const magasin = new Magasin(null);\n' +
      "  assert.throws(() => magasin.ajouter({ ...Magasin.vide(), " + principal.cle + ": '   ' }), /obligatoire/);\n});\n\n" +
      "test('modifie une fiche', () => {\n  const magasin = new Magasin(null);\n" +
      "  const fiche = magasin.ajouter({ ...Magasin.vide(), " + principal.cle + ": 'Avant' });\n" +
      "  magasin.modifier(fiche.id, { " + principal.cle + ": 'Après' });\n" +
      "  assert.equal(magasin.tout().find((f) => f.id === fiche.id)." + principal.cle + ", 'Après');\n});\n\n" +
      "test('supprime une fiche', () => {\n  const magasin = new Magasin(null);\n" +
      "  const fiche = magasin.ajouter({ ...Magasin.vide(), " + principal.cle + ": 'À supprimer' });\n" +
      '  assert.equal(magasin.supprimer(fiche.id), true);\n' +
      "  assert.equal(magasin.supprimer('inexistant'), false);\n});\n\n" +
      "test('recherche par texte', () => {\n  const magasin = new Magasin(null);\n" +
      "  magasin.ajouter({ ...Magasin.vide(), " + principal.cle + ": 'Zibeline particulière' });\n" +
      "  assert.equal(magasin.chercher({ recherche: 'zibeline' }).length, 1);\n" +
      "  assert.equal(magasin.chercher({ recherche: 'introuvable-xyz' }).length, 0);\n});\n\n" +
      "test('trie sans perdre de fiche', () => {\n  const magasin = new Magasin(null);\n" +
      "  assert.equal(magasin.chercher({ ordre: 'desc' }).length, magasin.tout().length);\n});\n" +
      (coche
        ? "\ntest('bascule « " + echappeJs(coche.libelle) + " »', () => {\n  const magasin = new Magasin(null);\n" +
          "  const fiche = magasin.ajouter({ ...Magasin.vide(), " + principal.cle + ": 'Bascule' });\n" +
          '  const avant = fiche.' + coche.cle + ';\n  magasin.basculer(fiche.id);\n' +
          '  assert.equal(magasin.tout().find((f) => f.id === fiche.id).' + coche.cle + ', !avant);\n});\n'
        : '') +
      (filtre && filtre.options.length
        ? "\ntest('filtre par " + echappeJs(filtre.libelle.toLowerCase()) + "', () => {\n" +
          '  const magasin = new Magasin(null);\n' +
          "  const valeur = '" + echappeJs(filtre.options[0]) + "';\n" +
          "  magasin.ajouter({ ...Magasin.vide(), " + principal.cle + ": 'Filtrée', " + filtre.cle + ': valeur });\n' +
          '  const resultats = magasin.chercher({ ' + filtre.cle + ': valeur });\n' +
          '  assert.ok(resultats.every((fiche) => fiche.' + filtre.cle + ' === valeur));\n});\n'
        : '') +
      "\ntest('statistiques cohérentes', () => {\n  const magasin = new Magasin(null);\n" +
      '  assert.equal(magasin.statistiques().total, magasin.tout().length);\n});\n\n' +
      "test('export CSV : une ligne d en-tête plus les fiches', () => {\n  const magasin = new Magasin(null);\n" +
      "  const lignes = magasin.versCsv().split('\\n');\n" +
      '  assert.equal(lignes.length, magasin.tout().length + 1);\n' +
      "  assert.ok(lignes[0].includes('" + echappeJs(principal.libelle) + "'));\n});\n";
  }

  function lisezMoi(spec) {
    return '# ' + spec.titre + '\n\n> Application générée par le moteur de Forge, sans aucune IA, à partir de :\n>\n> « ' +
      spec.demande + ' »\n\nAucune dépendance, aucun réseau. Ouvrez `index.html`, ou lancez les tests.\n\n' +
      '## Champs\n\n| Champ | Clé | Type |\n|---|---|---|\n' +
      spec.champs.map(function (c) { return '| ' + c.libelle + ' | `' + c.cle + '` | ' + c.type + ' |'; }).join('\n') +
      '\n\n## Fonctions\n\n' + spec.fonctions.map(function (f) { return '- ' + f; }).join('\n') +
      '\n\n## Tests\n\n```bash\nnpm test\n```\n\nIls couvrent `store.js`, la logique métier, indépendante de l’affichage.\n';
  }

  /** Renvoie tous les fichiers de l'application : chemin -> contenu. */
  function generer(spec) {
    return {
      'index.html': html(spec),
      'styles.css': css(spec),
      'store.js': store(spec),
      'ui.js': ui(spec),
      'test/store.test.js': tests(spec),
      'package.json': '{\n  "name": "' + identifiant(spec.pluriel).replace(/_/g, '-') +
        '",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {\n    "test": "node --test test/store.test.js"\n  }\n}\n',
      'README.md': lisezMoi(spec),
      '.forge-intent.json': JSON.stringify(spec, null, 2) + '\n',
    };
  }

  var MoteurApp = { analyser: analyser, generer: generer, normalise: normalise, identifiant: identifiant };

  if (typeof module !== 'undefined' && module.exports) module.exports = MoteurApp;
  else racine.MoteurApp = MoteurApp;
})(typeof globalThis !== 'undefined' ? globalThis : this);
