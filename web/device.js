/**
 * Connexion a GitHub sans coller de cle, cote navigateur.
 *
 * Pourquoi ce fichier est si mince : le device flow d'OAuth se joue sur
 * `github.com/login/device/code` et `github.com/login/oauth/access_token`, qui
 * ne renvoient aucun en-tete CORS. Une page ne peut donc pas les appeler
 * elle-meme — c'est une decision de GitHub, pas une limite de cette page.
 *
 * Quand la page est servie par `forge serve`, un relais de MEME ORIGINE fait
 * ces deux appels a sa place. Ce module ne parle donc qu'a ce relais, et la
 * mecanique du flux (sondage, `authorization_pending`, `slow_down`) vit une
 * seule fois, dans `src/git/device.ts`.
 *
 * Sans relais — sur GitHub Pages, par exemple — `disponible()` repond faux, et
 * la page propose le collage d'un jeton, en disant pourquoi.
 */

(function (racine) {
  'use strict';

  /** Le relais, s'il existe. Renvoie la session, ou null. */
  function session() {
    return fetch('/api/github/session', { headers: { accept: 'application/json' } })
      .then(function (reponse) {
        if (!reponse.ok) return null;
        return reponse.json().catch(function () { return null; });
      })
      .catch(function () { return null; });   // page statique : pas de relais
  }

  function envoyer(chemin, corps) {
    return fetch(chemin, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(corps || {}),
    }).then(function (reponse) {
      return reponse.json().then(
        function (charge) {
          if (!reponse.ok || charge.error) throw new Error(charge.error || 'le relais a refusé');
          return charge;
        },
        function () { throw new Error('réponse illisible du relais'); },
      );
    });
  }

  /** Demande le code a taper sur github.com. */
  function commencer(clientId) {
    return envoyer('/api/github/device', clientId ? { clientId: clientId } : {});
  }

  /**
   * Attend que l'utilisateur valide, en sondant au rythme impose par GitHub.
   *
   * `onAttente` est appele a chaque tour, pour que l'affichage puisse montrer
   * que l'on patiente plutot que de rester fige.
   */
  function attendre(debut, options) {
    var choix = options || {};
    var dormir = choix.dormir || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var maintenant = choix.maintenant || function () { return Date.now(); };
    var limite = maintenant() + (debut.expiresIn || 900) * 1000;
    var interval = debut.interval || 5;

    function tour() {
      if (maintenant() >= limite) throw new Error('Le code a expiré. Relancez la connexion.');
      return dormir(interval * 1000)
        .then(function () {
          if (choix.annule && choix.annule()) throw new Error('Connexion annulée.');
          return envoyer('/api/github/device/jeton', {
            clientId: debut.clientId,
            deviceCode: debut.deviceCode,
          });
        })
        .then(function (verdict) {
          if (verdict.status === 'granted') return verdict;
          if (verdict.status === 'denied') throw new Error('Connexion refusée sur GitHub.');
          if (verdict.status === 'expired') throw new Error('Le code a expiré. Relancez la connexion.');
          // « pending » ou « slow_down » : GitHub dit a quel rythme revenir.
          if (verdict.interval) interval = verdict.interval;
          if (choix.onAttente) choix.onAttente(interval);
          return tour();
        });
    }
    return tour();
  }

  function deconnecter() {
    return envoyer('/api/github/logout', {}).catch(function () { return { efface: false }; });
  }

  var Device = {
    session: session,
    commencer: commencer,
    attendre: attendre,
    deconnecter: deconnecter,
    /** Vrai si un relais repond, c'est-a-dire si la connexion sans clé est possible. */
    disponible: function () {
      return session().then(function (s) { return s !== null; });
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Device;
  else racine.Device = Device;
})(typeof globalThis !== 'undefined' ? globalThis : this);
