import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Convention Forge : **0 signifie « aucune limite »** pour tous les compteurs.
 * C'est la valeur par defaut partout — Forge n'impose aucun quota de creation.
 */
export const UNLIMITED = 0;

export type Tier = 'fast' | 'balanced' | 'deep';
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface ForgeConfig {
  /** Repertoire d'etat (cache, historique, config). */
  home: string;
  /** Racine ou sont ecrits les projets generes. */
  workspace: string;
  /** Generations de fichiers en parallele. 0 = auto (cpus x 4). */
  concurrency: number;
  /** Projets generes en parallele cote serveur. 0 = auto (cpus). */
  jobConcurrency: number;
  /** Boucles d'auto-reparation. 0 = illimite (arret quand le build passe). */
  maxRepairAttempts: number;
  /** Nombre max de fichiers par projet. 0 = illimite. */
  maxFiles: number;
  /** Nombre max de projets conserves. 0 = illimite. */
  maxProjects: number;
  /** Budget de tokens par projet. 0 = illimite. */
  maxTokens: number;
  /** Tokens de sortie max par requete modele. */
  maxOutputTokens: number;
  /** Cache disque des reponses modeles (gain de vitesse et de cout). */
  cache: boolean;
  cacheDir: string;
  /** Lancer install/build/test sur le code genere. */
  verify: boolean;
  /** Timeout d'une requete modele. */
  requestTimeoutMs: number;
  /** Timeout d'une commande shell de verification. */
  commandTimeoutMs: number;
  /** Tentatives reseau par requete modele avant bascule sur le fournisseur suivant. */
  maxRetries: number;
  /** Ordre de preference des fournisseurs. */
  providerOrder: string[];
  logLevel: LogLevel;
  port: number;
  host: string;
  authToken: string | undefined;
  github: {
    token: string | undefined;
    apiUrl: string;
    owner: string | undefined;
  };
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = env(name);
  if (raw === undefined) return fallback;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

export const DEFAULT_PROVIDER_ORDER = [
  // Local d'abord : si un modele tourne sur la machine, rien ne sort du reseau.
  'ollama',
  'lmstudio',
  'vllm',
  'llamacpp',
  'custom',
  // Puis les services, dans un ordre neutre.
  'openai',
  'anthropic',
  'google',
  'azure',
  'mistral',
  'groq',
  'deepseek',
  'xai',
  'cerebras',
  'fireworks',
  'together',
  'nebius',
  'sambanova',
  'cohere',
  'huggingface',
  'perplexity',
  'openrouter',
];

/**
 * Charge un fichier `.env` sans dependance externe. Les variables deja
 * presentes dans l'environnement ont la priorite.
 */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value !== '' && process.env[key] === undefined) process.env[key] = value;
  }
}

/** Fichier de config persistant optionnel : `~/.forge/config.json`. */
function readFileConfig(home: string): Partial<ForgeConfig> {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) as Partial<ForgeConfig>;
  } catch {
    return {};
  }
}

export function loadConfig(overrides: Partial<ForgeConfig> = {}): ForgeConfig {
  const home = overrides.home ?? env('FORGE_HOME') ?? path.join(os.homedir(), '.forge');
  const fileCfg = readFileConfig(home);

  const cfg: ForgeConfig = {
    home,
    workspace:
      env('FORGE_WORKSPACE') ?? fileCfg.workspace ?? path.join(os.homedir(), 'forge-projects'),
    concurrency: envInt('FORGE_CONCURRENCY', fileCfg.concurrency ?? 0),
    jobConcurrency: envInt('FORGE_JOB_CONCURRENCY', fileCfg.jobConcurrency ?? 0),
    maxRepairAttempts: envInt('FORGE_MAX_REPAIR_ATTEMPTS', fileCfg.maxRepairAttempts ?? UNLIMITED),
    maxFiles: envInt('FORGE_MAX_FILES', fileCfg.maxFiles ?? UNLIMITED),
    maxProjects: envInt('FORGE_MAX_PROJECTS', fileCfg.maxProjects ?? UNLIMITED),
    maxTokens: envInt('FORGE_MAX_TOKENS', fileCfg.maxTokens ?? UNLIMITED),
    maxOutputTokens: envInt('FORGE_MAX_OUTPUT_TOKENS', fileCfg.maxOutputTokens ?? 16000),
    cache: envBool('FORGE_CACHE', fileCfg.cache ?? true),
    cacheDir: env('FORGE_CACHE_DIR') ?? fileCfg.cacheDir ?? path.join(home, 'cache'),
    verify: envBool('FORGE_VERIFY', fileCfg.verify ?? true),
    requestTimeoutMs: envInt('FORGE_REQUEST_TIMEOUT_MS', fileCfg.requestTimeoutMs ?? 600_000),
    commandTimeoutMs: envInt('FORGE_COMMAND_TIMEOUT_MS', fileCfg.commandTimeoutMs ?? 300_000),
    maxRetries: envInt('FORGE_MAX_RETRIES', fileCfg.maxRetries ?? 4),
    providerOrder: (env('FORGE_PROVIDER_ORDER')?.split(',').map((s) => s.trim()).filter(Boolean) ??
      fileCfg.providerOrder ??
      DEFAULT_PROVIDER_ORDER) as string[],
    logLevel: (env('FORGE_LOG_LEVEL') as LogLevel | undefined) ?? fileCfg.logLevel ?? 'info',
    port: envInt('FORGE_PORT', fileCfg.port ?? 7331),
    host: env('FORGE_HOST') ?? fileCfg.host ?? '127.0.0.1',
    authToken: env('FORGE_AUTH_TOKEN'),
    github: {
      token: env('GITHUB_TOKEN') ?? env('GH_TOKEN') ?? env('FORGE_GITHUB_TOKEN'),
      apiUrl: (env('GITHUB_API_URL') ?? 'https://api.github.com').replace(/\/+$/, ''),
      owner: env('GITHUB_OWNER'),
    },
    ...overrides,
  };

  return cfg;
}

/** Resout une limite : 0/undefined => Infinity. */
export function limit(value: number | undefined): number {
  return value === undefined || value === UNLIMITED ? Number.POSITIVE_INFINITY : value;
}

/** Parallelisme effectif : 0 => auto. */
export function resolveConcurrency(value: number, multiplier = 4): number {
  if (value > 0) return value;
  const cpus = Math.max(1, os.cpus().length);
  return Math.max(2, cpus * multiplier);
}
