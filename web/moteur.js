/**
 * Moteur de sites — comprendre une phrase française, écrire un site complet.
 *
 * Aucune IA, aucun modèle, aucune clé, aucun appel réseau. Une analyse
 * grammaticale explicite, puis une génération déterministe : la même phrase
 * donne toujours exactement le même site, et ce site est correct par
 * construction.
 *
 * Ce fichier est l'unique implémentation : il tourne dans le navigateur
 * (variable globale `Moteur`) comme sous Node (`require`), ce qui évite deux
 * versions qui divergent.
 */

(function (racine) {
  'use strict';

  // ======================================================================= //
  // Outils de langue
  // ======================================================================= //
  const sansAccents = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const normalise = (t) => sansAccents(String(t || '').toLowerCase()).replace(/\s+/g, ' ').trim();
  const capitale = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

  const MOTS_VIDES = new Set(
    ('un une le la les des de du d l et ou avec pour par sur dans en qui que je veux voudrais ' +
      'souhaite faire creer site web internet page pages mon ma mes notre nos vitrine ligne ' +
      'presentation moderne joli beau belle simple petit petite grand grande')
      .split(' '),
  );

  function pluriel(mot) {
    if (!mot) return mot;
    if (/(s|x|z)$/.test(mot)) return mot;
    if (/al$/.test(mot)) return mot.slice(0, -2) + 'aux';
    if (/(eau|eu)$/.test(mot)) return mot + 'x';
    return mot + 's';
  }

  // ======================================================================= //
  // Vocabulaire : les métiers et activités reconnus
  //
  // Chaque entrée porte le vrai contenu du site : ce que fait l'activité, ses
  // prestations, ses chiffres. C'est ce qui évite le texte creux.
  // ======================================================================= //
  const METIERS = {
    restaurant: {
      mots: ['restaurant', 'bistrot', 'brasserie', 'pizzeria', 'traiteur', 'creperie', 'table'],
      nom: 'Restaurant',
      accroche: 'Une cuisine de saison, préparée chaque matin avec des produits du marché.',
      sections: ['apropos', 'services', 'galerie', 'horaires', 'temoignages', 'contact'],
      titreServices: 'La carte',
      services: [
        ['Entrées', 'Velouté du moment, terrine maison, salade de saison.', '12 €'],
        ['Plats', 'Poisson du jour, viande française, option végétarienne.', '24 €'],
        ['Desserts', 'Tarte du jour, mousse au chocolat, fromages affinés.', '9 €'],
        ['Menu déjeuner', 'Entrée, plat, dessert. Du mardi au vendredi midi.', '22 €'],
      ],
      chiffres: [['depuis', '1998'], ['places', '45'], ['produits locaux', '80 %']],
      galerie: ['La salle', 'Le plat du jour', 'Le comptoir', 'Le dessert'],
    },
    coiffure: {
      mots: ['coiffeur', 'coiffure', 'salon de coiffure', 'barbier', 'barbershop'],
      nom: 'Salon de coiffure',
      accroche: 'Coupes, couleurs et soins, dans un salon calme et lumineux.',
      sections: ['apropos', 'services', 'galerie', 'horaires', 'temoignages', 'contact'],
      titreServices: 'Nos prestations',
      services: [
        ['Coupe femme', 'Diagnostic, shampoing, coupe et coiffage.', '45 €'],
        ['Coupe homme', 'Coupe aux ciseaux ou à la tondeuse, finitions.', '28 €'],
        ['Couleur', 'Coloration végétale ou classique, balayage.', 'dès 60 €'],
        ['Soin profond', 'Rituel réparateur pour cheveux abîmés.', '25 €'],
      ],
      chiffres: [['clients fidèles', '900+'], ['ans d’expérience', '15'], ['note moyenne', '4,9/5']],
      galerie: ['Le salon', 'Un balayage', 'Une coupe courte', 'Le coin soins'],
    },
    photographe: {
      mots: ['photographe', 'photographie', 'studio photo', 'photo'],
      nom: 'Photographe',
      accroche: 'Portraits, mariages et reportages — des images qui vous ressemblent.',
      sections: ['apropos', 'services', 'galerie', 'tarifs', 'temoignages', 'contact'],
      titreServices: 'Prestations',
      services: [
        ['Portrait', 'Séance d’une heure en studio ou en extérieur.', '180 €'],
        ['Mariage', 'Reportage complet, de la préparation à la soirée.', 'dès 1 200 €'],
        ['Entreprise', 'Portraits d’équipe et reportage de vos locaux.', 'sur devis'],
      ],
      chiffres: [['reportages', '250+'], ['ans de métier', '10'], ['photos livrées', '40 000']],
      galerie: ['Portrait en lumière naturelle', 'Cérémonie', 'Détail', 'Paysage'],
    },
    artisan: {
      mots: ['artisan', 'menuisier', 'plombier', 'electricien', 'macon', 'peintre', 'couvreur', 'charpentier'],
      nom: 'Artisan',
      accroche: 'Un travail soigné, un devis clair, des délais tenus.',
      sections: ['apropos', 'services', 'galerie', 'temoignages', 'faq', 'contact'],
      titreServices: 'Nos interventions',
      services: [
        ['Dépannage', 'Intervention rapide, diagnostic et réparation.', 'dès 80 €'],
        ['Rénovation', 'Devis détaillé, chantier suivi de bout en bout.', 'sur devis'],
        ['Installation neuve', 'Pose aux normes, garantie décennale.', 'sur devis'],
      ],
      chiffres: [['chantiers', '400+'], ['ans d’activité', '20'], ['garantie', '10 ans']],
      galerie: ['Un chantier terminé', 'L’atelier', 'Avant / après', 'Les finitions'],
    },
    boutique: {
      mots: ['boutique', 'magasin', 'commerce', 'epicerie', 'librairie', 'fleuriste', 'boulangerie', 'concept store'],
      nom: 'Boutique',
      accroche: 'Une sélection choisie avec soin, à retrouver en boutique.',
      sections: ['apropos', 'services', 'galerie', 'horaires', 'temoignages', 'contact'],
      titreServices: 'La sélection',
      services: [
        ['Nouveautés', 'Les arrivages de la semaine, en quantité limitée.', ''],
        ['Les intemporels', 'Ce que nos clients redemandent toute l’année.', ''],
        ['Cartes cadeaux', 'À offrir, valables un an sur tout le magasin.', 'dès 20 €'],
      ],
      chiffres: [['références', '1 200'], ['ans dans le quartier', '8'], ['producteurs', '30']],
      galerie: ['La vitrine', 'Les rayons', 'Un produit', 'L’équipe'],
    },
    cabinet: {
      mots: ['cabinet', 'avocat', 'notaire', 'medecin', 'dentiste', 'kine', 'osteopathe', 'psychologue', 'comptable'],
      nom: 'Cabinet',
      accroche: 'Un accompagnement attentif, une réponse claire à chaque question.',
      sections: ['apropos', 'services', 'equipe', 'horaires', 'faq', 'contact'],
      titreServices: 'Domaines d’intervention',
      services: [
        ['Premier rendez-vous', 'Écoute, bilan de votre situation, orientation.', '60 €'],
        ['Suivi', 'Un point régulier, adapté à votre rythme.', '55 €'],
        ['Urgences', 'Créneaux réservés chaque jour pour les cas pressants.', ''],
      ],
      chiffres: [['dossiers suivis', '1 500'], ['ans d’exercice', '18'], ['délai moyen', '48 h']],
      galerie: [],
    },
    association: {
      mots: ['association', 'club', 'collectif', 'ong', 'amicale', 'federation'],
      nom: 'Association',
      accroche: 'Une équipe de bénévoles, des actions concrètes, près de chez vous.',
      sections: ['apropos', 'services', 'equipe', 'actualites', 'temoignages', 'contact'],
      titreServices: 'Nos actions',
      services: [
        ['Ateliers', 'Chaque semaine, ouverts à tous, sans inscription.', 'gratuit'],
        ['Événements', 'Rencontres, sorties et temps forts dans l’année.', ''],
        ['Adhésion', 'Soutenez nos actions et participez aux décisions.', '15 €/an'],
      ],
      chiffres: [['adhérents', '320'], ['bénévoles', '45'], ['actions par an', '60']],
      galerie: ['Un atelier', 'La dernière sortie', 'L’équipe', 'Le local'],
    },
    hebergement: {
      mots: ['hotel', 'gite', 'chambre d hotes', 'camping', 'auberge', 'location saisonniere'],
      nom: 'Hébergement',
      accroche: 'Un lieu calme pour poser ses valises, à deux pas de l’essentiel.',
      sections: ['apropos', 'services', 'galerie', 'tarifs', 'temoignages', 'faq', 'contact'],
      titreServices: 'Les chambres',
      services: [
        ['Chambre double', 'Lit queen size, salle d’eau privative, vue jardin.', '95 €/nuit'],
        ['Suite familiale', 'Deux chambres communicantes, jusqu’à 4 personnes.', '150 €/nuit'],
        ['Petit-déjeuner', 'Produits maison et fruits de saison, servi de 7 h à 10 h.', '12 €'],
      ],
      chiffres: [['chambres', '9'], ['note voyageurs', '9,2/10'], ['ans d’accueil', '12']],
      galerie: ['La chambre', 'Le petit-déjeuner', 'Le jardin', 'Les environs'],
    },
    ecole: {
      mots: ['ecole', 'formation', 'cours', 'professeur', 'auto ecole', 'creche', 'centre de formation'],
      nom: 'École',
      accroche: 'Apprendre à son rythme, avec des enseignants disponibles.',
      sections: ['apropos', 'services', 'tarifs', 'equipe', 'faq', 'contact'],
      titreServices: 'Les formations',
      services: [
        ['Cours collectif', 'Petits groupes de 8 personnes maximum.', '25 €/h'],
        ['Cours particulier', 'Programme construit avec vous, à la carte.', '45 €/h'],
        ['Stage intensif', 'Une semaine complète pendant les vacances.', '320 €'],
      ],
      chiffres: [['élèves formés', '2 000+'], ['taux de réussite', '94 %'], ['enseignants', '12']],
      galerie: [],
    },
    portfolio: {
      mots: ['portfolio', 'book', 'cv', 'developpeur', 'designer', 'graphiste', 'illustrateur', 'freelance', 'consultant'],
      nom: 'Portfolio',
      accroche: 'Quelques projets récents, et la façon dont je travaille.',
      sections: ['apropos', 'services', 'galerie', 'temoignages', 'contact'],
      titreServices: 'Ce que je fais',
      services: [
        ['Conception', 'Cadrage du besoin, maquettes, allers-retours courts.', ''],
        ['Réalisation', 'Développement soigné, testé, documenté.', ''],
        ['Accompagnement', 'Formation de vos équipes et suivi après livraison.', ''],
      ],
      chiffres: [['projets livrés', '60'], ['ans d’expérience', '9'], ['clients fidèles', '80 %']],
      galerie: ['Projet récent', 'Étude de cas', 'Détail d’interface', 'Croquis'],
    },
    garage: {
      mots: ['garage', 'mecanicien', 'carrosserie', 'concession', 'reparation automobile'],
      nom: 'Garage',
      accroche: 'Entretien, réparation et contrôle : votre véhicule entre de bonnes mains.',
      sections: ['apropos', 'services', 'tarifs', 'horaires', 'temoignages', 'contact'],
      titreServices: 'Nos prestations',
      services: [
        ['Révision', 'Vidange, filtres, contrôle des 30 points de sécurité.', 'dès 149 €'],
        ['Pneumatiques', 'Montage, équilibrage et géométrie.', 'dès 45 €/pneu'],
        ['Carrosserie', 'Débosselage, peinture, prêt de véhicule.', 'sur devis'],
      ],
      chiffres: [['véhicules par an', '1 800'], ['ans d’activité', '25'], ['prêt de véhicule', 'offert']],
      galerie: ['L’atelier', 'Le banc de diagnostic', 'La cabine peinture', 'L’accueil'],
    },
    evenement: {
      mots: ['evenement', 'mariage', 'festival', 'conference', 'salon', 'seminaire', 'concert', 'spectacle'],
      nom: 'Événement',
      accroche: 'Le programme, le lieu, et tout ce qu’il faut savoir avant de venir.',
      sections: ['apropos', 'programme', 'services', 'tarifs', 'faq', 'contact'],
      titreServices: 'Au programme',
      services: [
        ['Ouverture', 'Accueil du public et mot d’introduction.', '9 h 00'],
        ['Temps forts', 'Interventions, ateliers et démonstrations.', '10 h – 17 h'],
        ['Clôture', 'Table ronde puis moment convivial.', '18 h 00'],
      ],
      chiffres: [['participants attendus', '600'], ['intervenants', '24'], ['éditions', '7e']],
      galerie: ['L’édition précédente', 'La salle', 'Le public', 'Les coulisses'],
    },
    immobilier: {
      mots: ['immobilier', 'agence immobiliere', 'agent immobilier', 'syndic'],
      nom: 'Agence immobilière',
      accroche: 'Acheter, vendre ou louer, accompagné à chaque étape.',
      sections: ['apropos', 'services', 'galerie', 'temoignages', 'faq', 'contact'],
      titreServices: 'Nos services',
      services: [
        ['Estimation', 'Un avis de valeur argumenté, sous 48 heures.', 'offerte'],
        ['Vente', 'Photos professionnelles, visites organisées, suivi notaire.', 'sur devis'],
        ['Location', 'Sélection des dossiers, état des lieux, gestion.', '']
      ],
      chiffres: [['biens vendus', '350'], ['délai moyen', '62 jours'], ['ans dans le secteur', '16']],
      galerie: ['Un bien en vente', 'Un séjour', 'Une cuisine', 'Le quartier'],
    },
    bienetre: {
      mots: ['institut', 'spa', 'massage', 'yoga', 'esthetique', 'bien etre', 'naturopathe', 'sophrologue'],
      nom: 'Institut',
      accroche: 'Une parenthèse pour souffler, dans un lieu apaisant.',
      sections: ['apropos', 'services', 'galerie', 'tarifs', 'horaires', 'temoignages', 'contact'],
      titreServices: 'Les soins',
      services: [
        ['Massage relaxant', 'Une heure pour relâcher les tensions.', '70 €'],
        ['Soin du visage', 'Diagnostic de peau puis soin sur mesure.', '65 €'],
        ['Forfait découverte', 'Trois séances à utiliser dans l’année.', '180 €'],
      ],
      chiffres: [['clientes fidèles', '600'], ['ans d’ouverture', '7'], ['note moyenne', '4,8/5']],
      galerie: ['La cabine', 'L’accueil', 'Les produits', 'L’espace détente'],
    },
    sport: {
      mots: ['salle de sport', 'club de sport', 'coach', 'fitness', 'crossfit', 'danse', 'piscine', 'tennis'],
      nom: 'Club',
      accroche: 'Des séances encadrées, quel que soit votre niveau de départ.',
      sections: ['apropos', 'services', 'tarifs', 'horaires', 'equipe', 'temoignages', 'contact'],
      titreServices: 'Les cours',
      services: [
        ['Cours collectif', 'Renforcement, cardio et mobilité, 45 minutes.', 'inclus'],
        ['Coaching individuel', 'Programme personnalisé et suivi mensuel.', '50 €/séance'],
        ['Accès libre', 'Salle ouverte du lundi au dimanche.', '']
      ],
      chiffres: [['adhérents', '480'], ['cours par semaine', '35'], ['coachs diplômés', '6']],
      galerie: ['La salle', 'Un cours collectif', 'Le matériel', 'Les vestiaires'],
    },
    generique: {
      mots: [],
      nom: 'Activité',
      accroche: 'Découvrez ce que nous faisons, et comment nous joindre.',
      sections: ['apropos', 'services', 'temoignages', 'contact'],
      titreServices: 'Nos services',
      services: [
        ['Premier contact', 'Nous prenons le temps de comprendre votre besoin.', ''],
        ['Réalisation', 'Un travail soigné, avec des points d’étape réguliers.', ''],
        ['Suivi', 'Nous restons disponibles après la livraison.', ''],
      ],
      chiffres: [['clients', '200+'], ['ans d’activité', '10'], ['satisfaction', '96 %']],
      galerie: ['Notre travail', 'L’équipe', 'Les locaux', 'Un détail'],
    },
  };

  // ======================================================================= //
  // Sections disponibles, et les mots qui les réclament
  // ======================================================================= //
  const SECTIONS = {
    apropos: ['a propos', 'presentation', 'qui sommes nous', 'histoire', 'notre equipe'],
    services: ['services', 'prestations', 'offre', 'carte', 'menu', 'produits', 'catalogue', 'programme'],
    galerie: ['galerie', 'photos', 'images', 'realisations', 'portfolio', 'book'],
    tarifs: ['tarifs', 'prix', 'formules', 'abonnements', 'forfaits'],
    temoignages: ['temoignages', 'avis', 'clients', 'recommandations'],
    equipe: ['equipe', 'membres', 'collaborateurs', 'associes'],
    horaires: ['horaires', 'ouverture', 'jours', 'planning'],
    faq: ['faq', 'questions', 'foire aux questions'],
    actualites: ['actualites', 'blog', 'news', 'journal', 'agenda'],
    programme: ['programme', 'deroule', 'planning detaille'],
    contact: ['contact', 'formulaire', 'nous joindre', 'devis', 'reservation', 'rendez vous'],
    newsletter: ['newsletter', 'infolettre', 'inscription'],
  };

  const AMBIANCES = {
    sobre: ['sobre', 'epure', 'minimaliste', 'simple', 'professionnel', 'serieux'],
    chaleureux: ['chaleureux', 'convivial', 'accueillant', 'familial', 'authentique'],
    elegant: ['elegant', 'chic', 'luxe', 'raffine', 'haut de gamme', 'premium'],
    vif: ['colore', 'vif', 'dynamique', 'jeune', 'moderne', 'punchy', 'energique'],
    nature: ['nature', 'bio', 'vert', 'ecologique', 'zen', 'naturel'],
  };

  const PALETTES = {
    sobre: { accent: '#2f5d8a', accent2: '#1d3b58', fond: '#f6f7f9', encre: '#1b2430', nuance: '#e6eaef' },
    chaleureux: { accent: '#c1562d', accent2: '#8a3a1c', fond: '#fbf6f0', encre: '#2c2119', nuance: '#f0e3d6' },
    elegant: { accent: '#8a7a4e', accent2: '#5c5031', fond: '#f8f7f4', encre: '#22201b', nuance: '#e9e5dc' },
    vif: { accent: '#7c3aed', accent2: '#4c1d95', fond: '#f8f7ff', encre: '#1e1b2e', nuance: '#e9e4fb' },
    nature: { accent: '#3f7a52', accent2: '#285236', fond: '#f5f8f4', encre: '#1c2620', nuance: '#e0ebe1' },
  };

  // ======================================================================= //
  // Analyse : de la phrase vers une spécification de site
  // ======================================================================= //
  function trouveMetier(plat) {
    let meilleur = null;
    let position = Infinity;
    for (const [cle, metier] of Object.entries(METIERS)) {
      for (const mot of metier.mots) {
        const trouve = plat.indexOf(normalise(mot));
        if (trouve !== -1 && trouve < position) {
          meilleur = cle;
          position = trouve;
        }
      }
    }
    return meilleur || 'generique';
  }

  function trouveNom(phrase, plat) {
    // « pour la boulangerie Chez Paul », « du restaurant Le Tilleul »
    const guillemets = phrase.match(/[«"']\s*([^«»"']{2,40})\s*[»"']/);
    if (guillemets) return guillemets[1].trim();

    const appele = phrase.match(/\b(?:appel[ée]e?|nomm[ée]e?|qui s'appelle|du nom de)\s+([^,.]{2,40})/i);
    if (appele) return appele[1].trim();

    // Un nom propre : deux mots capitalisés d'affilée, hors début de phrase.
    const propre = phrase.match(/\b([A-ZÀ-Ý][\wÀ-ÿ'-]+(?:\s+[A-ZÀ-Ý][\wÀ-ÿ'-]+){0,2})\b/g);
    if (propre) {
      for (const candidat of propre) {
        if (!MOTS_VIDES.has(normalise(candidat)) && normalise(candidat) !== plat.split(' ')[0]) {
          if (candidat.length > 2 && !/^(Je|Un|Une|Le|La|Les|Site|Mon)$/i.test(candidat)) return candidat;
        }
      }
    }
    return null;
  }

  function trouveSections(plat, metier) {
    const demandees = [];
    for (const [nom, mots] of Object.entries(SECTIONS)) {
      if (mots.some((m) => plat.includes(normalise(m)))) demandees.push(nom);
    }
    // Ce qui est demandé s'AJOUTE à ce que le métier appelle naturellement :
    // demander « avec les horaires » ne doit pas amputer le reste du site.
    const toutes = new Set([...METIERS[metier].sections, ...demandees, 'contact']);
    // Ordre stable : c'est celui qui donne une page cohérente.
    const ordre = ['apropos', 'services', 'programme', 'galerie', 'tarifs', 'equipe', 'temoignages', 'horaires', 'actualites', 'faq', 'newsletter', 'contact'];
    return ordre.filter((s) => toutes.has(s));
  }

  function trouveAmbiance(plat, metier) {
    for (const [nom, mots] of Object.entries(AMBIANCES)) {
      if (mots.some((m) => new RegExp(`\\b${m}\\b`).test(plat))) return nom;
    }
    return { restaurant: 'chaleureux', bienetre: 'nature', portfolio: 'sobre', evenement: 'vif',
      hebergement: 'nature', boutique: 'chaleureux', cabinet: 'sobre', immobilier: 'sobre',
      photographe: 'elegant', sport: 'vif' }[metier] || 'sobre';
  }

  function trouveVille(phrase) {
    // Pas de `\b` devant « à » : en JavaScript, les limites de mot ignorent
    // les lettres accentuées, et « à Annecy » ne serait jamais reconnu.
    const trouve = phrase.match(
      /(?:^|\s)(?:à|a|de|sur|en)\s+([A-ZÀ-Ý][\wÀ-ÿ'-]+(?:[- ][A-ZÀ-Ý][\wÀ-ÿ'-]+)?)/,
    );
    return trouve ? trouve[1] : null;
  }

  /** Analyse une demande et renvoie la spécification du site. */
  function analyser(phrase) {
    const brute = String(phrase || '').trim();
    if (brute.length < 3) throw new Error('Décrivez le site en quelques mots.');

    const plat = normalise(brute);
    const metierCle = trouveMetier(plat);
    const metier = METIERS[metierCle];
    const sections = trouveSections(plat, metierCle);
    const ambiance = trouveAmbiance(plat, metierCle);
    const ville = trouveVille(brute);
    const nom = trouveNom(brute, plat) || metier.nom;

    const multipage = /\b(plusieurs pages|multipage|multi page|pages separees|une page par)\b/.test(plat);

    const compris = [`activité : ${metier.nom}`, `${sections.length} sections`, `ambiance ${ambiance}`];
    let confiance = 0.45;
    if (metierCle !== 'generique') confiance += 0.3;
    if (trouveNom(brute, plat)) confiance += 0.15;
    if (sections.length > 4) confiance += 0.1;

    return {
      demande: brute,
      nom,
      metier: metierCle,
      metierNom: metier.nom,
      accroche: metier.accroche,
      sections,
      ambiance,
      ville,
      multipage,
      compris,
      confiance: Math.min(1, confiance),
    };
  }

  // ======================================================================= //
  // Génération : de la spécification vers les fichiers du site
  // ======================================================================= //
  const echapper = (t) =>
    String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const identifiant = (t) =>
    normalise(t).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';

  /** Illustration SVG intégrée : aucune image distante, donc aucun appel réseau. */
  function illustration(titre, palette, graine) {
    const n = [...String(titre)].reduce((s, c) => s + c.charCodeAt(0), graine);
    const formes = [];
    for (let i = 0; i < 5; i++) {
      const x = (n * (i + 3)) % 320;
      const y = (n * (i + 7)) % 180;
      const r = 30 + ((n * (i + 2)) % 60);
      const couleur = i % 2 ? palette.accent : palette.accent2;
      const opacite = (0.12 + ((n + i) % 5) * 0.05).toFixed(2);
      formes.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${couleur}" opacity="${opacite}"/>`);
    }
    return (
      `<svg viewBox="0 0 360 200" role="img" aria-label="${echapper(titre)}" preserveAspectRatio="xMidYMid slice">` +
      `<rect width="360" height="200" fill="${palette.nuance}"/>${formes.join('')}` +
      `<text x="180" y="108" text-anchor="middle" font-family="system-ui,sans-serif" font-size="15" fill="${palette.encre}" opacity="0.72">${echapper(titre)}</text>` +
      `</svg>`
    );
  }

  // --------------------------------------------------------------- sections
  const BLOCS = {
    apropos(spec, m, p) {
      return `    <section id="apropos" class="section">
      <div class="conteneur duo">
        <div>
          <p class="oeil">À propos</p>
          <h2>Notre maison, en quelques mots</h2>
          <p>${echapper(m.accroche)} ${spec.ville ? `Nous vous accueillons à ${echapper(spec.ville)}.` : ''}</p>
          <p>Ce qui compte pour nous : un travail bien fait, des explications claires, et des
            personnes qui reviennent parce qu’elles ont été bien reçues.</p>
          <ul class="atouts">
            <li>Un interlocuteur unique, du premier contact à la fin</li>
            <li>Des tarifs annoncés à l’avance, sans surprise</li>
            <li>Une réponse à toute demande sous 24 heures ouvrées</li>
          </ul>
        </div>
        <figure class="illustration">${illustration('Notre équipe', p, 11)}</figure>
      </div>
    </section>`;
    },

    services(spec, m, p) {
      const cartes = m.services
        .map(
          ([titre, texte, prix]) => `          <article class="carte">
            <h3>${echapper(titre)}</h3>
            <p>${echapper(texte)}</p>
            ${prix ? `<p class="prix">${echapper(prix)}</p>` : ''}
          </article>`,
        )
        .join('\n');
      return `    <section id="services" class="section alterne">
      <div class="conteneur">
        <p class="oeil">${echapper(m.titreServices)}</p>
        <h2>Ce que nous proposons</h2>
        <div class="grille">
${cartes}
        </div>
      </div>
    </section>`;
    },

    programme(spec, m, p) {
      const lignes = m.services
        .map(([titre, texte, heure]) => `          <li><strong>${echapper(heure || '—')}</strong><div><b>${echapper(titre)}</b><p>${echapper(texte)}</p></div></li>`)
        .join('\n');
      return `    <section id="programme" class="section">
      <div class="conteneur">
        <p class="oeil">Programme</p>
        <h2>Le déroulé de la journée</h2>
        <ol class="chrono">
${lignes}
        </ol>
      </div>
    </section>`;
    },

    galerie(spec, m, p) {
      const titres = m.galerie.length ? m.galerie : METIERS.generique.galerie;
      const images = titres
        .map((t, i) => `          <figure class="vignette">${illustration(t, p, i * 17 + 3)}<figcaption>${echapper(t)}</figcaption></figure>`)
        .join('\n');
      return `    <section id="galerie" class="section alterne">
      <div class="conteneur">
        <p class="oeil">Galerie</p>
        <h2>En images</h2>
        <div class="galerie">
${images}
        </div>
      </div>
    </section>`;
    },

    tarifs(spec, m, p) {
      const formules = [
        ['Essentiel', m.services[0] ? m.services[0][2] || '29 €' : '29 €', ['Prestation de base', 'Réponse sous 48 h', 'Sans engagement']],
        ['Confort', m.services[1] ? m.services[1][2] || '59 €' : '59 €', ['Tout l’Essentiel', 'Suivi personnalisé', 'Priorité de rendez-vous']],
        ['Complet', 'sur devis', ['Tout le Confort', 'Accompagnement sur mesure', 'Interlocuteur dédié']],
      ];
      const cartes = formules
        .map(
          ([nom, prix, points], i) => `          <article class="formule${i === 1 ? ' mise-en-avant' : ''}">
            ${i === 1 ? '<p class="ruban">Le plus choisi</p>' : ''}
            <h3>${echapper(nom)}</h3>
            <p class="montant">${echapper(prix)}</p>
            <ul>${points.map((pt) => `<li>${echapper(pt)}</li>`).join('')}</ul>
            <a class="bouton${i === 1 ? '' : ' fantome'}" href="#contact">Demander</a>
          </article>`,
        )
        .join('\n');
      return `    <section id="tarifs" class="section">
      <div class="conteneur">
        <p class="oeil">Tarifs</p>
        <h2>Des formules lisibles</h2>
        <div class="formules">
${cartes}
        </div>
      </div>
    </section>`;
    },

    equipe(spec, m, p) {
      const membres = [
        ['Camille Ferrand', 'Responsable', 'Coordonne l’équipe et suit chaque dossier.'],
        ['Nadia Belkacem', 'Spécialiste', 'Douze ans de métier, formatrice à ses heures.'],
        ['Thomas Rivet', 'Accueil', 'Votre premier contact, au téléphone comme sur place.'],
      ];
      const cartes = membres
        .map(
          ([nom, role, texte], i) => `          <article class="membre">
            <div class="portrait">${illustration(nom.split(' ')[0], p, i * 23 + 5)}</div>
            <h3>${echapper(nom)}</h3>
            <p class="role">${echapper(role)}</p>
            <p>${echapper(texte)}</p>
          </article>`,
        )
        .join('\n');
      return `    <section id="equipe" class="section alterne">
      <div class="conteneur">
        <p class="oeil">L’équipe</p>
        <h2>Les personnes que vous rencontrerez</h2>
        <div class="grille">
${cartes}
        </div>
      </div>
    </section>`;
    },

    temoignages(spec, m, p) {
      const avis = [
        ['« Accueil impeccable et travail soigné. Je recommande sans hésiter. »', 'Élodie M.'],
        ['« Devis clair, délais tenus, résultat au-delà de mes attentes. »', 'Karim B.'],
        ['« On se sent écouté. C’est rare, et ça change tout. »', 'Sophie L.'],
      ];
      const cartes = avis
        .map(([texte, auteur]) => `          <blockquote class="avis"><p>${echapper(texte)}</p><cite>${echapper(auteur)}</cite></blockquote>`)
        .join('\n');
      return `    <section id="temoignages" class="section">
      <div class="conteneur">
        <p class="oeil">Avis</p>
        <h2>Ce qu’en disent nos clients</h2>
        <div class="grille">
${cartes}
        </div>
      </div>
    </section>`;
    },

    horaires(spec, m, p) {
      const jours = [
        ['Lundi', 'Fermé'], ['Mardi', '9 h – 19 h'], ['Mercredi', '9 h – 19 h'],
        ['Jeudi', '9 h – 19 h'], ['Vendredi', '9 h – 20 h'], ['Samedi', '9 h – 18 h'], ['Dimanche', 'Fermé'],
      ];
      const lignes = jours
        .map(([j, h]) => `            <tr><th scope="row">${j}</th><td${h === 'Fermé' ? ' class="ferme"' : ''}>${h}</td></tr>`)
        .join('\n');
      return `    <section id="horaires" class="section alterne">
      <div class="conteneur etroit">
        <p class="oeil">Horaires</p>
        <h2>Quand nous trouver</h2>
        <table class="horaires">
          <tbody>
${lignes}
          </tbody>
        </table>
      </div>
    </section>`;
    },

    actualites(spec, m, p) {
      const billets = [
        ['Ce qui change ce mois-ci', '12 mars 2026', 'De nouveaux créneaux ouvrent le samedi matin.'],
        ['Retour sur notre dernière rencontre', '2 février 2026', 'Merci aux quatre-vingts personnes présentes.'],
        ['Nous recrutons', '18 janvier 2026', 'Un poste à pourvoir, en CDI, dès le printemps.'],
      ];
      const cartes = billets
        .map(([titre, date, texte]) => `          <article class="billet">
            <time datetime="2026-01-01">${echapper(date)}</time>
            <h3>${echapper(titre)}</h3>
            <p>${echapper(texte)}</p>
          </article>`)
        .join('\n');
      return `    <section id="actualites" class="section">
      <div class="conteneur">
        <p class="oeil">Actualités</p>
        <h2>Les dernières nouvelles</h2>
        <div class="grille">
${cartes}
        </div>
      </div>
    </section>`;
    },

    faq(spec, m, p) {
      const questions = [
        ['Faut-il prendre rendez-vous ?', 'C’est préférable pour être sûr d’avoir un créneau, mais nous acceptons les visites sans rendez-vous selon les disponibilités.'],
        ['Quels moyens de paiement acceptez-vous ?', 'Carte bancaire, espèces et virement. Le paiement en trois fois est possible au-delà de 300 €.'],
        ['Combien de temps faut-il prévoir ?', 'Comptez une heure pour un premier rendez-vous. Nous vous prévenons si cela doit être plus long.'],
        ['Intervenez-vous en dehors de la ville ?', 'Oui, dans un rayon de trente kilomètres. Au-delà, un forfait déplacement s’applique.'],
      ];
      const items = questions
        .map(([q, r]) => `          <details class="question">
            <summary>${echapper(q)}</summary>
            <p>${echapper(r)}</p>
          </details>`)
        .join('\n');
      return `    <section id="faq" class="section alterne">
      <div class="conteneur etroit">
        <p class="oeil">Questions fréquentes</p>
        <h2>Vous vous demandez peut-être…</h2>
${items}
      </div>
    </section>`;
    },

    newsletter(spec, m, p) {
      return `    <section id="newsletter" class="section">
      <div class="conteneur etroit centre">
        <h2>Rester informé</h2>
        <p>Une lettre courte, une fois par mois. Désinscription en un clic.</p>
        <form class="ligne" id="newsletter-form" novalidate>
          <label class="visuellement-cache" for="newsletter-email">Adresse e-mail</label>
          <input type="email" id="newsletter-email" name="email" placeholder="vous@exemple.fr" required />
          <button type="submit" class="bouton">S’inscrire</button>
        </form>
        <p class="retour" id="newsletter-retour" role="status"></p>
      </div>
    </section>`;
    },

    contact(spec, m, p) {
      const ville = spec.ville ? echapper(spec.ville) : 'Votre ville';
      return `    <section id="contact" class="section alterne">
      <div class="conteneur duo">
        <div>
          <p class="oeil">Contact</p>
          <h2>Écrivez-nous</h2>
          <p>Une question, un devis, un rendez-vous : ce formulaire arrive directement chez nous.</p>
          <ul class="coordonnees">
            <li><strong>Adresse</strong><br />12 rue de l’Exemple, ${ville}</li>
            <li><strong>Téléphone</strong><br /><a href="tel:+33123456789">01 23 45 67 89</a></li>
            <li><strong>E-mail</strong><br /><a href="mailto:bonjour@exemple.fr">bonjour@exemple.fr</a></li>
          </ul>
        </div>

        <form id="contact-form" class="formulaire" novalidate>
          <label for="nom">Votre nom
            <input type="text" id="nom" name="nom" required autocomplete="name" />
          </label>
          <label for="email">Votre e-mail
            <input type="email" id="email" name="email" required autocomplete="email" />
          </label>
          <label for="sujet">Sujet
            <select id="sujet" name="sujet">
              <option>Demande d’information</option>
              <option>Demande de devis</option>
              <option>Prise de rendez-vous</option>
              <option>Autre</option>
            </select>
          </label>
          <label for="message">Votre message
            <textarea id="message" name="message" rows="5" required></textarea>
          </label>
          <button type="submit" class="bouton">Envoyer</button>
          <p class="retour" id="contact-retour" role="status"></p>
        </form>
      </div>
    </section>`;
    },
  };

  const TITRES_NAV = {
    apropos: 'À propos', services: 'Services', programme: 'Programme', galerie: 'Galerie',
    tarifs: 'Tarifs', equipe: 'Équipe', temoignages: 'Avis', horaires: 'Horaires',
    actualites: 'Actualités', faq: 'FAQ', newsletter: 'Newsletter', contact: 'Contact',
  };

  // ------------------------------------------------------------------ pages
  function html(spec) {
    const m = METIERS[spec.metier];
    const p = PALETTES[spec.ambiance];
    const nom = echapper(spec.nom);

    const nav = spec.sections
      .map((s) => `          <li><a href="#${s}">${TITRES_NAV[s]}</a></li>`)
      .join('\n');

    const chiffres = m.chiffres
      .map(([libelle, valeur]) => `          <div><b>${echapper(valeur)}</b><span>${echapper(libelle)}</span></div>`)
      .join('\n');

    const corps = spec.sections.map((s) => BLOCS[s](spec, m, p)).join('\n\n');

    return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${nom}${spec.ville ? ` — ${echapper(spec.ville)}` : ''}</title>
    <meta name="description" content="${echapper(m.accroche)}" />
    <meta property="og:title" content="${nom}" />
    <meta property="og:description" content="${echapper(m.accroche)}" />
    <meta property="og:type" content="website" />
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <a class="saut" href="#contenu">Aller au contenu</a>

    <header class="entete">
      <div class="conteneur barre">
        <a class="logo" href="#accueil">${nom}</a>
        <button class="menu" id="menu" aria-expanded="false" aria-controls="navigation">Menu</button>
        <nav id="navigation" aria-label="Navigation principale">
          <ul>
${nav}
          </ul>
        </nav>
      </div>
    </header>

    <main id="contenu">
      <section id="accueil" class="heros">
        <div class="conteneur">
          <h1>${nom}</h1>
          <p class="accroche">${echapper(m.accroche)}</p>
          <p class="actions">
            <a class="bouton" href="#contact">Nous contacter</a>
            <a class="bouton fantome" href="#${spec.sections[0] || 'contact'}">En savoir plus</a>
          </p>
        </div>
      </section>

      <section class="chiffres">
        <div class="conteneur">
${chiffres}
        </div>
      </section>

${corps}
    </main>

    <footer class="pied">
      <div class="conteneur">
        <p><strong>${nom}</strong>${spec.ville ? ` · ${echapper(spec.ville)}` : ''}</p>
        <p class="mentions">Mentions légales · Politique de confidentialité · © <span id="annee"></span> ${nom}</p>
      </div>
    </footer>

    <script src="script.js"></script>
  </body>
</html>
`;
  }

  function css(spec) {
    const p = PALETTES[spec.ambiance];
    return `/* ${spec.nom} — feuille de style générée. Aucune ressource distante. */

:root {
  --accent: ${p.accent};
  --accent-fonce: ${p.accent2};
  --fond: ${p.fond};
  --surface: #ffffff;
  --encre: ${p.encre};
  --encre-douce: #5a6472;
  --nuance: ${p.nuance};
  --trait: #dfe3e8;
  --rayon: 12px;
  --ombre: 0 1px 2px rgba(16, 24, 32, 0.05), 0 12px 30px -20px rgba(16, 24, 32, 0.45);
}

@media (prefers-color-scheme: dark) {
  :root {
    --fond: #14181d;
    --surface: #1c2229;
    --encre: #e9edf2;
    --encre-douce: #a8b3c0;
    --nuance: #232b34;
    --trait: #2e3742;
    --ombre: 0 1px 2px rgba(0, 0, 0, 0.4), 0 12px 30px -20px rgba(0, 0, 0, 0.8);
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--fond);
  color: var(--encre);
  font: 16px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}

.conteneur { width: min(1080px, 100% - 40px); margin-inline: auto; }
.conteneur.etroit { width: min(720px, 100% - 40px); }
.centre { text-align: center; }

h1, h2, h3 { line-height: 1.2; text-wrap: balance; margin: 0 0 12px; }
h1 { font-size: clamp(30px, 5vw, 48px); letter-spacing: -0.02em; }
h2 { font-size: clamp(23px, 3vw, 31px); }
h3 { font-size: 18px; }
p { margin: 0 0 14px; }

a { color: var(--accent); }

.saut {
  position: absolute; left: -9999px; top: 0; background: var(--accent); color: #fff;
  padding: 10px 16px; z-index: 10;
}
.saut:focus { left: 8px; top: 8px; }

:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }

.visuellement-cache {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap;
}

/* ---------------------------------------------------------- en-tête */
.entete {
  position: sticky; top: 0; z-index: 5;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--trait);
}
.barre { display: flex; align-items: center; gap: 16px; min-height: 62px; }
.logo { font-weight: 700; font-size: 18px; color: inherit; text-decoration: none; }

.entete nav ul {
  list-style: none; display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 0 auto; padding: 0;
}
.entete nav a {
  display: block; padding: 8px 11px; border-radius: 8px; color: var(--encre-douce);
  text-decoration: none; font-size: 14.5px;
}
.entete nav a:hover { background: var(--nuance); color: var(--encre); }

.menu {
  display: none; margin-left: auto; font: inherit; font-size: 14px;
  background: var(--nuance); color: var(--encre); border: 1px solid var(--trait);
  border-radius: 8px; padding: 8px 14px; cursor: pointer;
}

@media (max-width: 760px) {
  .menu { display: block; }
  .entete nav { display: none; width: 100%; }
  .entete nav.ouvert { display: block; }
  .barre { flex-wrap: wrap; padding-bottom: 10px; }
  .entete nav ul { flex-direction: column; margin: 0; }
}

/* ------------------------------------------------------------- héros */
.heros {
  padding: clamp(56px, 10vw, 104px) 0;
  background:
    radial-gradient(1000px 400px at 12% -10%, color-mix(in srgb, var(--accent) 16%, transparent), transparent),
    var(--nuance);
  border-bottom: 1px solid var(--trait);
}
.accroche { font-size: clamp(17px, 2.2vw, 20px); color: var(--encre-douce); max-width: 60ch; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }

.bouton {
  display: inline-block; background: var(--accent); color: #fff; text-decoration: none;
  padding: 12px 22px; border-radius: 999px; font-weight: 600; border: 1px solid var(--accent);
  cursor: pointer; font-size: 15px;
}
.bouton:hover { background: var(--accent-fonce); border-color: var(--accent-fonce); }
.bouton.fantome { background: transparent; color: var(--accent); }
.bouton.fantome:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }

