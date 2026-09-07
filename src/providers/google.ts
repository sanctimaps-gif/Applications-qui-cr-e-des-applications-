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

const MODELS: Record<Tier, ModelSpec> = {
  deep: { id: 'gemini-2.5-pro', tier: 'deep', contextWindow: 1_000_000, maxOutput: 32_000 },
  balanced: { id: 'gemini-2.5-flash', tier: 'balanced', contextWindow: 1_000_000, maxOutput: 32_000 },
  fast: {
    id: 'gemini-2.5-flash-lite',
    tier: 'fast',
    contextWindow: 1_000_000,
    maxOutput: 16_000,
  },
};

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}

/** API Gemini `generateContent`. */
export class GoogleProvider implements Provider {
  readonly name = 'google';
  readonly concurrency: number;

  constructor(private readonly timeoutMs: number, concurrency = 12) {
    this.concurrency = concurrency;
  }

  private apiKey(): string | undefined {
    return process.env['GOOGLE_API_KEY'] ?? process.env['GEMINI_API_KEY'];
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey());
  }

  modelFor(tier: Tier): ModelSpec {
    const override = process.env[`FORGE_GOOGLE_MODEL_${tier.toUpperCase()}`];
    const base = MODELS[tier];
    return override ? { ...base, id: override } : base;
  }

  private baseUrl(): string {
    return (
      process.env['GOOGLE_BASE_URL'] ?? 'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/+$/, '');
  }

  async complete(req: CompletionRequest, onChunk?: ChunkHandler): Promise<CompletionResult> {
    const started = Date.now();
    const apiKey = this.apiKey();
    if (!apiKey) throw new ProviderError(this.name, 'GOOGLE_API_KEY absent', { retryable: false });

    const contents = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: req.maxTokens ?? MODELS.balanced.maxOutput,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.stop?.length ? { stopSequences: req.stop } : {}),
      },
    };
    if (req.system) body['systemInstruction'] = { parts: [{ text: req.system }] };

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const url = `${this.baseUrl()}/models/${encodeURIComponent(req.model)}:generateContent`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
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

    const payload = (await response.json()) as GeminiResponse;
    if (payload.error?.message) {
      throw new ProviderError(this.name, payload.error.message, { retryable: false });
    }
    const text = (payload.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');

    if (!text.trim()) {
      throw new ProviderError(this.name, 'reponse vide du modele', { retryable: true });
    }
    onChunk?.(text);

    return {
      text,
      provider: this.name,
      model: req.model,
      inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
      latencyMs: Date.now() - started,
      cached: false,
      attempts: 1,
    };
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.baseUrl()}/models`, {
        headers: { 'x-goog-api-key': this.apiKey() ?? '' },
        signal: AbortSignal.timeout(15_000),
      });
      return { ok: res.ok, detail: res.ok ? 'API joignable' : `HTTP ${res.status}` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }
}
