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
import { findRecipe, gitignoreFor, workflowFor } from '../recipes.js';
import { planApp } from './plan.js';
import { generateFiles } from './generate.js';
import { verifyProject } from './verify.js';
import { repairLoop } from './repair.js';
import type { AppSpec, BuildOptions, BuildResult } from './types.js';

/** Workflow CI adapte a l'ecosysteme du projet genere. */
function ciWorkflow(spec: AppSpec): string {
  return workflowFor(findRecipe(spec.runtime, spec.language), spec.commands);
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
    await workspace.write('.gitignore', gitignoreFor(findRecipe(spec.runtime, spec.language)));
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

/** Sujets GitHub deduits de la pile et des fonctionnalites du projet. */
function inferTopics(spec: AppSpec): string[] {
  const raw = [
    spec.language,
    spec.runtime,
    ...spec.stack.split(/[\s,+/()]+/),
    ...spec.features.slice(0, 4),
  ];
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const entry of raw) {
    const topic = slugify(entry ?? '', '');
    if (topic && topic.length >= 2 && !seen.has(topic)) {
      seen.add(topic);
      topics.push(topic);
    }
  }
  return topics.slice(0, 12);
}

export type PublishOptions = Pick<
  BuildOptions,
  | 'repoName'
  | 'repoPrivate'
  | 'repoOwner'
  | 'prompt'
  | 'branch'
  | 'pullRequest'
  | 'release'
  | 'topics'
  | 'pages'
>;

/**
 * Cree le depot GitHub et y pousse l'integralite du projet en un commit, puis
 * applique tout ce qui a ete demande : branche dediee, pull request, sujets,
 * release, GitHub Pages. Chaque etape optionnelle echoue isolement — une
 * release refusee ne doit pas annuler une publication reussie.
 */
export async function publishProject(
  deps: ForgeDeps,
  workspace: Workspace,
  spec: AppSpec,
  options: PublishOptions,
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
  bus.emitEvent({ type: 'github', action: 'depot pret', url: repo.htmlUrl });

  const defaultBranch = repo.defaultBranch || 'main';
  const target = options.branch ?? defaultBranch;

  // Une branche dediee n'a de sens que si la branche par defaut existe deja.
  if (target !== defaultBranch) {
    try {
      await client.createBranch({ owner: repo.owner, repo: repo.name, branch: target, from: defaultBranch });
    } catch {
      bus.log('warn', `branche ${defaultBranch} absente, publication directe sur ${target}`);
    }
  }

  const paths = await workspace.list();
  const files = await collectFiles(workspace.root, paths);

  const { commitSha } = await client.pushFiles({
    owner: repo.owner,
    repo: repo.name,
    branch: target,
    message: `feat: ${spec.name}\n\nGenere par Forge.\nDemande : ${(options.prompt ?? '').slice(0, 500)}`,
    files,
  });

  bus.emitEvent({
    type: 'github',
    action: `${files.length} fichiers pousses sur ${target} (${commitSha.slice(0, 7)})`,
    url: repo.htmlUrl,
  });

  const result: NonNullable<BuildResult['repo']> = {
    url: repo.htmlUrl,
    cloneUrl: repo.cloneUrl,
    owner: repo.owner,
    name: repo.name,
    branch: target,
  };

  const optional = async (label: string, task: () => Promise<void>): Promise<void> => {
    try {
      await task();
    } catch (error) {
      bus.log('warn', `${label} impossible: ${toError(error).message.slice(0, 200)}`);
    }
  };

  await optional('sujets', async () => {
    const topics = options.topics ?? inferTopics(spec);
    if (topics.length === 0) return;
    result.topics = await client.setTopics(repo.owner, repo.name, topics);
    bus.emitEvent({ type: 'github', action: `sujets: ${result.topics.join(', ')}` });
  });

  if (options.pullRequest && target !== defaultBranch) {
    await optional('pull request', async () => {
      const pr = await client.createPullRequest({
        owner: repo.owner,
        repo: repo.name,
        title: `feat: ${spec.name}`,
        head: target,
        base: defaultBranch,
        body: [
          spec.summary,
          '',
          `**Pile** : ${spec.stack}`,
          spec.features.length > 0 ? `\n**Fonctionnalites**\n${spec.features.map((f) => `- ${f}`).join('\n')}` : '',
          '',
          '_Genere par Forge._',
        ].join('\n'),
      });
      result.pullRequestUrl = pr.url;
      bus.emitEvent({ type: 'github', action: `pull request #${pr.number}`, url: pr.url });
    });
  }

  if (options.release) {
    await optional('release', async () => {
      const release = await client.createRelease({
        owner: repo.owner,
        repo: repo.name,
        tag: options.release!,
        name: `${spec.name} ${options.release}`,
        body: `${spec.summary}\n\nPile : ${spec.stack}\n\n_Genere par Forge._`,
        target,
      });
      result.releaseUrl = release.url;
      bus.emitEvent({ type: 'github', action: `release ${release.tag}`, url: release.url });
    });
  }

  if (options.pages) {
    await optional('GitHub Pages', async () => {
      const url = await client.enablePages(repo.owner, repo.name, target);
      if (url) {
        result.pagesUrl = url;
        await client.updateRepo(repo.owner, repo.name, { homepage: url });
        bus.emitEvent({ type: 'github', action: 'GitHub Pages actif', url });
      }
    });
  }

  return result;
}
