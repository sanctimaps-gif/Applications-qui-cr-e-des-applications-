/**
 * Tests du relais GitHub de `forge serve`.
 *
 * Le relais existe pour une raison precise : les deux points d'entree du
 * device flow vivent sur github.com et ne renvoient aucun en-tete CORS, donc
 * une page ne peut pas les appeler elle-meme. Ce qui est verifie ici, c'est
 * qu'il rend bien ce service, et qu'il ne l'ouvre pas au premier venu.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server/http.js';
import { credentialsPath, writeCredentials } from '../src/git/device.js';

async function avecServeur<T>(
  home: string,
  faire: (base: string) => Promise<T>,
): Promise<T> {
  const cfg = loadConfig({ home, port: 0, host: '127.0.0.1', logLevel: 'silent' });
  const { server } = createServer(cfg);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    return await faire(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function maison(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-relais-'));
}

/** Une requete brute, pour pouvoir mentir sur l'en-tete `Host`. */
function demander(
  base: string,
  chemin: string,
  options: { methode?: string; hote?: string } = {},
): Promise<{ statut: number; corps: string }> {
  const url = new URL(chemin, base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: options.methode ?? 'GET',
        headers: options.hote ? { host: options.hote } : {},
      },
      (res) => {
        let corps = '';
        res.on('data', (c) => (corps += c));
        res.on('end', () => resolve({ statut: res.statusCode ?? 0, corps }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const SANS_ENV = ['GITHUB_TOKEN', 'GH_TOKEN', 'FORGE_GITHUB_TOKEN'] as const;

/**
 * Met les variables de jeton de cote : sinon l'environnement de test ment.
 *
 * `await` est indispensable : sans lui, le `finally` remettrait les variables
 * avant meme que la requete soit partie.
 */
async function sansJetonDEnvironnement<T>(faire: () => Promise<T>): Promise<T> {
  const memoire = SANS_ENV.map((cle) => [cle, process.env[cle]] as const);
  for (const cle of SANS_ENV) delete process.env[cle];
  try {
    return await faire();
  } finally {
    for (const [cle, valeur] of memoire) if (valeur !== undefined) process.env[cle] = valeur;
  }
}

test('la session dit « non connecte » quand rien n’est enregistre', async () => {
  const home = maison();
  try {
    await sansJetonDEnvironnement(() =>
      avecServeur(home, async (base) => {
        const { statut, corps } = await demander(base, '/api/github/session');
        assert.equal(statut, 200);
        const charge = JSON.parse(corps) as { connecte: boolean; jeton: null };
        assert.equal(charge.connecte, false);
        assert.equal(charge.jeton, null);
      }),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('la session est relue a chaque appel, pas figee au demarrage', async () => {
  const home = maison();
  try {
    await sansJetonDEnvironnement(() =>
      avecServeur(home, async (base) => {
        const avant = JSON.parse((await demander(base, '/api/github/session')).corps) as {
          connecte: boolean;
        };
        assert.equal(avant.connecte, false);

        // La connexion survient APRES le demarrage du serveur : c'est le cas
        // normal quand on se connecte depuis la page qu'il sert.
        writeCredentials(home, { token: 'gho_abc', login: 'moi', scope: 'repo' });

        const apres = JSON.parse((await demander(base, '/api/github/session')).corps) as {
          connecte: boolean;
          login: string;
          origine: string;
        };
        assert.equal(apres.connecte, true);
        assert.equal(apres.login, 'moi');
        assert.equal(apres.origine, 'login');
      }),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('se deconnecter efface le jeton de la machine', async () => {
  const home = maison();
  try {
    writeCredentials(home, { token: 'gho_abc', login: 'moi' });
    await avecServeur(home, async (base) => {
      const { statut } = await demander(base, '/api/github/logout', { methode: 'POST' });
      assert.equal(statut, 200);
      assert.equal(fs.existsSync(credentialsPath(home)), false);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('un hote distant est refuse — garde-fou contre le DNS rebinding', async () => {
  const home = maison();
  try {
    await avecServeur(home, async (base) => {
      const { statut, corps } = await demander(base, '/api/github/session', {
        hote: 'evil.example.com',
      });
      assert.equal(statut, 403);
      assert.match(corps, /locales/);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('aucun en-tete CORS : une autre page ne peut pas lire le relais', async () => {
  const home = maison();
  try {
    await avecServeur(home, async (base) => {
      const reponse = await fetch(`${base}/api/github/session`);
      // Sans `Access-Control-Allow-Origin`, un navigateur refuse la lecture a
      // toute page d'une autre origine. C'est la protection, et elle tient au
      // fait de NE RIEN emettre.
      assert.equal(reponse.headers.get('access-control-allow-origin'), null);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('sans application OAuth, le relais explique au lieu d’echouer sourdement', async () => {
  const home = maison();
  const memoire = process.env['FORGE_GITHUB_CLIENT_ID'];
  delete process.env['FORGE_GITHUB_CLIENT_ID'];
  try {
    await avecServeur(home, async (base) => {
      const { statut, corps } = await demander(base, '/api/github/device', { methode: 'POST' });
      assert.equal(statut, 400);
      assert.match(corps, /Enable Device Flow/);
    });
  } finally {
    if (memoire !== undefined) process.env['FORGE_GITHUB_CLIENT_ID'] = memoire;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('le studio est servi, et il ne donne acces qu’a lui-meme', async () => {
  const home = maison();
  try {
    await avecServeur(home, async (base) => {
      const studio = await demander(base, '/studio');
      assert.equal(studio.statut, 200);
      assert.match(studio.corps, /Forge/);
      // Meme origine que le relais : c'est ce qui rend la connexion possible.
      assert.match(studio.corps, /web\/device\.js/);

      const moteur = await demander(base, '/web/device.js');
      assert.equal(moteur.statut, 200);

      // Rien d'autre du depot ne doit sortir.
      for (const tentative of ['/web/%2e%2e/package.json', '/web/sous/dossier.js', '/package.json']) {
        const essai = await demander(base, tentative);
        assert.equal(essai.statut, 404, tentative);
      }
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
