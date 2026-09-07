import type { LLMClient } from '../llm/client.js';
import type { EventBus } from '../util/events.js';
import type { ForgeConfig, Tier } from '../config.js';
import { resolveConcurrency } from '../config.js';
import { Pool } from '../util/pool.js';
import { extractCode } from '../util/json.js';
import { truncate } from '../util/misc.js';
import type { Workspace } from '../fs/workspace.js';
import type { AppSpec, FileSpec, GeneratedFile } from './types.js';
import { topologicalWaves } from './graph.js';

const CODER_SYSTEM = `Tu ecris le contenu complet d'UN SEUL fichier d'un projet logiciel.

REGLES ABSOLUES
- Renvoie le fichier entier, pret a l'emploi. Jamais de "...", jamais de "TODO", jamais de code a completer.
- Respecte exactement les interfaces exposees par les fichiers deja ecrits qui te sont fournis.
- N'importe que des modules declares dans le manifeste de dependances du projet.
- Code de qualite production : gestion des erreurs, types precis, noms explicites.
- Commente uniquement ce qui n'est pas evident a la lecture.
- Aucun secret en dur.
- Ta reponse contient UNIQUEMENT le contenu du fichier dans un seul bloc de code, sans explication avant ni apres.`;

/** Un fichier de configuration n'a pas besoin du modele le plus cher. */
function tierFor(file: FileSpec): Tier {
  if (file.complexity >= 4) return 'deep';
  if (file.complexity <= 1) return 'fast';
  return 'balanced';
}

function budgetFor(file: FileSpec, cfg: ForgeConfig): number {
  const base = file.complexity >= 4 ? 16_000 : file.complexity >= 3 ? 12_000 : 6_000;
  return Math.min(base, cfg.maxOutputTokens);
}

/** Contexte partage a tous les fichiers : mis en cache cote fournisseur. */
function specDigest(spec: AppSpec): string {
  const files = spec.files
    .map((f) => `- ${f.path} — ${f.purpose}${f.exports?.length ? ` [expose: ${f.exports.join(', ')}]` : ''}`)
    .join('\n');
  const env = spec.env.map((e) => `- ${e.name}: ${e.description}`).join('\n') || '- (aucune)';
  const commands = Object.entries(spec.commands)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `- ${key}: ${value}`)
    .join('\n');

  return `PROJET : ${spec.name}
RESUME : ${spec.summary}
PILE : ${spec.stack} (${spec.language}, runtime ${spec.runtime})
FONCTIONNALITES :
${spec.features.map((f) => `- ${f}`).join('\n') || '- (non precisees)'}

ARBORESCENCE COMPLETE PLANIFIEE :
${files}

COMMANDES :
${commands || '- (aucune)'}

VARIABLES D'ENVIRONNEMENT :
${env}
${spec.notes ? `\nNOTES : ${spec.notes}` : ''}`;
}

export interface GenerationContext {
  spec: AppSpec;
  workspace: Workspace;
  /** Contenu des fichiers deja produits, indexe par chemin. */
  written: Map<string, string>;
}

async function generateOne(
  llm: LLMClient,
  bus: EventBus,
  cfg: ForgeConfig,
  ctx: GenerationContext,
  file: FileSpec,
  index: number,
  total: number,
  options: { provider?: string; signal?: AbortSignal },
): Promise<GeneratedFile> {
  const started = Date.now();
  bus.emitEvent({ type: 'file:start', path: file.path, index, total });

  // On n'envoie que les dependances declarees : le contexte reste petit,
  // donc rapide et peu couteux, meme sur un projet de 100 fichiers.
  const deps = file.dependsOn
    .map((dep) => {
      const content = ctx.written.get(dep);
      return content ? `--- ${dep} ---\n${truncate(content, 6_000)}` : undefined;
    })
    .filter((chunk): chunk is string => Boolean(chunk));

  const manifest = ['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml']
    .filter((name) => name !== file.path)
    .map((name) => {
      const content = ctx.written.get(name);
      return content ? `--- ${name} ---\n${truncate(content, 3_000)}` : undefined;
    })
    .filter((chunk): chunk is string => Boolean(chunk));

  const contextBlocks = [...manifest, ...deps];

  const user = `Fichier a ecrire : ${file.path}

Role de ce fichier : ${file.purpose}
${file.exports?.length ? `Il doit exposer : ${file.exports.join(', ')}` : ''}

${contextBlocks.length > 0 ? `FICHIERS DEJA ECRITS DONT TU DOIS RESPECTER LES INTERFACES :\n\n${contextBlocks.join('\n\n')}` : 'Aucun fichier de contexte : ce fichier vient en premier.'}

Ecris maintenant le contenu complet de ${file.path}.`;

  const result = await llm.ask({
    tier: tierFor(file),
    system: `${CODER_SYSTEM}\n\n=== CONTEXTE DU PROJET ===\n${specDigest(ctx.spec)}`,
    messages: [{ role: 'user', content: user }],
    temperature: 0.1,
    maxTokens: budgetFor(file, cfg),
    cachePrefix: true,
    provider: options.provider,
    signal: options.signal,
  });

  const content = extractCode(result.text);
  const bytes = await ctx.workspace.write(file.path, content);
  ctx.written.set(file.path, content);

  const ms = Date.now() - started;
  bus.emitEvent({ type: 'file:done', path: file.path, bytes, ms, index, total });
  return { path: file.path, content, bytes, ms };
}

