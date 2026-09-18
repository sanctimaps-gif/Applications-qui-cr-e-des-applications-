/**
 * Tests du device flow : se connecter a GitHub sans coller de cle.
 *
 * Aucun appel reseau : `fetch` est remplace. Ce qui est verifie, c'est ce qui
 * *serait* parti, et surtout la gestion des reponses que GitHub envoie pendant
 * l'attente — `authorization_pending` et `slow_down` ne sont pas des erreurs,
 * et les confondre avec des echecs casserait la connexion a tous les coups.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearCredentials,
  credentialsPath,
  DeviceFlowError,
  login,
  pollDeviceFlow,
  readCredentials,
  startDeviceFlow,
  writeCredentials,
} from '../src/git/device.js';

interface Appel {
  url: string;
  champs: Record<string, string>;
}

/** Un faux GitHub : une reponse par appel, dans l'ordre. */
function fauxGitHub(reponses: unknown[]): { fetchImpl: typeof fetch; appels: Appel[] } {
  const appels: Appel[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    appels.push({
      url: String(url),
      champs: Object.fromEntries(new URLSearchParams(String(init.body))),
    });
    const charge = reponses[Math.min(i++, reponses.length - 1)];
    return {
      status: 200,
      text: async () => JSON.stringify(charge),
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, appels };
}

const DEBUT = {
  device_code: 'dc-1',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};

test('la premiere etape rend le code a taper', async () => {
  const { fetchImpl, appels } = fauxGitHub([DEBUT]);
  const debut = await startDeviceFlow('Ov23li', { fetchImpl });

  assert.equal(debut.userCode, 'WDJB-MJHT');
  assert.equal(debut.deviceCode, 'dc-1');
  assert.equal(debut.interval, 5);
  assert.match(appels[0]!.url, /\/login\/device\/code$/);
  assert.equal(appels[0]!.champs['client_id'], 'Ov23li');
  // Les droits demandes doivent suffire a creer un depot ET a y pousser un
  // workflow, sinon `--github --ci` echouerait apres coup.
  assert.match(appels[0]!.champs['scope']!, /repo/);
  assert.match(appels[0]!.champs['scope']!, /workflow/);
});

test('aucun secret ne part : seul le client_id, qui est public', async () => {
  const { fetchImpl, appels } = fauxGitHub([DEBUT]);
  await startDeviceFlow('Ov23li', { fetchImpl });
  assert.deepEqual(Object.keys(appels[0]!.champs).sort(), ['client_id', 'scope']);
});

test('« authorization_pending » est une attente, pas une erreur', async () => {
  const { fetchImpl } = fauxGitHub([{ error: 'authorization_pending' }]);
  const verdict = await pollDeviceFlow('Ov23li', 'dc-1', { fetchImpl, interval: 5 });
  assert.equal(verdict.status, 'pending');
});

test('« slow_down » fait rallonger le delai', async () => {
  const { fetchImpl } = fauxGitHub([{ error: 'slow_down', interval: 10 }]);
  const verdict = await pollDeviceFlow('Ov23li', 'dc-1', { fetchImpl, interval: 5 });
  assert.equal(verdict.status, 'pending');
  assert.equal(verdict.status === 'pending' ? verdict.interval : 0, 10);
});

test('un refus et une expiration se distinguent', async () => {
  const refus = await pollDeviceFlow('c', 'd', { fetchImpl: fauxGitHub([{ error: 'access_denied' }]).fetchImpl });
  assert.equal(refus.status, 'denied');
  const perime = await pollDeviceFlow('c', 'd', { fetchImpl: fauxGitHub([{ error: 'expired_token' }]).fetchImpl });
  assert.equal(perime.status, 'expired');
});

test('le device flow desactive est explique, pas juste signale', async () => {
  const { fetchImpl } = fauxGitHub([{ error: 'unauthorized_client' }]);
  await assert.rejects(
    () => startDeviceFlow('Ov23li', { fetchImpl }),
    (error: DeviceFlowError) => {
      assert.equal(error.code, 'unauthorized_client');
      assert.match(error.message, /Enable Device Flow/);
      return true;
    },
  );
});

test('la boucle complete patiente puis rend le jeton', async () => {
  const { fetchImpl, appels } = fauxGitHub([
    DEBUT,
    { error: 'authorization_pending' },
    { error: 'slow_down', interval: 7 },
    { access_token: 'gho_abc', scope: 'repo,workflow' },
  ]);

  const attentes: number[] = [];
  let horloge = 0;
  const { token, scope } = await login('Ov23li', {
    fetchImpl,
    sleep: async (ms) => {
      attentes.push(ms / 1000);
      horloge += ms;
    },
    now: () => horloge,
    onCode: (debut) => assert.equal(debut.userCode, 'WDJB-MJHT'),
  });

  assert.equal(token, 'gho_abc');
  assert.equal(scope, 'repo,workflow');
  // Trois sondages, et le rythme impose par GitHub a bien ete suivi.
  assert.equal(appels.length, 4);
  assert.deepEqual(attentes, [5, 5, 7]);
});

test('le code qui expire ne boucle pas indefiniment', async () => {
  const { fetchImpl } = fauxGitHub([{ ...DEBUT, expires_in: 10 }, { error: 'authorization_pending' }]);
  let horloge = 0;
  await assert.rejects(
    () =>
      login('Ov23li', {
        fetchImpl,
        sleep: async (ms) => {
          horloge += ms;
        },
        now: () => horloge,
      }),
    /expire/i,
  );
});

test('un code manquant est signale au lieu de passer inapercu', async () => {
  const { fetchImpl } = fauxGitHub([{ verification_uri: 'https://github.com/login/device' }]);
  await assert.rejects(() => startDeviceFlow('Ov23li', { fetchImpl }), /code de connexion/);
});

test('sans identifiant d’application, on le dit avant d’appeler GitHub', async () => {
  const { fetchImpl, appels } = fauxGitHub([DEBUT]);
  await assert.rejects(() => startDeviceFlow('', { fetchImpl }), /forge login/);
  assert.equal(appels.length, 0, 'aucun appel ne doit partir');
});

// --------------------------------------------------------------------------- //
// Le jeton, une fois obtenu
// --------------------------------------------------------------------------- //
test('le jeton est enregistre en lecture seule pour son proprietaire', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-device-'));
  try {
    const cible = writeCredentials(home, { token: 'gho_abc', login: 'moi', scope: 'repo' });
    assert.equal(cible, credentialsPath(home));
    assert.equal(readCredentials(home)?.token, 'gho_abc');
    assert.equal(readCredentials(home)?.login, 'moi');

    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(cible).mode & 0o777, 0o600, 'lisible par d’autres');
    }

    // Reecrire par-dessus ne doit pas relacher les droits : `mode` est ignore
    // quand le fichier existe deja, d'ou le chmod explicite.
    fs.chmodSync(cible, 0o644);
    writeCredentials(home, { token: 'gho_def' });
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(cible).mode & 0o777, 0o600);
    }
    assert.equal(readCredentials(home)?.token, 'gho_def');

    assert.equal(clearCredentials(home), true);
    assert.equal(readCredentials(home), undefined);
    assert.equal(clearCredentials(home), false, 'effacer deux fois ne leve pas');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('un fichier absent ou abime ne fait pas tomber le demarrage', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-device-'));
  try {
    assert.equal(readCredentials(home), undefined);
    fs.writeFileSync(credentialsPath(home), '{ ceci n est pas du json');
    assert.equal(readCredentials(home), undefined);
    fs.writeFileSync(credentialsPath(home), '{"login":"moi"}');
    assert.equal(readCredentials(home), undefined, 'sans jeton, ce n’est pas une session');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
