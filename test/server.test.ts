import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

import { loadConfig, type ForgeConfig } from '../src/config.js';
import { createServer } from '../src/server/http.js';

async function withServer(
  overrides: Partial<ForgeConfig>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-srv-'));
  const cfg = loadConfig({ home, workspace: path.join(home, 'projects'), ...overrides });
  const { server } = createServer(cfg);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
  }
}

test('GET /api/health decrit l etat et les limites', async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);

    const body = (await response.json()) as any;
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.providers));
    // Aucune limite de creation par defaut.
    assert.equal(body.limits.maxProjects, 'illimite');
    assert.equal(body.limits.maxFiles, 'illimite');
    assert.equal(body.limits.maxRepairAttempts, 'illimite');
  });
});

test('GET /api/providers liste les fournisseurs disponibles', async () => {
  await withServer({}, async (base) => {
    const body = (await fetch(`${base}/api/providers`).then((r) => r.json())) as any;
    assert.ok(body.available.includes('openai'));
    assert.ok(body.available.includes('ollama'));
    assert.ok(Array.isArray(body.configured));
  });
});

test('POST /api/projects refuse une demande vide', async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '  ' }),
    });
    assert.equal(response.status, 400);
  });
});

test("l'interface web est servie a la racine", async () => {
  await withServer({}, async (base) => {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /Forge/);
  });
});

test('le jeton protege l API quand il est defini', async () => {
  await withServer({ authToken: 'secret' }, async (base) => {
    assert.equal((await fetch(`${base}/api/health`)).status, 401);

    const withHeader = await fetch(`${base}/api/health`, {
      headers: { authorization: 'Bearer secret' },
    });
    assert.equal(withHeader.status, 200);

    const withQuery = await fetch(`${base}/api/health?token=secret`);
    assert.equal(withQuery.status, 200);
  });
});

test('les routes inconnues renvoient 404', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/api/inexistant`)).status, 404);
    assert.equal((await fetch(`${base}/api/projects/zzzz`)).status, 404);
  });
});
