import type { Tier } from '../config.js';
import {
  type ChunkHandler,
  type CompletionRequest,
  type CompletionResult,
  type ModelSpec,
  type Provider,
  ProviderError,
  parseRetryAfter,
} from './types.js';
import { readSseTyped } from './sse.js';

const MODELS: Record<Tier, ModelSpec> = {
  deep: { id: 'claude-opus-5', tier: 'deep', contextWindow: 200_000, maxOutput: 32_000 },
  balanced: { id: 'claude-sonnet-5', tier: 'balanced', contextWindow: 200_000, maxOutput: 32_000 },
  fast: {
    id: 'claude-haiku-4-5-20251001',
    tier: 'fast',
    contextWindow: 200_000,
    maxOutput: 16_000,
  },
};

interface AnthropicBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  error?: { message?: string };
}

/**
 * API Messages d'Anthropic. Exploite `cache_control` pour mettre en cache le
 * prefixe du prompt (specification du projet), ce qui reduit fortement la
 * latence et le cout sur les generations de fichiers en rafale.
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  readonly concurrency: number;

  constructor(private readonly timeoutMs: number, concurrency = 12) {
    this.concurrency = concurrency;
  }

  isConfigured(): boolean {
    return Boolean(process.env['ANTHROPIC_API_KEY']);
  }

  modelFor(tier: Tier): ModelSpec {
    const override = process.env[`FORGE_ANTHROPIC_MODEL_${tier.toUpperCase()}`];
    const base = MODELS[tier];
    return override ? { ...base, id: override } : base;
  }

  private baseUrl(): string {
    return (process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  }

  async complete(req: CompletionRequest, onChunk?: ChunkHandler): Promise<CompletionResult> {
    const started = Date.now();
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) throw new ProviderError(this.name, 'ANTHROPIC_API_KEY absent', { retryable: false });

    const stream = Boolean(onChunk);
    const system = req.system
      ? req.cachePrefix
        ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
        : req.system
      : undefined;

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? this.modelFor('balanced').maxOutput,
      messages: req.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content })),
      stream,
    };
    if (system) body['system'] = system;
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.stop?.length) body['stop_sequences'] = req.stop;

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          accept: stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new ProviderError(this.name, `echec reseau: ${(error as Error).message}`, {
        retryable: true,
      });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ProviderError(this.name, `HTTP ${response.status} ${detail.slice(0, 500)}`, {
        status: response.status,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      });
    }

    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;

    if (stream && response.body) {
      for await (const { event, data } of readSseTyped(response.body)) {
        if (event === 'error') {
          throw new ProviderError(this.name, data.slice(0, 300), { retryable: true });
        }
        let payload: Record<string, any>;
        try {
          payload = JSON.parse(data) as Record<string, any>;
        } catch {
          continue;
        }
        if (event === 'content_block_delta' && payload['delta']?.text) {
          const delta = payload['delta'].text as string;
          text += delta;
          onChunk?.(delta);
        } else if (event === 'message_start') {
          inputTokens = payload['message']?.usage?.input_tokens ?? 0;
        } else if (event === 'message_delta') {
          outputTokens = payload['usage']?.output_tokens ?? outputTokens;
        }
      }
    } else {
      const payload = (await response.json()) as AnthropicResponse;
      if (payload.error?.message) {
        throw new ProviderError(this.name, payload.error.message, { retryable: false });
      }
      text = (payload.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
      inputTokens = payload.usage?.input_tokens ?? 0;
      outputTokens = payload.usage?.output_tokens ?? 0;
    }

    if (!text.trim()) {
      throw new ProviderError(this.name, 'reponse vide du modele', { retryable: true });
    }

    return {
      text,
      provider: this.name,
      model: req.model,
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - started,
      cached: false,
      attempts: 1,
    };
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.baseUrl()}/v1/models`, {
        headers: {
          'x-api-key': process.env['ANTHROPIC_API_KEY'] ?? '',
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(15_000),
      });
      return { ok: res.ok, detail: res.ok ? 'API joignable' : `HTTP ${res.status}` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }
}
