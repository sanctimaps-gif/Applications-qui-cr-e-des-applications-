import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { loadConfig, type ForgeConfig, type Tier } from '../src/config.js';
import { EventBus } from '../src/util/events.js';
import { LLMClient } from '../src/llm/client.js';
import { ModelRouter } from '../src/providers/registry.js';
import type { CompletionRequest, CompletionResult, ModelSpec, Provider } from '../src/providers/types.js';
import { iterateProject } from '../src/pipeline/iterate.js';

/** Fournisseur qui joue les trois etapes d'une iteration. */
class IterationProvider implements Provider {
  readonly name = 'iteration';
  readonly concurrency = 4;
  readonly seen: string[] = [];

  constructor(private readonly changes: unknown) {}

  isConfigured(): boolean {
    return true;
  }
  modelFor(tier: Tier): ModelSpec {
    return { id: `it-${tier}`, tier, contextWindow: 128_000, maxOutput: 8_192 };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const user = req.messages.map((m) => m.content).join('\n');
    let text: string;

    if (user.includes('MODIFICATION DEMANDEE') && !user.includes('Planifie les changements')) {
      this.seen.push('select');
      text = JSON.stringify({ read: ['src/app.js', 'package.json'] });
    } else if (user.includes('Planifie les changements')) {
      this.seen.push('plan');
      text = JSON.stringify(this.changes);
    } else {
      const target = /Fichier : (\S+)/.exec(user)?.[1] ?? '?';
      this.seen.push(`edit:${target}`);
      text = '```js\n// version modifiee\nexport const version = 2;\n```';
    }

    return {
      text,
      provider: this.name,
      model: req.model,
      inputTokens: 20,
      outputTokens: 20,
      latencyMs: 1,
      cached: false,
      attempts: 1,
    };
  }
}

async function project(): Promise<{ dir: string; cfg: ForgeConfig; bus: EventBus; home: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-it-home-'));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-it-'));

  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n');
  await fs.writeFile(path.join(dir, 'src/app.js'), 'export const version = 1;\n');
  await fs.writeFile(path.join(dir, 'src/vieux.js'), 'export const obsolete = true;\n');
  await fs.writeFile(path.join(dir, 'README.md'), '# demo\n');

  const cfg = loadConfig({
    home,
    workspace: home,
    cache: false,
    cacheDir: path.join(home, 'cache'),
    verify: false,
  });

  return { dir, cfg, bus: new EventBus(), home };
}

test('une iteration cree, modifie et supprime les bons fichiers', async () => {
  const { dir, cfg, bus, home } = await project();
  try {
    const provider = new IterationProvider({
      summary: 'passage en version 2',
      changes: [
        { path: 'src/app.js', action: 'modify', purpose: 'passer en v2', dependsOn: [] },
        { path: 'src/nouveau.js', action: 'create', purpose: 'module ajoute', dependsOn: ['src/app.js'] },
        { path: 'src/vieux.js', action: 'delete', purpose: 'obsolete', dependsOn: [] },
      ],
    });

    const llm = new LLMClient(cfg, bus, new ModelRouter(cfg, [provider]));
    const result = await iterateProject({ cfg, bus, llm }, { dir, request: 'Passe le projet en version 2', verify: false });

    assert.equal(result.summary, 'passage en version 2');
    assert.deepEqual(result.modified, ['src/app.js']);
    assert.deepEqual(result.created, ['src/nouveau.js']);
    assert.deepEqual(result.deleted, ['src/vieux.js']);

    assert.match(await fs.readFile(path.join(dir, 'src/app.js'), 'utf8'), /version = 2/);
    await assert.rejects(() => fs.access(path.join(dir, 'src/vieux.js')));

    // Les trois etapes ont bien eu lieu : selection, plan, puis editions.
    assert.equal(provider.seen[0], 'select');
    assert.equal(provider.seen[1], 'plan');
    assert.equal(provider.seen.filter((step) => step.startsWith('edit:')).length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("une action incoherente est corrigee d'apres le disque", async () => {
  const { dir, cfg, bus, home } = await project();
  try {
    // Le modele annonce "create" pour un fichier qui existe deja, et "modify"
    // pour un fichier absent : c'est le disque qui tranche.
    const provider = new IterationProvider({
      summary: 'corrections',
      changes: [
        { path: 'src/app.js', action: 'create', purpose: 'x', dependsOn: [] },
        { path: 'src/absent.js', action: 'modify', purpose: 'y', dependsOn: [] },
      ],
    });

    const llm = new LLMClient(cfg, bus, new ModelRouter(cfg, [provider]));
    const result = await iterateProject({ cfg, bus, llm }, { dir, request: 'change des choses', verify: false });

    assert.deepEqual(result.modified, ['src/app.js']);
    assert.deepEqual(result.created, ['src/absent.js']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('les chemins hors projet et .git sont rejetes', async () => {
  const { dir, cfg, bus, home } = await project();
  try {
    const provider = new IterationProvider({
      summary: 'tentative d evasion',
      changes: [
        { path: '../../evasion.js', action: 'create', purpose: 'x', dependsOn: [] },
        { path: '.git/config', action: 'modify', purpose: 'y', dependsOn: [] },
        { path: 'node_modules/paquet/index.js', action: 'modify', purpose: 'z', dependsOn: [] },
        { path: 'src/app.js', action: 'modify', purpose: 'legitime', dependsOn: [] },
      ],
    });

    const llm = new LLMClient(cfg, bus, new ModelRouter(cfg, [provider]));
    const result = await iterateProject({ cfg, bus, llm }, { dir, request: 'modifie', verify: false });

    // Seul le changement legitime est applique.
    assert.deepEqual(result.modified, ['src/app.js']);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.deleted, []);
    await assert.rejects(() => fs.access(path.join(path.dirname(dir), 'evasion.js')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('un projet vide est refuse explicitement', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-empty-home-'));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-empty-'));
  try {
    const cfg = loadConfig({ home, cache: false, cacheDir: path.join(home, 'cache'), verify: false });
    const bus = new EventBus();
    const llm = new LLMClient(cfg, bus, new ModelRouter(cfg, [new IterationProvider({ changes: [] })]));

    await assert.rejects(
      () => iterateProject({ cfg, bus, llm }, { dir, request: 'change quelque chose' }),
      /aucun fichier a modifier/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});