/**
 * Phase 2 — generation. Les fichiers sont produits vague par vague ; a
 * l'interieur d'une vague, tout part en parallele jusqu'a la limite de
 * concurrence (par defaut : cpus x 4, et sans limite si configure a 0).
 */
export async function generateFiles(
  llm: LLMClient,
  bus: EventBus,
  cfg: ForgeConfig,
  spec: AppSpec,
  workspace: Workspace,
  options: { provider?: string; signal?: AbortSignal } = {},
): Promise<GeneratedFile[]> {
  const waves = topologicalWaves(spec.files);
  const pool = new Pool(resolveConcurrency(cfg.concurrency));
  const ctx: GenerationContext = { spec, workspace, written: new Map() };
  const produced: GeneratedFile[] = [];
  const total = spec.files.length;
  let index = 0;

  bus.emitEvent({
    type: 'phase',
    phase: 'generate',
    message: `Generation de ${total} fichiers en ${waves.length} vagues (parallelisme ${pool.limit === Infinity ? 'illimite' : pool.limit})`,
  });

  for (const [waveIndex, wave] of waves.entries()) {
    bus.log('debug', `vague ${waveIndex + 1}/${waves.length} — ${wave.length} fichiers`);

    const results = await pool.settle(wave, (file) => {
      const position = ++index;
      return generateOne(llm, bus, cfg, ctx, file, position, total, options);
    });

    for (const [i, outcome] of results.entries()) {
      const file = wave[i]!;
      if (outcome.ok) {
        produced.push(outcome.value);
      } else {
        // Un fichier rate ne fait pas tomber le projet : il sera repris par
        // la boucle de reparation, qui voit l'erreur de build correspondante.
        bus.emitEvent({ type: 'file:error', path: file.path, error: outcome.error.message });
      }
    }
  }

  return produced;
}

/** Regeneration ciblee d'un fichier, utilisee par la boucle de reparation. */
export async function regenerateFile(
  llm: LLMClient,
  bus: EventBus,
  cfg: ForgeConfig,
  spec: AppSpec,
  workspace: Workspace,
  filePath: string,
  problem: string,
  options: { provider?: string; signal?: AbortSignal } = {},
): Promise<GeneratedFile | undefined> {
  const file = spec.files.find((f) => f.path === filePath) ?? {
    path: filePath,
    purpose: 'Fichier ajoute pendant la reparation',
    dependsOn: [],
    complexity: 4,
    exports: [],
  };

  const current = await workspace.tryRead(filePath);
  const started = Date.now();

  const user = `Fichier a corriger : ${filePath}
Role : ${file.purpose}

PROBLEME CONSTATE (sortie reelle des commandes du projet) :
${truncate(problem, 8_000)}

${current ? `CONTENU ACTUEL :\n\`\`\`\n${truncate(current, 12_000)}\n\`\`\`` : 'Ce fichier est absent et doit etre cree.'}

Renvoie le contenu complet et corrige de ${filePath}. Corrige la cause du probleme, ne contourne pas le symptome et ne desactive aucun test.`;

  const result = await llm.ask({
    tier: 'deep',
    system: `${CODER_SYSTEM}\n\n=== CONTEXTE DU PROJET ===\n${specDigest(spec)}`,
    messages: [{ role: 'user', content: user }],
    temperature: 0,
    maxTokens: Math.min(16_000, cfg.maxOutputTokens),
    noCache: true,
    provider: options.provider,
    signal: options.signal,
  });

  const content = extractCode(result.text);
  if (!content.trim()) return undefined;
  const bytes = await workspace.write(filePath, content);
  return { path: filePath, content, bytes, ms: Date.now() - started };
}