/* ---------------------------------------------------------- chiffres */
.chiffres { background: var(--surface); border-bottom: 1px solid var(--trait); }
.chiffres .conteneur {
  display: flex; flex-wrap: wrap; gap: 32px; justify-content: space-around; padding: 26px 20px;
}
.chiffres b { display: block; font-size: 26px; color: var(--accent); }
.chiffres span { font-size: 13.5px; color: var(--encre-douce); }

/* ---------------------------------------------------------- sections */
.section { padding: clamp(44px, 7vw, 76px) 0; }
.section.alterne { background: var(--surface); border-block: 1px solid var(--trait); }

.oeil {
  text-transform: uppercase; letter-spacing: 0.12em; font-size: 12px;
  color: var(--accent); font-weight: 700; margin-bottom: 6px;
}

.duo { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; align-items: center; }
@media (max-width: 820px) { .duo { grid-template-columns: 1fr; } }

.grille { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 18px; }

.carte, .avis, .membre, .billet {
  background: var(--fond); border: 1px solid var(--trait); border-radius: var(--rayon); padding: 20px;
}
.section.alterne .carte, .section.alterne .avis,
.section.alterne .membre, .section.alterne .billet { background: var(--nuance); }

.prix { color: var(--accent); font-weight: 700; margin: 0; }

