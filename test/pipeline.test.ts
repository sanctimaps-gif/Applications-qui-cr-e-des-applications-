import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { loadConfig, type ForgeConfig, type Tier } from '../src/config.js';
import { EventBus, type ForgeEventEnvelope } from '../src/util/events.js';
import { LLMClient } from '../src/llm/client.js';
import { ModelRouter } from '../src/providers/registry.js';
import {
  ProviderError,
  type ChunkHandler,
  type CompletionRequest,
  type CompletionResult,
  type ModelSpec,
  type Provider,
} from '../src/providers/types.js';
import { buildApp } from '../src/pipeline/orchestrator.js';
import { verifyProject } from '../src/pipeline/verify.js';
import { repairLoop } from '../src/pipeline/repair.js';
import { Workspace } from '../src/fs/workspace.js';
import type { AppSpec } from '../src/pipeline/types.js';

/** Fournisseur simule : le pipeline est testable sans aucun appel reseau. */
class FakeProvider implements Provider {
  readonly name: string;
  readonly concurrency = 8;
  calls = 0;
  /** Nombre d'echecs a produire avant de repondre normalement. */
  failuresLeft: number;

  constructor(name = 'fake', failuresLeft = 0) {
    this.name = name;
    this.failuresLeft = failuresLeft;
  }

  isConfigured(): boolean {
    return true;
  }

  modelFor(tier: Tier): ModelSpec {
    return { id: `fake-${tier}`, tier, contextWindow: 128_000, maxOutput: 8_192 };
  }

  async complete(req: CompletionRequest, onChunk?: ChunkHandler): Promise<CompletionResult> {
    this.calls++;
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new ProviderError(this.name, 'panne simulee', { status: 500 });
    }

    const user = req.messages.map((m) => m.content).join('\n');
    const isPlan = user.includes('Produis le plan JSON');
    const text = isPlan ? plan() : code(user);
    onChunk?.(text);

    return {
      text,
      provider: this.name,
      model: req.model,
      inputTokens: 100,
      outputTokens: 200,
      latencyMs: 1,
      cached: false,
      attempts: 1,
    };
  }
}

function plan(): string {
  return JSON.stringify({
    name: 'Compteur',
    slug: 'compteur',
    summary: 'Un compteur en ligne de commande.',
    stack: 'TypeScript + Node',
    language: 'TypeScript',
    runtime: 'node',
    features: ['incrementer', 'lire'],
    files: [
      { path: 'package.json', purpose: 'manifeste', dependsOn: [], complexity: 1, exports: [] },
      { path: 'src/counter.js', purpose: 'logique du compteur', dependsOn: ['package.json'], complexity: 4, exports: ['increment'] },
      { path: 'src/index.js', purpose: 'point d entree', dependsOn: ['src/counter.js'], complexity: 3, exports: [] },
      { path: 'README.md', purpose: 'documentation', dependsOn: [], complexity: 1, exports: [] },
    ],
    commands: { install: 'true', test: 'true' },
    env: [],
    notes: '',
  });
}

function code(user: string): string {
  const match = /Fichier a ecrire : (\S+)/.exec(user);
  const target = match?.[1] ?? 'inconnu';
  if (target === 'package.json') {
    return '```json\n{\n  "name": "compteur",\n  "version": "1.0.0"\n}\n```';
  }
  return `\`\`\`js\n// ${target}\nexport const increment = (n) => n + 1;\n\`\`\``;
}

async function harness(overrides: Partial<ForgeConfig> = {}): Promise<{
  cfg: ForgeConfig;
  bus: EventBus;
  events: ForgeEventEnvelope[];
  provider: FakeProvider;
  llm: LLMClient;
  cleanup: () => Promise<void>;
}> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-home-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-out-'));
  const cfg = loadConfig({
    home,
    workspace,
    cache: false,
    cacheDir: path.join(home, 'cache'),
    verify: false,
    maxRetries: 2,
    ...overrides,
  });

  const bus = new EventBus();
  const events: ForgeEventEnvelope[] = [];
  bus.onEvent((event) => events.push(event));

  const provider = new FakeProvider();
  const llm = new LLMClient(cfg, bus, new ModelRouter(cfg, [provider]));

  return {
    cfg,
    bus,
    events,
    provider,
    llm,
    cleanup: async () => {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    },
  };
}

