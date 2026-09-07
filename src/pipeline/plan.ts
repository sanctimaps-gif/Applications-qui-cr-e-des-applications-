import type { LLMClient } from '../llm/client.js';
import type { EventBus } from '../util/events.js';
import type { ForgeConfig } from '../config.js';
import { limit } from '../config.js';
import { parseJsonOrThrow } from '../util/json.js';
import { isRecord, slugify } from '../util/misc.js';
import { normalizeRelPath } from '../fs/workspace.js';
import { fillCommands, findRecipe } from '../recipes.js';
import type { AppSpec, BuildOptions, FileSpec } from './types.js';

const PLANNER_SYSTEM = `Tu es un architecte logiciel. A partir d'une demande, tu produis le plan complet d'une application reelle, immediatement executable.

REGLES
- Choisis la pile la plus simple qui repond serieusement au besoin. Prefere des dependances stables et repandues.
- Decoupe le projet en fichiers concrets. Chaque fichier a un role unique et clair.
- Liste les fichiers dans un ordre ou les dependances viennent avant leurs consommateurs.
- "dependsOn" ne contient que des chemins presents dans "files".
- Inclus TOUJOURS : le manifeste de dependances, un README.md, un .gitignore, et au moins un fichier de tests automatises.
- N'invente pas de dependances : uniquement des paquets qui existent reellement.
- Prevois des commandes d'installation, de build et de test qui fonctionnent sans interaction.
- Pas de secret en dur : les valeurs sensibles passent par des variables d'environnement declarees dans "env".

Reponds UNIQUEMENT par un objet JSON valide, sans texte autour, au schema :
{
  "name": string,
  "slug": string,
  "summary": string,
  "stack": string,
  "language": string,
  "runtime": "node" | "python" | "static" | "go" | "rust" | "other",
  "features": string[],
  "files": [{ "path": string, "purpose": string, "dependsOn": string[], "complexity": 1-5, "exports": string[] }],
  "commands": { "install": string, "build": string, "test": string, "lint": string, "start": string, "dev": string },
  "env": [{ "name": string, "description": string, "required": boolean }],
  "notes": string
}`;

function coerceFile(raw: unknown, index: number): FileSpec | undefined {
  if (!isRecord(raw)) return undefined;
  const path = typeof raw['path'] === 'string' ? raw['path'].trim() : '';
  if (!path) return undefined;
  return {
    path: normalizeRelPath(path),
    purpose: typeof raw['purpose'] === 'string' ? raw['purpose'] : `Fichier ${index + 1}`,
    dependsOn: Array.isArray(raw['dependsOn'])
      ? raw['dependsOn'].filter((d): d is string => typeof d === 'string').map(normalizeRelPath)
      : [],
    complexity:
      typeof raw['complexity'] === 'number' && raw['complexity'] >= 1 && raw['complexity'] <= 5
        ? Math.round(raw['complexity'])
        : 3,
    exports: Array.isArray(raw['exports'])
      ? raw['exports'].filter((e): e is string => typeof e === 'string')
      : [],
  };
}

