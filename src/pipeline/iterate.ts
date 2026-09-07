import path from 'node:path';
import type { ForgeConfig } from '../config.js';
import { resolveConcurrency } from '../config.js';
import type { EventBus } from '../util/events.js';
import type { LLMClient } from '../llm/client.js';
import { Pool } from '../util/pool.js';
import { extractCode, extractJson } from '../util/json.js';
import { isRecord, toError, truncate } from '../util/misc.js';
import { Workspace, normalizeRelPath } from '../fs/workspace.js';
import { detectRecipe, fillCommands } from '../recipes.js';
import { run } from '../fs/exec.js';
import { topologicalWaves } from './graph.js';
import { verifyProject } from './verify.js';
import { repairLoop } from './repair.js';
import type { AppSpec, FileSpec, VerificationReport } from './types.js';
import type { ForgeDeps } from './orchestrator.js';
import { publishProject } from './orchestrator.js';
import type { BuildResult } from './types.js';

export interface IterateOptions {
  /** Repertoire du projet existant. */
  dir: string;
  /** Modification demandee, en langage naturel. */
  request: string;
  verify?: boolean;
  maxRepairAttempts?: number;
  provider?: string;
  signal?: AbortSignal;
  /** Publie la modification sur GitHub. */
  github?: boolean;
  repoName?: string;
  repoOwner?: string;
  repoPrivate?: boolean;
  branch?: string;
  pullRequest?: boolean;
  commitMessage?: string;
}

export interface IterateResult {
  projectDir: string;
  summary: string;
  created: string[];
  modified: string[];
  deleted: string[];
  verification: VerificationReport;
  repairAttempts: number;
  ms: number;
  usage: { requests: number; cacheHits: number; inputTokens: number; outputTokens: number };
  repo?: BuildResult['repo'];
}

type Action = 'create' | 'modify' | 'delete';

interface Change {
  path: string;
  action: Action;
  purpose: string;
  dependsOn: string[];
}

const SELECT_SYSTEM = `Tu prepares la modification d'un projet existant.

On te donne l'arborescence du projet et la modification demandee. Indique quels fichiers tu dois LIRE pour travailler correctement : ceux qui seront modifies, et ceux dont il faut respecter les interfaces.

Choisis au plus 25 fichiers, les plus pertinents. Ne demande pas de fichiers binaires ni de dependances installees.

Reponds UNIQUEMENT par : { "read": ["chemin", ...] }`;

const PLAN_SYSTEM = `Tu planifies la modification d'un projet existant.

REGLES
- Change le moins de fichiers possible, mais tous ceux qui sont necessaires a la coherence du projet.
- "action" vaut "modify" pour un fichier existant, "create" pour un nouveau, "delete" pour une suppression.
- Mets a jour le manifeste de dependances si tu ajoutes une dependance, et les tests si le comportement change.
- Ne supprime jamais un fichier de tests pour faire passer le build.
- "dependsOn" ne liste que des chemins du projet.

Reponds UNIQUEMENT par un JSON :
{ "summary": string, "changes": [{ "path": string, "action": "create"|"modify"|"delete", "purpose": string, "dependsOn": string[] }] }`;

const EDIT_SYSTEM = `Tu ecris le contenu complet d'UN SEUL fichier d'un projet existant, apres modification.

REGLES ABSOLUES
- Renvoie le fichier ENTIER apres modification, jamais un extrait, jamais un diff.
- Preserve tout ce qui n'est pas concerne par la demande : code, commentaires, mise en forme.
- Respecte les interfaces des autres fichiers qui te sont fournis.
- Jamais de "...", de "TODO" ni de code a completer.
- Ta reponse contient UNIQUEMENT le contenu du fichier dans un seul bloc de code.`;

/** Fichiers a ne jamais proposer au modele ni modifier automatiquement. */
const EXCLUDED = /(^|\/)(\.git|node_modules|dist|build|target|\.next|venv|__pycache__)(\/|$)/;

function parseChanges(text: string, existing: Set<string>): Change[] {
  const raw = extractJson<unknown>(text);
  if (!isRecord(raw) || !Array.isArray(raw['changes'])) return [];

  const changes: Change[] = [];
  const seen = new Set<string>();

  for (const entry of raw['changes']) {
    if (!isRecord(entry) || typeof entry['path'] !== 'string') continue;
    const filePath = normalizeRelPath(entry['path']);
    if (!filePath || seen.has(filePath) || EXCLUDED.test(filePath)) continue;

    const declared = typeof entry['action'] === 'string' ? entry['action'] : 'modify';
    // On fait confiance au disque, pas au modele : un fichier absent se cree.
    const action: Action =
      declared === 'delete' ? 'delete' : existing.has(filePath) ? 'modify' : 'create';

    seen.add(filePath);
    changes.push({
      path: filePath,
      action,
      purpose: typeof entry['purpose'] === 'string' ? entry['purpose'] : 'modification demandee',
      dependsOn: Array.isArray(entry['dependsOn'])
        ? entry['dependsOn']
            .filter((dep): dep is string => typeof dep === 'string')
            .map(normalizeRelPath)
            .filter((dep) => dep !== filePath)
        : [],
    });
  }
  return changes;
}

