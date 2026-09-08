/**
 * Publication sur GitHub, depuis le navigateur, sans serveur intermédiaire.
 *
 * L'API REST de GitHub autorise les requêtes navigateur (CORS), donc la page
 * parle directement à api.github.com. Votre jeton ne transite par aucun autre
 * serveur : il ne quitte cet onglet que pour aller chez GitHub, et il n'est
 * conservé que si vous le demandez explicitement.
 *
 * Le dépôt reçoit tout le projet en UN SEUL commit, via l'API Git Data :
 * un blob par fichier, un arbre, un commit, puis la référence. C'est la même
 * mécanique que `src/git/github.ts` en ligne de commande.
 */

(function (racine) {
  'use strict';

  var API = 'https://api.github.com';

  function ErreurGitHub(message, statut, corps) {
    var erreur = new Error(message);
    erreur.nom = 'ErreurGitHub';
    erreur.statut = statut;
    erreur.corps = corps;
    return erreur;
  }

  /** Message lisible pour les échecs qu'on sait nommer. */
  function explique(statut, charge) {
    var dit = charge && charge.message ? charge.message : '';
    if (statut === 401) return 'Jeton refusé : il est invalide, révoqué ou expiré.';
    if (statut === 403 && /rate limit/i.test(dit)) return 'Trop de requêtes : réessayez dans quelques minutes.';
    if (statut === 403) return 'Accès refusé : ce jeton n’a pas la permission nécessaire (Contents : lecture et écriture).';
    if (statut === 404) return 'Introuvable : le dépôt n’existe pas, ou le jeton n’y a pas accès.';
    if (statut === 422 && /already exists/i.test(dit)) return 'Ce dépôt existe déjà sur votre compte.';
    return dit || ('GitHub a répondu ' + statut + '.');
  }

  function Client(jeton) {
    this.jeton = String(jeton || '').trim();
  }

  Client.prototype.appel = function (methode, chemin, corps) {
    var options = {
      method: methode,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ' + this.jeton,
        'x-github-api-version': '2022-11-28',
      },
    };
    if (corps !== undefined) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(corps);
    }

    return fetch(API + chemin, options).then(function (reponse) {
      return reponse.text().then(function (texte) {
        var charge = null;
        try { charge = texte ? JSON.parse(texte) : null; } catch (e) { charge = null; }
        if (!reponse.ok) throw ErreurGitHub(explique(reponse.status, charge), reponse.status, charge);
        return charge;
      });
    }, function () {
      // Un échec réseau : pas de statut, donc pas de message de GitHub.
      throw ErreurGitHub('Impossible de joindre GitHub. Vérifiez votre connexion.', 0, null);
    });
  };

  /** Qui est le porteur du jeton ? Sert aussi à valider la connexion. */
  Client.prototype.moi = function () {
    return this.appel('GET', '/user');
  };

  Client.prototype.depot = function (proprietaire, nom) {
    return this.appel('GET', '/repos/' + proprietaire + '/' + nom).catch(function (erreur) {
      if (erreur.statut === 404) return null;
      throw erreur;
    });
  };

  Client.prototype.creerDepot = function (options) {
    return this.appel('POST', '/user/repos', {
      name: options.nom,
      description: options.description || '',
      private: Boolean(options.prive),
      auto_init: false,
      has_issues: true,
      has_wiki: false,
    });
  };

  // ===================================================================== //
  // Encodage : GitHub veut du base64, et le contenu est de l'UTF-8 accentué
  // ===================================================================== //
  /**
   * `btoa` ne sait traiter que des octets. Un « é » est un caractère dont le
   * code dépasse 255 : il faut donc encoder en UTF-8 d'abord, sinon btoa lève.
   */
  function base64(texte) {
    var octets = new TextEncoder().encode(texte);
    var morceaux = [];
    // Par tranches : `String.fromCharCode.apply` déborde la pile sur un gros
    // fichier passé d'un coup.
    for (var i = 0; i < octets.length; i += 0x8000) {
      morceaux.push(String.fromCharCode.apply(null, octets.subarray(i, i + 0x8000)));
    }
    return btoa(morceaux.join(''));
  }

  /**
   * Envoie tous les fichiers en un seul commit.
   *
   * `fichiers` est la carte chemin -> contenu que produisent les moteurs.
   * `progres` est appelé avec (faits, total) pour l'affichage.
   */
  Client.prototype.publier = function (options) {
    var self = this;
    var base = '/repos/' + options.proprietaire + '/' + options.depot + '/git';
    var branche = options.branche || 'main';
    var chemins = Object.keys(options.fichiers).sort();
    var faits = 0;
    var avance = options.progres || function () {};

    avance(0, chemins.length);

    // Un blob par fichier. En parallèle : la latence l'emporte sur le calcul.
    return Promise.all(
      chemins.map(function (chemin) {
        return self
          .appel('POST', base + '/blobs', { content: base64(options.fichiers[chemin]), encoding: 'base64' })
          .then(function (blob) {
            avance(++faits, chemins.length);
            return { path: chemin, mode: '100644', type: 'blob', sha: blob.sha };
          });
      }),
    )
      .then(function (blobs) {
        // Un dépôt fraîchement créé n'a aucune référence : le commit est alors
        // sans parent, et l'arbre sans base.
        return self
          .appel('GET', base + '/ref/heads/' + encodeURIComponent(branche))
          .then(function (ref) {
            return self.appel('GET', base + '/commits/' + ref.object.sha).then(function (commit) {
              return { blobs: blobs, parent: ref.object.sha, arbreBase: commit.tree.sha };
            });
          })
          .catch(function (erreur) {
            if (erreur.statut === 404 || erreur.statut === 409) return { blobs: blobs, parent: null, arbreBase: null };
            throw erreur;
          });
      })
      .then(function (etat) {
        var corps = { tree: etat.blobs };
        if (etat.arbreBase) corps.base_tree = etat.arbreBase;
        return self.appel('POST', base + '/trees', corps).then(function (arbre) {
          return self
            .appel('POST', base + '/commits', {
              message: options.message,
              tree: arbre.sha,
              parents: etat.parent ? [etat.parent] : [],
            })
            .then(function (commit) {
              if (etat.parent) {
                return self
                  .appel('PATCH', base + '/refs/heads/' + encodeURIComponent(branche), { sha: commit.sha, force: false })
                  .then(function () { return commit; });
              }
              return self
                .appel('POST', base + '/refs', { ref: 'refs/heads/' + branche, sha: commit.sha })
                .then(function () { return commit; });
            });
        });
      })
      .then(function (commit) {
        return { commit: commit.sha, branche: branche, fichiers: chemins.length };
      });
  };

  /** Active GitHub Pages, et renvoie l'adresse publique. */
  Client.prototype.activerPages = function (proprietaire, depot, branche) {
    var self = this;
    var chemin = '/repos/' + proprietaire + '/' + depot + '/pages';
    var corps = { source: { branch: branche || 'main', path: '/' } };
    return this.appel('POST', chemin, corps)
      .catch(function (erreur) {
        // 409 : Pages est déjà actif. On relit simplement sa configuration.
        if (erreur.statut === 409) return self.appel('GET', chemin);
        throw erreur;
      })
      .then(function (pages) { return (pages && pages.html_url) || null; })
      .catch(function () { return null; });   // Pages est un bonus, pas un dû
  };

  /** Un nom de dépôt valide : lettres, chiffres, tirets, point et tiret bas. */
  function nomDepot(titre) {
    var nom = String(titre || 'projet')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 90);
    return nom || 'projet-forge';
  }

  var GitHub = { Client: Client, nomDepot: nomDepot, base64: base64, API: API };

  if (typeof module !== 'undefined' && module.exports) module.exports = GitHub;
  else racine.GitHub = GitHub;
})(typeof globalThis !== 'undefined' ? globalThis : this);
