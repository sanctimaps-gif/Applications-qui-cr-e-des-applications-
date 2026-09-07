import type { ForgeConfig, Tier } from '../config.js';
import type { EventBus } from '../util/events.js';
import { Semaphore } from '../util/pool.js';
import { backoffDelay, sleep, toError } from '../util/misc.js';
import { ModelRouter } from '../providers/registry.js';
import { ProviderError, type ChunkHandler, type CompletionResult, type Message } from '../providers/types.js';
import { ResponseCache } from './cache.js';

export interface AskOptions {
  tier: Tier;
  system?: string;
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  signal?: AbortSignal;
  onChunk?: ChunkHandler;
  /** Force un fournisseur pour cet appel. */
  provider?: string;
  /** Ignore le cache (utile pour les boucles de reparation). */
  noCache?: boolean;
  /** Reutilisable comme prefixe cache cote fournisseur. */
  cachePrefix?: boolean;
}

export interface UsageStats {
  requests: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  totalMs: number;
  byProvider: Record<string, { requests: number; inputTokens: number; outputTokens: number }>;
}

export class NoProviderError extends Error {
  constructor() {
    super(
      "Aucun fournisseur de modele configure. Renseignez une cle (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY, DEEPSEEK_API_KEY, OPENROUTER_API_KEY...) ou lancez un serveur local et definissez OLLAMA_BASE_URL. Voir `forge doctor`.",
    );
    this.name = 'NoProviderError';
  }
}

/**
 * Point d'entree unique vers les modeles : cache, retries avec backoff,
 * bascule inter-fournisseurs, limitation de concurrence par fournisseur et
 * comptabilite des tokens.
 */
export class LLMClient {
  readonly router: ModelRouter;
  private readonly cache: ResponseCache;
  private readonly gates = new Map<string, Semaphore>();
  readonly usage: UsageStats = {
    requests: 0,
    cacheHits: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalMs: 0,
    byProvider: {},
  };

  constructor(
    private readonly cfg: ForgeConfig,
    private readonly bus: EventBus,
    router?: ModelRouter,
  ) {
    this.router = router ?? new ModelRouter(cfg);
    this.cache = new ResponseCache(cfg.cacheDir, cfg.cache);
  }

  private gate(name: string, concurrency: number): Semaphore {
    let gate = this.gates.get(name);
    if (!gate) {
      gate = new Semaphore(concurrency);
      this.gates.set(name, gate);
    }
    return gate;
  }

  hasProvider(): boolean {
    return this.router.configured().length > 0;
  }

  /** Budget de tokens consomme (0 = illimite cote config). */
  get tokensUsed(): number {
    return this.usage.inputTokens + this.usage.outputTokens;
  }

  async ask(options: AskOptions): Promise<CompletionResult> {
    const candidates = this.router.candidates(options.tier, options.provider);
    if (candidates.length === 0) throw new NoProviderError();

    const cacheable = !options.noCache && !options.onChunk;
    const cacheKey = ResponseCache.key([
      options.tier,
      options.system ?? '',
      options.messages,
      options.temperature ?? 0,
      options.maxTokens ?? 0,
      candidates[0]!.model.id,
    ]);

    if (cacheable) {
      const hit = await this.cache.get(cacheKey);
      if (hit) {
        this.usage.cacheHits++;
        this.bus.emitEvent({
          type: 'llm',
          provider: hit.provider,
          model: hit.model,
          ms: 0,
          inputTokens: hit.inputTokens,
          outputTokens: hit.outputTokens,
          cached: true,
        });
        return {
          text: hit.text,
          provider: hit.provider,
          model: hit.model,
          inputTokens: hit.inputTokens,
          outputTokens: hit.outputTokens,
          latencyMs: 0,
          cached: true,
          attempts: 0,
        };
      }
    }

    const errors: Error[] = [];

    for (const { provider, model } of candidates) {
      const maxAttempts = Math.max(1, this.cfg.maxRetries);

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const result = await this.gate(provider.name, provider.concurrency).acquire(() =>
            provider.complete(
              {
                model: model.id,
                messages: options.messages,
                system: options.system,
                maxTokens: Math.min(options.maxTokens ?? this.cfg.maxOutputTokens, model.maxOutput),
                temperature: options.temperature,
                stop: options.stop,
                signal: options.signal,
                cachePrefix: options.cachePrefix,
              },
              options.onChunk,
            ),
          );

          this.record(result, attempt + 1);
          if (cacheable) {
            await this.cache.set(cacheKey, {
              text: result.text,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              model: result.model,
              provider: result.provider,
              at: Date.now(),
            });
          }
          return result;
        } catch (error) {
          const err = toError(error);
          errors.push(err);

          if (options.signal?.aborted) throw err;

          const retryable = err instanceof ProviderError ? err.retryable : false;
          const lastAttempt = attempt === maxAttempts - 1;
          if (!retryable || lastAttempt) {
            this.bus.log(
              'warn',
              `${provider.name}/${model.id} indisponible (${err.message.slice(0, 160)}) — bascule sur le fournisseur suivant`,
            );
            break;
          }

          const wait =
            err instanceof ProviderError && err.retryAfterMs !== undefined
              ? err.retryAfterMs
              : backoffDelay(attempt);
          this.bus.log('debug', `retry ${provider.name} dans ${wait}ms (${err.message.slice(0, 120)})`);
          await sleep(wait, options.signal);
        }
      }
    }

    throw new AggregateError(errors, `tous les fournisseurs ont echoue: ${errors.map((e) => e.message).join(' | ').slice(0, 800)}`);
  }

  /** Variante pratique : un prompt systeme + un prompt utilisateur. */
  async askText(
    tier: Tier,
    system: string,
    user: string,
    extra: Partial<AskOptions> = {},
  ): Promise<string> {
    const result = await this.ask({
      tier,
      system,
      messages: [{ role: 'user', content: user }],
      ...extra,
    });
    return result.text;
  }

  private record(result: CompletionResult, attempts: number): void {
    this.usage.requests++;
    this.usage.inputTokens += result.inputTokens;
    this.usage.outputTokens += result.outputTokens;
    this.usage.totalMs += result.latencyMs;
    const bucket = (this.usage.byProvider[result.provider] ??= {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    bucket.requests++;
    bucket.inputTokens += result.inputTokens;
    bucket.outputTokens += result.outputTokens;

    this.bus.emitEvent({
      type: 'llm',
      provider: result.provider,
      model: result.model,
      ms: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cached: false,
    });
    void attempts;
  }
}