test('buildApp produit un projet complet sur disque', async () => {
  const h = await harness();
  try {
    const result = await buildApp(
      { cfg: h.cfg, bus: h.bus, llm: h.llm },
      { prompt: 'Un compteur en ligne de commande', verify: false, withCi: true },
    );

    assert.equal(result.spec.name, 'Compteur');
    assert.equal(result.files.length, 4);

    const written = await fs.readdir(result.projectDir);
    assert.ok(written.includes('package.json'));
    assert.ok(written.includes('src'));
    assert.ok(written.includes('.forge.json'));
    assert.ok(written.includes('.gitignore'));

    // Le workflow CI demande a bien ete ajoute.
    const ci = await fs.readFile(path.join(result.projectDir, '.github/workflows/ci.yml'), 'utf8');
    assert.match(ci, /runs-on: ubuntu-latest/);

    // Le manifeste rejoue la demande d'origine.
    const manifest = JSON.parse(await fs.readFile(path.join(result.projectDir, '.forge.json'), 'utf8'));
    assert.equal(manifest.generator, 'forge-ai');
    assert.equal(manifest.prompt, 'Un compteur en ligne de commande');

    // Le contenu est extrait du bloc de code, sans les backticks.
    const pkg = await fs.readFile(path.join(result.projectDir, 'package.json'), 'utf8');
    assert.equal(JSON.parse(pkg).name, 'compteur');

    const done = h.events.find((e) => e.type === 'done');
    assert.ok(done, 'un evenement done doit etre emis');
  } finally {
    await h.cleanup();
  }
});

test('les fichiers independants sont generes en parallele', async () => {
  const h = await harness();
  try {
    const result = await buildApp(
      { cfg: h.cfg, bus: h.bus, llm: h.llm },
      { prompt: 'Un compteur', verify: false },
    );

    const order = h.events
      .filter((e): e is ForgeEventEnvelope & { type: 'file:done'; path: string } => e.type === 'file:done')
      .map((e) => e.path);

    // counter.js depend de package.json, index.js depend de counter.js.
    assert.ok(order.indexOf('package.json') < order.indexOf('src/counter.js'));
    assert.ok(order.indexOf('src/counter.js') < order.indexOf('src/index.js'));
    assert.equal(result.files.length, 4);
  } finally {
    await h.cleanup();
  }
});

test('la verification execute reellement les commandes du projet', async () => {
  const h = await harness({ verify: true });
  try {
    const result = await buildApp(
      { cfg: h.cfg, bus: h.bus, llm: h.llm },
      { prompt: 'Un compteur', verify: true },
    );

    assert.ok(result.verification.ran);
    assert.ok(result.verification.ok, 'toutes les etapes doivent reussir');

    // Le plan ne declarait que install et test ; la recette Node a complete
    // lint et build avec `--if-present`, inoffensifs quand la cible manque.
    assert.deepEqual(result.verification.steps.map((s) => s.name), ['install', 'lint', 'build', 'test']);
    const lint = result.verification.steps.find((s) => s.name === 'lint');
    assert.match(lint!.command, /--if-present/);
  } finally {
    await h.cleanup();
  }
});

test('un fournisseur en panne est reessaye puis remplace', async () => {
  const h = await harness();
  try {
    // Le premier fournisseur echoue systematiquement, le second repond.
    const broken = new FakeProvider('casse', Number.MAX_SAFE_INTEGER);
    const backup = new FakeProvider('secours');
    const llm = new LLMClient(h.cfg, h.bus, new ModelRouter(h.cfg, [broken, backup]));

    const result = await buildApp(
      { cfg: h.cfg, bus: h.bus, llm },
      { prompt: 'Un compteur', verify: false },
    );

    assert.equal(result.files.length, 4);
    assert.ok(backup.calls > 0, 'le fournisseur de secours doit avoir pris le relais');
    assert.equal(llm.usage.byProvider['secours']?.requests, backup.calls);
  } finally {
    await h.cleanup();
  }
});

