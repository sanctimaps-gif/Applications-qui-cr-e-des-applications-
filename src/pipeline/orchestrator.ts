import path from 'node:path';
import fs from 'node:fs/promises';
import type { ForgeConfig } from '../config.js';
import { loadConfig } from '../config.js';
import { EventBus } from '../util/events.js';
import { LLMClient } from '../llm/client.js';
import { Workspace } from '../fs/workspace.js';
import { slugify, toError } from '../util/misc.js';
import { GitHubClient, collectFiles } from '../git/github.js';
import { initRepo } from '../git/local.js';
import { planApp } from './plan.js';
import { generateFiles } from './generate.js';
import { verifyProject } from './verify.js';
import { repairLoop } from './repair.js';
import type { AppSpec, BuildOptions, BuildResult } from './types.js';

/** Workflow CI ajoute au projet genere quand `--ci` est demande. */
function ciWorkflow(spec: AppSpec): string {
  const node = spec.runtime === 'node';
  const steps = [
    '      - uses: actions/checkout@v4',
    ...(node
      ? [
          '      - uses: actions/setup-node@v4',
          '        with:',
          "          node-version: '20'",
        ]
      : spec.runtime === 'python'
        ? [
            '      - uses: actions/setup-python@v5',
            '        with:',
            "          python-version: '3.12'",
          ]
        : []),
    ...(spec.commands.install ? [`      - run: ${spec.commands.install}`] : []),
    ...(spec.commands.lint ? [`      - run: ${spec.commands.lint}`] : []),
    ...(spec.commands.build ? [`      - run: ${spec.commands.build}`] : []),
    ...(spec.commands.test ? [`      - run: ${spec.commands.test}`] : []),
  ];

  return `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${steps.join('\n')}
`;
}

function forgeManifest(spec: AppSpec, options: BuildOptions, usage: unknown): string {
  return `${JSON.stringify(
    {
      generator: 'forge-ai',
      generatedAt: new Date().toISOString(),
      prompt: options.prompt,
      spec: {
        name: spec.name,
        stack: spec.stack,
        language: spec.language,
        runtime: spec.runtime,
        features: spec.features,
        commands: spec.commands,
      },
      usage,
    },
    null,
    2,
  )}\n`;
}

/** Repertoire de sortie unique : jamais d'ecrasement silencieux. */
async function uniqueDir(base: string, slug: string): Promise<string> {
  let candidate = path.join(base, slug);
  let counter = 2;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(base, `${slug}-${counter++}`);
    } catch {
      return candidate;
    }
  }
}

export interface ForgeDeps {
  cfg: ForgeConfig;
  bus: EventBus;
  llm: LLMClient;
}

export function createForge(overrides: Partial<ForgeConfig> = {}, bus = new EventBus()): ForgeDeps {
  const cfg = loadConfig(overrides);
  return { cfg, bus, llm: new LLMClient(cfg, bus) };
}

/**
 * Pipeline complet : plan -> generation parallele -> verification reelle ->
 * auto-reparation -> git -> publication GitHub.
 *
 * Aucune etape n'impose de quota : le nombre de fichiers, de projets et de
 * boucles de reparation est illimite par defaut (`0` en configuration).
 */
