import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { ModelRouter } from '../src/providers/registry.js';
import { LLMClient } from '../src/llm/client.js';
import { EventBus } from '../src/util/events.js';
import { loadConfig } from '../src/config.js';
import { ProviderError } from '../src/providers/types.js';

interface Stub {
  base: string;
  requests: Array<Record<string, any>>;
  urls: string[];
  close: () => Promise<void>;
}

/** Petit serveur qui imite l'API /chat/completions. */
async function stubApi(handler: (body: any, res: http.ServerResponse, count: number) => void): Promise<Stub> {
  const requests: Array<Record<string, any>> = [];
  const urls: string[] = [];
  const server = http.createServer((req, res) => {
    urls.push(req.url ?? '');
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      requests.push(body);
      handler(body, res, requests.length);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}/v1`,
    requests,
    urls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function provider(base: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    name: 'stub',
    baseUrl: base,
    apiKeyEnv: [],
    requiresKey: false,
    hostEnv: ['FORGE_STUB_BASE_URL'],
    ensurePathSuffix: '/v1',
    models: {
      deep: { id: 'stub-deep', tier: 'deep', contextWindow: 128_000, maxOutput: 4_096 },
      balanced: { id: 'stub-balanced', tier: 'balanced', contextWindow: 128_000, maxOutput: 4_096 },
      fast: { id: 'stub-fast', tier: 'fast', contextWindow: 128_000, maxOutput: 4_096 },
    },
    timeoutMs: 10_000,
  });
}

test('reponse JSON classique', async () => {
  const stub = await stubApi((_body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: 'bonjour' } }],
        usage: { prompt_tokens: 11, completion_tokens: 4 },
      }),
    );
  });

  try {
    const result = await provider(stub.base).complete({
      model: 'stub-balanced',
      system: 'systeme',
      messages: [{ role: 'user', content: 'salut' }],
      maxTokens: 100,
      temperature: 0.3,
    });

    assert.equal(result.text, 'bonjour');
    assert.equal(result.inputTokens, 11);
    assert.equal(result.outputTokens, 4);

    // Le prompt systeme est bien place en tete des messages.
    const sent = stub.requests[0]!;
    assert.equal(sent['messages'][0].role, 'system');
    assert.equal(sent['messages'][0].content, 'systeme');
    assert.equal(sent['max_tokens'], 100);
    assert.equal(sent['stream'], false);
  } finally {
    await stub.close();
  }
});

test('flux SSE reassemble et diffuse les fragments', async () => {
  const stub = await stubApi((_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of ['Bon', 'jour', ' le monde']) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  try {
    const chunks: string[] = [];
    const result = await provider(stub.base).complete(
      { model: 'stub-fast', messages: [{ role: 'user', content: 'salut' }] },
      (delta) => chunks.push(delta),
    );

    assert.equal(result.text, 'Bonjour le monde');
    assert.deepEqual(chunks, ['Bon', 'jour', ' le monde']);
    assert.equal(result.outputTokens, 3);
  } finally {
    await stub.close();
  }
});

test('une erreur HTTP 500 est marquee reessayable, une 400 non', async () => {
  const server500 = await stubApi((_body, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"panne"}}');
  });
  const server400 = await stubApi((_body, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"requete invalide"}}');
  });

  try {
    await assert.rejects(
      () => provider(server500.base).complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      (error: unknown) => error instanceof ProviderError && error.retryable && error.status === 500,
    );
    await assert.rejects(
      () => provider(server400.base).complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      (error: unknown) => error instanceof ProviderError && !error.retryable && error.status === 400,
    );
  } finally {
    await server500.close();
    await server400.close();
  }
});

test('le client reessaye apres un 429 puis reussit', async () => {
  const stub = await stubApi((_body, res, count) => {
    if (count === 1) {
      res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' });
      res.end('{"error":{"message":"trop de requetes"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: 'enfin' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }),
    );
  });

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-prov-'));
  // Un fournisseur local n'est actif que si son hote est declare.
  process.env['FORGE_STUB_BASE_URL'] = stub.base;
  try {
    const cfg = loadConfig({ home, cache: false, cacheDir: path.join(home, 'cache'), maxRetries: 3 });
    const bus = new EventBus();
    const llm = new LLMClient(cfg, bus, new ModelRouter(cfg, [provider(stub.base)]));

    const result = await llm.ask({ tier: 'fast', messages: [{ role: 'user', content: 'salut' }] });

    assert.equal(result.text, 'enfin');
    assert.equal(stub.requests.length, 2, 'la premiere tentative doit avoir ete rejouee');
    assert.equal(llm.usage.requests, 1);
  } finally {
    delete process.env['FORGE_STUB_BASE_URL'];
    await stub.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("l'hote local se voit completer son suffixe /v1", async () => {
  const stub = await stubApi((_body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });

  // Convention Ollama : OLLAMA_HOST n'inclut pas /v1.
  const root = stub.base.replace(/\/v1$/, '');
  process.env['FORGE_STUB_BASE_URL'] = root;
  try {
    const result = await provider(stub.base).complete({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(result.text, 'ok');
    assert.deepEqual(stub.urls, ['/v1/chat/completions']);
  } finally {
    delete process.env['FORGE_STUB_BASE_URL'];
    await stub.close();
  }
});

test('une reponse vide est traitee comme un echec', async () => {
  const stub = await stubApi((_body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '   ' } }] }));
  });

  try {
    await assert.rejects(
      () => provider(stub.base).complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      /reponse vide/,
    );
  } finally {
    await stub.close();
  }
});