test('le cache evite de repayer une generation identique', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-cache-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-cache-out-'));
  try {
    const cfg = loadConfig({
      home,
      workspace,
      cache: true,
      cacheDir: path.join(home, 'cache'),
      verify: false,
    });
    const bus = new EventBus();
    const provider = new FakeProvider();
    const llm = new LLMClient(cfg, bus, new ModelRouter(cfg, [provider]));

    await buildApp({ cfg, bus, llm }, { prompt: 'Un compteur', verify: false });
    const callsAfterFirst = provider.calls;

    const llm2 = new LLMClient(cfg, bus, new ModelRouter(cfg, [provider]));
    await buildApp({ cfg, bus, llm: llm2 }, { prompt: 'Un compteur', verify: false });

    assert.equal(provider.calls, callsAfterFirst, 'le second build doit etre entierement servi par le cache');
    assert.ok(llm2.usage.cacheHits > 0);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

/** Fournisseur qui joue un diagnostic puis une correction reelle. */
class RepairProvider implements Provider {
  readonly name = 'reparateur';
  readonly concurrency = 4;
  triages = 0;
  fixes = 0;

  isConfigured(): boolean {
    return true;
  }
  modelFor(tier: Tier): ModelSpec {
    return { id: `fix-${tier}`, tier, contextWindow: 128_000, maxOutput: 4_096 };
  }
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const user = req.messages.map((m) => m.content).join('\n');
    let text: string;

    if (user.includes('Diagnostique et liste les fichiers')) {
      this.triages++;
      text = JSON.stringify({
        diagnosis: 'le point d entree est absent',
        fixes: [{ path: 'ok.js', problem: 'fichier manquant' }],
      });
    } else {
      this.fixes++;
      text = '```js\nprocess.exit(0);\n```';
    }

    return {
      text,
      provider: this.name,
      model: req.model,
      inputTokens: 10,
      outputTokens: 10,
      latencyMs: 1,
      cached: false,
      attempts: 1,
    };
  }
}

test('la boucle de reparation corrige un build casse', async () => {
  const h = await harness({ verify: true });
  try {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-repair-'));
    const workspace = await Workspace.create(dir);

    // Le projet reference un fichier qui n'existe pas : la commande echoue.
    const spec: AppSpec = {
      name: 'Casse',
      slug: 'casse',
      summary: 'projet incomplet',
      stack: 'Node',
      language: 'JavaScript',
      runtime: 'node',
      features: [],
      files: [{ path: 'ok.js', purpose: 'point d entree', dependsOn: [], complexity: 2, exports: [] }],
      commands: { test: 'node ok.js' },
      env: [],
    };

    const provider = new RepairProvider();
    const llm = new LLMClient(h.cfg, h.bus, new ModelRouter(h.cfg, [provider]));

    const before = await verifyProject(h.bus, h.cfg, spec, workspace.root);
    assert.equal(before.ok, false, 'le build doit echouer au depart');

    const after = await repairLoop(llm, h.bus, h.cfg, spec, workspace, before);

    assert.equal(after.verification.ok, true, 'le build doit passer apres reparation');
    assert.equal(after.attempts, 1, 'un seul tour doit suffire');
    assert.equal(provider.triages, 1);
    assert.equal(provider.fixes, 1);
    assert.equal(await workspace.read('ok.js'), 'process.exit(0);\n');

    await fs.rm(dir, { recursive: true, force: true });
  } finally {
    await h.cleanup();
  }
});

test('une erreur qui ne bouge pas arrete la boucle', async () => {
  const h = await harness({ verify: true });
  try {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-stuck-'));
    const workspace = await Workspace.create(dir);

    const spec: AppSpec = {
      name: 'Bloque',
      slug: 'bloque',
      summary: 'echec permanent',
      stack: 'Node',
      language: 'JavaScript',
      runtime: 'node',
      features: [],
      files: [{ path: 'ok.js', purpose: 'entree', dependsOn: [], complexity: 2, exports: [] }],
      // Cette commande echoue quoi qu'on ecrive dans ok.js.
      commands: { test: 'node -e "process.exit(3)"' },
      env: [],
    };

    const provider = new RepairProvider();
    const llm = new LLMClient(h.cfg, h.bus, new ModelRouter(h.cfg, [provider]));

    const before = await verifyProject(h.bus, h.cfg, spec, workspace.root);
    const after = await repairLoop(llm, h.bus, h.cfg, spec, workspace, before);

    assert.equal(after.verification.ok, false);
    // Le garde-fou coupe apres deux diagnostics identiques, sans boucler.
    assert.ok(after.attempts <= 4, `trop de tours: ${after.attempts}`);

    await fs.rm(dir, { recursive: true, force: true });
  } finally {
    await h.cleanup();
  }
});

test('sans fournisseur, buildApp echoue explicitement', async () => {
  const h = await harness();
  try {
    const llm = new LLMClient(h.cfg, h.bus, new ModelRouter(h.cfg, []));
    await assert.rejects(
      () => buildApp({ cfg: h.cfg, bus: h.bus, llm }, { prompt: 'x', verify: false }),
      /Aucun fournisseur/,
    );
  } finally {
    await h.cleanup();
  }
});