.atouts { padding-left: 20px; color: var(--encre-douce); }
.atouts li { margin-bottom: 6px; }

.illustration, .portrait { margin: 0; border-radius: var(--rayon); overflow: hidden; box-shadow: var(--ombre); }
.illustration svg, .portrait svg, .vignette svg { display: block; width: 100%; height: auto; }

.galerie { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
.vignette { margin: 0; border-radius: var(--rayon); overflow: hidden; border: 1px solid var(--trait); background: var(--fond); }
.vignette figcaption { padding: 10px 12px; font-size: 13.5px; color: var(--encre-douce); }

.chrono { list-style: none; margin: 0; padding: 0; }
.chrono li { display: grid; grid-template-columns: 110px 1fr; gap: 16px; padding: 14px 0; border-top: 1px solid var(--trait); }
.chrono strong { color: var(--accent); }
.chrono p { margin: 4px 0 0; color: var(--encre-douce); }

.formules { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 18px; align-items: start; }
.formule { position: relative; background: var(--surface); border: 1px solid var(--trait); border-radius: var(--rayon); padding: 24px; }
.formule.mise-en-avant { border-color: var(--accent); box-shadow: var(--ombre); }
.ruban {
  position: absolute; top: -12px; left: 24px; background: var(--accent); color: #fff;
  font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 999px; margin: 0;
}
.montant { font-size: 28px; font-weight: 700; margin: 6px 0 14px; }
.formule ul { list-style: none; padding: 0; margin: 0 0 20px; }
.formule li { padding: 6px 0 6px 22px; position: relative; color: var(--encre-douce); }
.formule li::before { content: "✓"; position: absolute; left: 0; color: var(--accent); font-weight: 700; }

.avis p { font-style: italic; }
.avis cite { font-style: normal; font-weight: 600; font-size: 14px; color: var(--encre-douce); }
.role { color: var(--accent); font-weight: 600; font-size: 14px; margin: 0 0 6px; }
.billet time { font-size: 13px; color: var(--encre-douce); }

.horaires { width: 100%; border-collapse: collapse; }
.horaires th, .horaires td { text-align: left; padding: 11px 4px; border-bottom: 1px solid var(--trait); }
.horaires th { font-weight: 600; }
.horaires td { text-align: right; font-variant-numeric: tabular-nums; }
.horaires .ferme { color: var(--encre-douce); }

.question { border-bottom: 1px solid var(--trait); padding: 6px 0; }
.question summary { cursor: pointer; font-weight: 600; padding: 12px 0; list-style: none; }
.question summary::-webkit-details-marker { display: none; }
.question summary::before { content: "＋"; color: var(--accent); margin-right: 10px; font-weight: 700; }
.question[open] summary::before { content: "－"; }
.question p { color: var(--encre-douce); margin: 0 0 12px 26px; }

/* -------------------------------------------------------- formulaires */
.formulaire { display: grid; gap: 14px; background: var(--fond); border: 1px solid var(--trait); border-radius: var(--rayon); padding: 24px; }
.section.alterne .formulaire { background: var(--nuance); }
.formulaire label, .ligne label { display: grid; gap: 6px; font-size: 14px; font-weight: 600; }

input, select, textarea, button {
  font: inherit; color: inherit; padding: 11px 13px; border: 1px solid var(--trait);
  border-radius: 9px; background: var(--surface); width: 100%;
}
textarea { resize: vertical; }
input[aria-invalid="true"], textarea[aria-invalid="true"] { border-color: #c0392b; }

.ligne { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
.ligne input { flex: 1 1 240px; width: auto; }
.ligne .bouton { width: auto; }

.erreur-champ { color: #c0392b; font-size: 13px; font-weight: 500; }
.retour { min-height: 22px; font-size: 14px; font-weight: 600; color: var(--accent); }

.coordonnees { list-style: none; padding: 0; }
.coordonnees li { padding: 10px 0; border-top: 1px solid var(--trait); font-size: 15px; }

/* --------------------------------------------------------------- pied */
.pied { background: var(--surface); border-top: 1px solid var(--trait); padding: 30px 0; font-size: 14px; }
.mentions { color: var(--encre-douce); margin: 0; }

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}

html { scroll-behavior: smooth; }
`;
  }

  function script(spec) {
    const aNewsletter = spec.sections.includes('newsletter');
    return `/* ${spec.nom} — comportements de la page. Aucune dépendance. */
(function () {
  'use strict';

  var annee = document.getElementById('annee');
  if (annee) annee.textContent = new Date().getFullYear();

  // Menu mobile
  var bouton = document.getElementById('menu');
  var navigation = document.getElementById('navigation');
  if (bouton && navigation) {
    bouton.addEventListener('click', function () {
      var ouvert = navigation.classList.toggle('ouvert');
      bouton.setAttribute('aria-expanded', String(ouvert));
    });
    navigation.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        navigation.classList.remove('ouvert');
        bouton.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /** Affiche un message d'erreur sous un champ, et le relie pour les lecteurs d'écran. */
  function marquer(champ, message) {
    var id = champ.id + '-erreur';
    var bloc = document.getElementById(id);
    if (!bloc) {
      bloc = document.createElement('p');
      bloc.id = id;
      bloc.className = 'erreur-champ';
      champ.insertAdjacentElement('afterend', bloc);
    }
    bloc.textContent = message || '';
    champ.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (message) champ.setAttribute('aria-describedby', id);
    else champ.removeAttribute('aria-describedby');
    return !message;
  }

  var courriel = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/;

  var contact = document.getElementById('contact-form');
  if (contact) {
    contact.addEventListener('submit', function (evenement) {
      evenement.preventDefault();
      var nom = document.getElementById('nom');
      var email = document.getElementById('email');
      var message = document.getElementById('message');

      var valide = marquer(nom, nom.value.trim() ? '' : 'Indiquez votre nom.');
      valide = marquer(email, courriel.test(email.value.trim()) ? '' : 'Adresse e-mail invalide.') && valide;
      valide = marquer(message, message.value.trim().length >= 10 ? '' : 'Votre message est un peu court.') && valide;

      var retour = document.getElementById('contact-retour');
      if (!valide) {
        retour.textContent = 'Merci de corriger les champs signalés.';
        return;
      }
      // Aucun serveur n'est appelé : la demande est conservée dans le
      // navigateur, prête à être branchée sur votre boîte mail.
      try {
        var envois = JSON.parse(localStorage.getItem('messages') || '[]');
        envois.push({ nom: nom.value, email: email.value, message: message.value, date: new Date().toISOString() });
        localStorage.setItem('messages', JSON.stringify(envois));
      } catch (e) { /* navigation privée */ }
      contact.reset();
      retour.textContent = 'Merci, votre message est bien enregistré. Nous répondons sous 24 h.';
    });
  }
${
  aNewsletter
    ? `
  var lettre = document.getElementById('newsletter-form');
  if (lettre) {
    lettre.addEventListener('submit', function (evenement) {
      evenement.preventDefault();
      var email = document.getElementById('newsletter-email');
      var retour = document.getElementById('newsletter-retour');
      if (!courriel.test(email.value.trim())) {
        marquer(email, 'Adresse e-mail invalide.');
        retour.textContent = '';
        return;
      }
      marquer(email, '');
      lettre.reset();
      retour.textContent = 'Inscription enregistrée. À bientôt !';
    });
  }
`
    : ''
}
})();
`;
  }

  function lisezMoi(spec) {
    const sections = spec.sections.map((s) => `- ${TITRES_NAV[s]}`).join('\n');
    return `# ${spec.nom}

> Site généré par le moteur de Forge, sans aucune IA, à partir de cette demande :
>
> « ${spec.demande} »

Site statique complet : aucune dépendance, aucune ressource distante, aucun appel réseau.
Ouvrez \`index.html\` dans un navigateur, ou déposez le dossier chez n'importe quel hébergeur.

## Sections

${sections}

## Ce qui est inclus

- Mise en page responsive, thème clair et sombre automatique
- Navigation accessible au clavier, lien d'évitement, menu mobile
- Formulaire de contact avec validation et messages d'erreur reliés aux champs
- Illustrations SVG intégrées : rien n'est chargé depuis l'extérieur
- Métadonnées de partage (Open Graph), \`sitemap.xml\` et \`robots.txt\`

## À personnaliser

Textes, coordonnées et tarifs sont des exemples réalistes : remplacez-les par les vôtres
dans \`index.html\`. Les couleurs se règlent en haut de \`styles.css\`.
`;
  }

  /** Renvoie tous les fichiers du site : chemin -> contenu. */
  function generer(spec) {
    const base = identifiant(spec.nom);
    return {
      'index.html': html(spec),
      'styles.css': css(spec),
      'script.js': script(spec),
      'README.md': lisezMoi(spec),
      'robots.txt': 'User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n',
      'sitemap.xml':
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        `  <url><loc>/index.html</loc><changefreq>monthly</changefreq></url>\n` +
        '</urlset>\n',
      '.forge-site.json': JSON.stringify(spec, null, 2) + '\n',
    };
  }

  const Moteur = {
    analyser,
    generer,
    METIERS,
    SECTIONS,
    PALETTES,
    TITRES_NAV,
    normalise,
    identifiant,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Moteur;
  else racine.Moteur = Moteur;
})(typeof globalThis !== 'undefined' ? globalThis : this);