function normalize(raw: unknown, options: BuildOptions, cfg: ForgeConfig): AppSpec {
  if (!isRecord(raw)) throw new Error('plan invalide: objet attendu');

  const name = options.name ?? (typeof raw['name'] === 'string' ? raw['name'] : 'app');
  const files: FileSpec[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of (Array.isArray(raw['files']) ? raw['files'] : []).entries()) {
    const file = coerceFile(entry, index);
    if (!file || seen.has(file.path)) continue;
    seen.add(file.path);
    files.push(file);
  }

  if (files.length === 0) throw new Error('plan invalide: aucun fichier planifie');

  const maxFiles = limit(cfg.maxFiles);
  const kept = Number.isFinite(maxFiles) ? files.slice(0, maxFiles) : files;
  const keptPaths = new Set(kept.map((f) => f.path));

  // Une dependance vers un fichier non planifie casserait le tri topologique.
  for (const file of kept) {
    file.dependsOn = file.dependsOn.filter((dep) => dep !== file.path && keptPaths.has(dep));
  }

  const commandsRaw = isRecord(raw['commands']) ? raw['commands'] : {};
  const pick = (key: string): string | undefined =>
    typeof commandsRaw[key] === 'string' && commandsRaw[key].trim() ? (commandsRaw[key] as string).trim() : undefined;

  const runtime = typeof raw['runtime'] === 'string' ? raw['runtime'] : 'node';
  const language = typeof raw['language'] === 'string' ? raw['language'] : 'TypeScript';
  const recipe = findRecipe(runtime, language);
  const plannedPaths = kept.map((file) => file.path);

  // Le modele oublie regulierement une commande : la recette de l'ecosysteme
  // comble les trous, mais seulement si le manifeste correspondant existe.
  const commands = fillCommands(
    {
      install: pick('install'),
      build: pick('build'),
      test: pick('test'),
      lint: pick('lint'),
      start: pick('start'),
      dev: pick('dev'),
    },
    recipe,
    plannedPaths,
  );

  return {
    name,
    slug: slugify(typeof raw['slug'] === 'string' && raw['slug'] ? raw['slug'] : name),
    summary: typeof raw['summary'] === 'string' ? raw['summary'] : options.prompt.slice(0, 300),
    stack: options.stack ?? (typeof raw['stack'] === 'string' ? raw['stack'] : 'non precise'),
    language,
    runtime,
    features: Array.isArray(raw['features'])
      ? raw['features'].filter((f): f is string => typeof f === 'string')
      : [],
    files: kept,
    commands,
    env: Array.isArray(raw['env'])
      ? raw['env'].flatMap((e) =>
          isRecord(e) && typeof e['name'] === 'string'
            ? [
                {
                  name: e['name'],
                  description: typeof e['description'] === 'string' ? e['description'] : '',
                  required: e['required'] !== false,
                },
              ]
            : [],
        )
      : [],
    notes: typeof raw['notes'] === 'string' ? raw['notes'] : undefined,
  };
}

/**
 * Phase 1 — planification. Un seul appel au modele le plus capable ; tout le
 * reste du pipeline s'appuie sur ce plan, il vaut donc la depense.
 */
export async function planApp(
  llm: LLMClient,
  bus: EventBus,
  cfg: ForgeConfig,
  options: BuildOptions,
): Promise<AppSpec> {
  bus.emitEvent({ type: 'phase', phase: 'plan', message: 'Conception de l architecture' });

  const constraints = [
    options.stack ? `Pile imposee : ${options.stack}.` : '',
    options.name ? `Nom impose : ${options.name}.` : '',
    options.withCi ? 'Prevois un workflow GitHub Actions dans .github/workflows/ci.yml.' : '',
  ]
    .filter(Boolean)
    .join('\n');

  const user = `Demande de l'utilisateur :
"""
${options.prompt}
"""
${constraints}

Produis le plan JSON complet de cette application.`;

  const attempt = async (extra?: string): Promise<AppSpec> => {
    const text = await llm.askText('deep', PLANNER_SYSTEM, extra ? `${user}\n\n${extra}` : user, {
      temperature: 0.2,
      maxTokens: 16_000,
      signal: options.signal,
      provider: options.provider,
      noCache: Boolean(extra),
    });
    return normalize(parseJsonOrThrow(text, 'le plan'), options, cfg);
  };

  let spec: AppSpec;
  try {
    spec = await attempt();
  } catch (error) {
    bus.log('warn', `plan rejete (${(error as Error).message.slice(0, 200)}), nouvelle tentative`);
    spec = await attempt(
      'La reponse precedente etait invalide. Renvoie STRICTEMENT le JSON demande, sans commentaire ni bloc de code.',
    );
  }

  bus.emitEvent({ type: 'plan', files: spec.files.length, stack: spec.stack, name: spec.name });
  return spec;
}