export async function buildApp(deps: ForgeDeps, options: BuildOptions): Promise<BuildResult> {
  const { cfg, bus, llm } = deps;
  const started = Date.now();

  if (!llm.hasProvider()) {
    const message =
      "Aucun fournisseur de modele configure. Lancez `forge doctor` pour la liste des variables d'environnement acceptees.";
    bus.emitEvent({ type: 'error', message });
    throw new Error(message);
  }

  // 1. Plan
  const spec = await planApp(llm, bus, cfg, options);

  // 2. Espace de travail
  const outDir =
    options.outDir ?? (await uniqueDir(cfg.workspace, slugify(options.name ?? spec.slug)));
  const workspace = await Workspace.create(outDir);
  bus.log('info', `projet : ${outDir}`);

  // 3. Generation parallele
  const files = await generateFiles(llm, bus, cfg, spec, workspace, {
    provider: options.provider,
    signal: options.signal,
  });

  // 4. Fichiers d'accompagnement
  if (options.withCi && !(await workspace.exists('.github/workflows/ci.yml'))) {
    await workspace.write('.github/workflows/ci.yml', ciWorkflow(spec));
  }
  if (!(await workspace.exists('.gitignore'))) {
    await workspace.write(
      '.gitignore',
      'node_modules/\ndist/\nbuild/\n.env\n__pycache__/\n*.log\n.DS_Store\n',
    );
  }
  await workspace.write('.forge.json', forgeManifest(spec, options, llm.usage));

  // 5. Verification reelle
  const shouldVerify = options.verify ?? cfg.verify;
  let verification = shouldVerify
    ? await verifyProject(bus, cfg, spec, workspace.root, { signal: options.signal })
    : { ran: false, ok: true, steps: [], failureDigest: '' };

  // 6. Auto-reparation
  let repairAttempts = 0;
  if (shouldVerify && !verification.ok) {
    const repaired = await repairLoop(llm, bus, cfg, spec, workspace, verification, {
      maxAttempts: options.maxRepairAttempts,
      provider: options.provider,
      signal: options.signal,
    });
    verification = repaired.verification;
    repairAttempts = repaired.attempts;
  }

  // 7. Depot git local
  const git = await initRepo(workspace.root, {
    message: `feat: ${spec.name}\n\nGenere par Forge a partir de : ${options.prompt.slice(0, 300)}`,
  });
  bus.log(git.ok ? 'info' : 'warn', git.detail);

  const result: BuildResult = {
    spec,
    projectDir: workspace.root,
    files,
    verification,
    repairAttempts,
    ms: Date.now() - started,
    usage: {
      requests: llm.usage.requests,
      cacheHits: llm.usage.cacheHits,
      inputTokens: llm.usage.inputTokens,
      outputTokens: llm.usage.outputTokens,
    },
  };

  // 8. Publication GitHub
  if (options.github) {
    try {
      result.repo = await publishProject(deps, workspace, spec, options);
    } catch (error) {
      const err = toError(error);
      bus.log('error', `publication GitHub impossible: ${err.message}`);
    }
  }

  bus.emitEvent({
    type: 'done',
    projectDir: result.projectDir,
    files: files.length,
    ms: result.ms,
    repoUrl: result.repo?.url,
  });

  return result;
}

/** Cree le depot GitHub et y pousse l'integralite du projet en un commit. */
export async function publishProject(
  deps: ForgeDeps,
  workspace: Workspace,
  spec: AppSpec,
  options: Pick<BuildOptions, 'repoName' | 'repoPrivate' | 'repoOwner' | 'prompt'>,
): Promise<NonNullable<BuildResult['repo']>> {
  const { cfg, bus } = deps;
  const client = new GitHubClient(cfg);

  bus.emitEvent({ type: 'phase', phase: 'github', message: 'Publication sur GitHub' });

  const owner = options.repoOwner ?? cfg.github.owner;
  const repo = await client.createRepo({
    name: slugify(options.repoName ?? spec.slug),
    description: spec.summary,
    private: options.repoPrivate ?? true,
    owner,
  });
  bus.emitEvent({ type: 'github', action: 'repo cree', url: repo.htmlUrl });

  const paths = await workspace.list();
  const files = await collectFiles(workspace.root, paths);
  const branch = repo.defaultBranch || 'main';

  const { commitSha } = await client.pushFiles({
    owner: repo.owner,
    repo: repo.name,
    branch,
    message: `feat: ${spec.name}\n\nGenere par Forge.\nDemande : ${(options.prompt ?? '').slice(0, 500)}`,
    files,
  });

  bus.emitEvent({
    type: 'github',
    action: `${files.length} fichiers pousses (${commitSha.slice(0, 7)})`,
    url: repo.htmlUrl,
  });

  return {
    url: repo.htmlUrl,
    cloneUrl: repo.cloneUrl,
    owner: repo.owner,
    name: repo.name,
    branch,
  };
}
