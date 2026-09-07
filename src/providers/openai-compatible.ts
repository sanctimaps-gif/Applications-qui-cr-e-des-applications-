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
import { readSse } from './sse.js';

export interface OpenAICompatibleOptions {
  name: string;
  baseUrl: string;
  apiKeyEnv: string[];
  /** Certains serveurs locaux n'exigent aucune cle. */
  requiresKey?: boolean;
  /** Active la detection par variable d'hote (Ollama, LM Studio). */
  hostEnv?: string[];
  /**
   * Suffixe ajoute a l'hote fourni par l'utilisateur s'il manque. `OLLAMA_HOST`
   * vaut par convention `http://127.0.0.1:11434` (sans `/v1`) : sans cela,
   * l'appel partirait a la racine et echouerait en 404.
   */
  ensurePathSuffix?: string;
  models: Record<Tier, ModelSpec>;
  concurrency?: number;
  extraHeaders?: Record<string, string>;
  timeoutMs: number;
}

interface ChatChoiceDelta {
  choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/**
 * Implementation unique pour tous les services parlant l'API
 * `/chat/completions` : OpenAI, Groq, Mistral, DeepSeek, xAI, Together,
 * OpenRouter, Ollama et LM Studio. Une seule surface a maintenir.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly name: string;
  readonly concurrency: number;
  private readonly opts: OpenAICompatibleOptions;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = opts;
    this.name = opts.name;
    this.concurrency = opts.concurrency ?? 16;
  }

  private apiKey(): string | undefined {
    for (const key of this.opts.apiKeyEnv) {
      const value = process.env[key];
      if (value) return value;
    }
    return undefined;
  }

  private host(): string {
    for (const key of this.opts.hostEnv ?? []) {
      const value = process.env[key];
      if (!value) continue;
      const trimmed = value.replace(/\/+$/, '');
      const suffix = this.opts.ensurePathSuffix;
      return suffix && !trimmed.endsWith(suffix) ? trimmed + suffix : trimmed;
    }
    return this.opts.baseUrl.replace(/\/+$/, '');
  }

  isConfigured(): boolean {
    if (this.opts.requiresKey === false) {
      // Serveur local : configure des qu'un hote ou un modele est declare.
      return (this.opts.hostEnv ?? []).some((k) => Boolean(process.env[k]));
    }
    return Boolean(this.apiKey());
  }

  modelFor(tier: Tier): ModelSpec {
    const upper = `FORGE_${this.name.toUpperCase()}_MODEL_${tier.toUpperCase()}`;
    const override = process.env[upper];
    const base = this.opts.models[tier];
    return override ? { ...base, id: override } : base;
  }

  async complete(req: CompletionRequest, onChunk?: ChunkHandler): Promise<CompletionResult> {
    const started = Date.now();
    const url = `${this.host()}/chat/completions`;
    const messages = req.system
      ? [{ role: 'system' as const, content: req.system }, ...req.messages]
      : req.messages;

    const stream = Boolean(onChunk);
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream,
    };
    if (req.maxTokens) body['max_tokens'] = req.maxTokens;
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.stop?.length) body['stop'] = req.stop;
    if (stream) body['stream_options'] = { include_usage: true };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
      ...this.opts.extraHeaders,
    };
    const key = this.apiKey();
    if (key) headers['authorization'] = `Bearer ${key}`;

    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
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
      for await (const event of readSse(response.body)) {
        if (event === '[DONE]') break;
        let payload: ChatChoiceDelta;
        try {
          payload = JSON.parse(event) as ChatChoiceDelta;
        } catch {
          continue;
        }
        if (payload.error?.message) {
          throw new ProviderError(this.name, payload.error.message, { retryable: false });
        }
        const delta = payload.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onChunk?.(delta);
        }
        if (payload.usage) {
          inputTokens = payload.usage.prompt_tokens ?? inputTokens;
          outputTokens = payload.usage.completion_tokens ?? outputTokens;
        }
      }
    } else {
      const payload = (await response.json()) as ChatChoiceDelta;
      if (payload.error?.message) {
        throw new ProviderError(this.name, payload.error.message, { retryable: false });
      }
      text = payload.choices?.[0]?.message?.content ?? '';
      inputTokens = payload.usage?.prompt_tokens ?? 0;
      outputTokens = payload.usage?.completion_tokens ?? 0;
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
      const headers: Record<string, string> = { ...this.opts.extraHeaders };
      const key = this.apiKey();
      if (key) headers['authorization'] = `Bearer ${key}`;
      const res = await fetch(`${this.host()}/models`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      return { ok: res.ok, detail: res.ok ? 'API joignable' : `HTTP ${res.status}` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }
}
