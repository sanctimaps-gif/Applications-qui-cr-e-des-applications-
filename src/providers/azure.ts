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

/**
 * Azure OpenAI. Le schema d'URL differe de l'API OpenAI publique : le modele
 * est un « deploiement » place dans le chemin, la version d'API est un
 * parametre de requete, et la cle passe par l'en-tete `api-key`.
 *
 *   AZURE_OPENAI_ENDPOINT=https://mon-instance.openai.azure.com
 *   AZURE_OPENAI_API_KEY=...
 *   AZURE_OPENAI_DEPLOYMENT=mon-deploiement-gpt
 */
export class AzureOpenAIProvider implements Provider {
  readonly name = 'azure';
  readonly concurrency: number;

  constructor(
    private readonly timeoutMs: number,
    concurrency = 16,
  ) {
    this.concurrency = concurrency;
  }

  isConfigured(): boolean {
    return Boolean(process.env['AZURE_OPENAI_API_KEY'] && process.env['AZURE_OPENAI_ENDPOINT']);
  }

  modelFor(tier: Tier): ModelSpec {
    const deployment =
      process.env[`FORGE_AZURE_MODEL_${tier.toUpperCase()}`] ??
      process.env['AZURE_OPENAI_DEPLOYMENT'] ??
      'gpt-4o';
    return { id: deployment, tier, contextWindow: 128_000, maxOutput: 16_000 };
  }

  private endpoint(): string {
    return (process.env['AZURE_OPENAI_ENDPOINT'] ?? '').replace(/\/+$/, '');
  }

  private apiVersion(): string {
    return process.env['AZURE_OPENAI_API_VERSION'] ?? '2024-10-21';
  }

  async complete(req: CompletionRequest, onChunk?: ChunkHandler): Promise<CompletionResult> {
    const started = Date.now();
    const apiKey = process.env['AZURE_OPENAI_API_KEY'];
    if (!apiKey || !this.endpoint()) {
      throw new ProviderError(this.name, 'AZURE_OPENAI_API_KEY ou AZURE_OPENAI_ENDPOINT absent', {
        retryable: false,
      });
    }

    const stream = Boolean(onChunk);
    const messages = req.system
      ? [{ role: 'system' as const, content: req.system }, ...req.messages]
      : req.messages;

    const body: Record<string, unknown> = { messages, stream };
    if (req.maxTokens) body['max_tokens'] = req.maxTokens;
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.stop?.length) body['stop'] = req.stop;

    const url = `${this.endpoint()}/openai/deployments/${encodeURIComponent(req.model)}/chat/completions?api-version=${this.apiVersion()}`;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': apiKey,
          accept: stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new ProviderError(this.name, `echec reseau: ${(error as Error).message}`, { retryable: true });
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
        try {
          const payload = JSON.parse(event) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const delta = payload.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            onChunk?.(delta);
          }
          if (payload.usage) {
            inputTokens = payload.usage.prompt_tokens ?? inputTokens;
            outputTokens = payload.usage.completion_tokens ?? outputTokens;
          }
        } catch {
          continue;
        }
      }
    } else {
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      text = payload.choices?.[0]?.message?.content ?? '';
      inputTokens = payload.usage?.prompt_tokens ?? 0;
      outputTokens = payload.usage?.completion_tokens ?? 0;
    }

    if (!text.trim()) throw new ProviderError(this.name, 'reponse vide du modele', { retryable: true });

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
    if (!this.isConfigured()) return { ok: false, detail: 'non configure' };
    return { ok: true, detail: `${this.endpoint()} (deploiement ${this.modelFor('balanced').id})` };
  }
}
