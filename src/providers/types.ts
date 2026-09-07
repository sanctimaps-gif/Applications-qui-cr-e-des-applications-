import type { Tier } from '../config.js';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  model: string;
  messages: Message[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  signal?: AbortSignal;
  /**
   * Marque le prefixe du prompt comme reutilisable. Les fournisseurs qui
   * supportent le cache de prompt (Anthropic, OpenAI) l'exploitent : c'est un
   * gain de latence et de cout majeur quand on genere 40 fichiers avec le meme
   * contexte de specification.
   */
  cachePrefix?: boolean;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cached: boolean;
  /** Nombre de tentatives reseau consommees. */
  attempts: number;
}

export type ChunkHandler = (delta: string) => void;

export interface ModelSpec {
  id: string;
  tier: Tier;
  /** Fenetre de contexte approximative, en tokens. */
  contextWindow: number;
  maxOutput: number;
}

export interface Provider {
  readonly name: string;
  /** Vrai si les identifiants necessaires sont presents. */
  isConfigured(): boolean;
  /** Modele a utiliser pour un palier donne. */
  modelFor(tier: Tier): ModelSpec;
  /** Requetes simultanees raisonnables pour ce fournisseur. */
  readonly concurrency: number;
  complete(req: CompletionRequest, onChunk?: ChunkHandler): Promise<CompletionResult>;
  /** Sonde legere utilisee par `forge doctor`. */
  probe?(): Promise<{ ok: boolean; detail: string }>;
}

/** Erreur transportant l'information « peut-on reessayer ? ». */
export class ProviderError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly provider: string;

  constructor(
    provider: string,
    message: string,
    opts: { status?: number; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = opts.status ?? 0;
    this.retryAfterMs = opts.retryAfterMs;
    this.retryable =
      opts.retryable ??
      (this.status === 408 ||
        this.status === 409 ||
        this.status === 429 ||
        this.status >= 500 ||
        this.status === 0);
  }
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number.parseFloat(header);
  if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}