function summary(raw: string): string {
  const parsed = extractJson<unknown>(raw);
  return isRecord(parsed) && typeof parsed['summary'] === 'string'
    ? parsed['summary']
    : 'modification appliquee';
}

/**
 * Fait evoluer un projet deja genere. Le contexte est construit en deux temps
 * — le modele choisit d'abord les fichiers qu'il doit lire, puis planifie sur
 * cette base — pour ne pas envoyer un depot entier a chaque demande.
 */
export async function iterateProject(deps: ForgeDeps, options: IterateOptions): Promise<IterateResult> {
  const { cfg, bus, llm } = deps;
  const started = Date.now();

  if (!llm.hasProvider()) {
    const message = 'Aucun fournisseur de modele configure.';
    bus.emitEvent({ type: 'error', message });
    throw new Error(message);
  }

  const workspace = new Workspace(path.resolve(options.dir));
  const allFiles = (await workspace.list()).filter((file) => !EXCLUDED.test(file));
  if (allFiles.length === 0) {
    throw new Error(`aucun fichier a modifier dans ${workspace.root}`);
  }

  bus.emitEvent({ type: 'phase', phase: 'iterate', message: `Analyse de ${allFiles.length} fichiers` });

  // Specification reconstituee : .forge.json si present, sinon deduite.
  const manifestRaw = await workspace.tryRead('.forge.json');
  const stored = manifestRaw ? (extractJson<any>(manifestRaw) ?? {}) : {};
  const recipe = detectRecipe(allFiles);
  const spec: AppSpec = {
    name: stored?.spec?.name ?? path.basename(workspace.root),
    slug: stored?.spec?.name ?? path.basename(workspace.root),
    summary: stored?.spec?.summary ?? `Projet ${path.basename(workspace.root)}`,
    stack: stored?.spec?.stack ?? recipe.runtime,
    language: stored?.spec?.language ?? '',
    runtime: stored?.spec?.runtime ?? recipe.runtime,
    features: Array.isArray(stored?.spec?.features) ? stored.spec.features : [],
    files: allFiles.map((file) => ({
      path: file,
      purpose: 'fichier existant',
      dependsOn: [],
      complexity: 3,
      exports: [],
    })),
    commands: fillCommands(stored?.spec?.commands ?? {}, recipe, allFiles),
    env: [],
  };

  // --- 1. Le modele choisit ce qu'il a besoin de lire ----------------------
  const sizes = await Promise.all(allFiles.map((file) => workspace.size(file)));
  const tree = allFiles.map((file, i) => `${file} (${sizes[i] ?? 0} o)`).join('\n');

  const selection = await llm.askText(
    'balanced',
    SELECT_SYSTEM,
    `PROJET : ${spec.name} (${spec.stack})\n\nARBORESCENCE :\n${truncate(tree, 12_000)}\n\nMODIFICATION DEMANDEE :\n${options.request}`,
    { temperature: 0, maxTokens: 2_000, provider: options.provider, signal: options.signal },
  );

  const requested = extractJson<{ read?: unknown }>(selection);
  const known = new Set(allFiles);
  let toRead = Array.isArray(requested?.read)
    ? requested.read
        .filter((entry): entry is string => typeof entry === 'string')
        .map(normalizeRelPath)
        .filter((entry) => known.has(entry))
        .slice(0, 25)
    : [];

  // Repli : le manifeste et la documentation suffisent a se reperer.
  if (toRead.length === 0) {
    toRead = allFiles.filter((file) => /^(package\.json|README\.md|requirements\.txt|go\.mod|Cargo\.toml|pyproject\.toml)$/.test(file));
  }

  const contents = new Map<string, string>();
  await Promise.all(
    toRead.map(async (file) => {
      const content = await workspace.tryRead(file);
      if (content !== undefined) contents.set(file, content);
    }),
  );

  const contextBlocks = [...contents.entries()]
    .map(([file, content]) => `--- ${file} ---\n${truncate(content, 8_000)}`)
    .join('\n\n');

  // --- 2. Plan de modification --------------------------------------------
  bus.emitEvent({ type: 'phase', phase: 'iterate', message: 'Planification de la modification' });

  const planText = await llm.askText(
    'deep',
    PLAN_SYSTEM,
    `PROJET : ${spec.name} (${spec.stack})

ARBORESCENCE COMPLETE :
${truncate(tree, 10_000)}

FICHIERS LUS :
${truncate(contextBlocks, 60_000)}

MODIFICATION DEMANDEE :
${options.request}

Planifie les changements.`,
    { temperature: 0.1, maxTokens: 8_000, noCache: true, provider: options.provider, signal: options.signal },
  );

  const changes = parseChanges(planText, known);
  if (changes.length === 0) {
    throw new Error(`aucun changement exploitable planifie: ${planText.slice(0, 300)}`);
  }

  const description = summary(planText);
  bus.log('info', `plan : ${description} (${changes.length} fichier(s))`);

  // --- 3. Application ------------------------------------------------------
  const deletions = changes.filter((change) => change.action === 'delete');
  const edits = changes.filter((change) => change.action !== 'delete');

  const deleted: string[] = [];
  for (const change of deletions) {
    if (await workspace.remove(change.path)) {
      deleted.push(change.path);
      bus.log('info', `supprime : ${change.path}`);
    }
  }

  const asFileSpecs: FileSpec[] = edits.map((change) => ({
    path: change.path,
    purpose: change.purpose,
    dependsOn: change.dependsOn.filter((dep) => edits.some((other) => other.path === dep)),
    complexity: 4,
    exports: [],
  }));

  const pool = new Pool(resolveConcurrency(cfg.concurrency));
  const created: string[] = [];
  const modified: string[] = [];
  const waves = topologicalWaves(asFileSpecs);
  let index = 0;
  const total = asFileSpecs.length;

  for (const wave of waves) {
    await pool.settle(wave, async (file) => {
      const change = edits.find((entry) => entry.path === file.path)!;
      const position = ++index;
      bus.emitEvent({ type: 'file:start', path: file.path, index: position, total });
      const fileStarted = Date.now();

      const current = await workspace.tryRead(file.path);
      const related = [...contents.entries()]
        .filter(([name]) => name !== file.path && file.dependsOn.includes(name))
        .map(([name, content]) => `--- ${name} ---\n${truncate(content, 6_000)}`);

      const user = `Fichier : ${file.path}
Action : ${change.action === 'create' ? 'creation' : 'modification'}
But : ${change.purpose}

MODIFICATION GLOBALE DEMANDEE :
${options.request}

${current !== undefined ? `CONTENU ACTUEL :\n\`\`\`\n${truncate(current, 20_000)}\n\`\`\`` : 'Ce fichier est nouveau.'}

${related.length > 0 ? `FICHIERS LIES :\n\n${related.join('\n\n')}` : ''}

Ecris le contenu complet de ${file.path} apres modification.`;

      try {
        const result = await llm.ask({
          tier: 'deep',
          system: `${EDIT_SYSTEM}\n\nPROJET : ${spec.name} — ${spec.summary}\nPILE : ${spec.stack}`,
          messages: [{ role: 'user', content: user }],
          temperature: 0,
          maxTokens: Math.min(16_000, cfg.maxOutputTokens),
          noCache: true,
          provider: options.provider,
          signal: options.signal,
        });

        const content = extractCode(result.text);
        if (!content.trim()) throw new Error('contenu vide renvoye par le modele');

        const bytes = await workspace.write(file.path, content);
        contents.set(file.path, content);
        (change.action === 'create' ? created : modified).push(file.path);
        bus.emitEvent({
          type: 'file:done',
          path: file.path,
          bytes,
          ms: Date.now() - fileStarted,
          index: position,
          total,
        });
      } catch (error) {
        bus.emitEvent({ type: 'file:error', path: file.path, error: toError(error).message });
      }
    });
  }

  // --- 4. Verification et reparation --------------------------------------
  const shouldVerify = options.verify ?? cfg.verify;
  let verification: VerificationReport = { ran: false, ok: true, steps: [], failureDigest: '' };
  let repairAttempts = 0;

  if (shouldVerify) {
    // Le projet existe deja : ses dependances le sont probablement aussi.
    verification = await verifyProject(bus, cfg, spec, workspace.root, { signal: options.signal });
    if (!verification.ok) {
      const repaired = await repairLoop(llm, bus, cfg, spec, workspace, verification, {
        maxAttempts: options.maxRepairAttempts,
        provider: options.provider,
        signal: options.signal,
      });
      verification = repaired.verification;
      repairAttempts = repaired.attempts;
    }
  }

  // --- 5. Commit local -----------------------------------------------------
  const message = options.commitMessage ?? `feat: ${description.slice(0, 120)}`;
  const commit = await run(
    `git add -A && git -c user.email=forge@localhost -c user.name=Forge commit -q --no-gpg-sign -m ${JSON.stringify(message)}`,
    { cwd: workspace.root, timeoutMs: 60_000 },
  );
  bus.log(commit.code === 0 ? 'info' : 'warn', commit.code === 0 ? `commit : ${message}` : 'commit local ignore');

  const result: IterateResult = {
    projectDir: workspace.root,
    summary: description,
    created,
    modified,
    deleted,
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

  // --- 6. Publication ------------------------------------------------------
  if (options.github) {
    try {
      result.repo = await publishProject(deps, workspace, spec, {
        prompt: options.request,
        repoName: options.repoName ?? spec.slug,
        repoOwner: options.repoOwner,
        repoPrivate: options.repoPrivate ?? true,
        branch: options.branch,
        pullRequest: options.pullRequest,
      });
    } catch (error) {
      bus.log('error', `publication GitHub impossible: ${toError(error).message}`);
    }
  }

  bus.emitEvent({
    type: 'done',
    projectDir: result.projectDir,
    files: created.length + modified.length,
    ms: result.ms,
    repoUrl: result.repo?.url,
  });

  return result;
}
