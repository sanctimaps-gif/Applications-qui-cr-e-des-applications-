import type { ForgeConfig, Tier } from '../config.js';
import type { ModelSpec, Provider } from './types.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';
import { GoogleProvider } from './google.js';
import { AzureOpenAIProvider } from './azure.js';

function models(deep: string, balanced: string, fast: string, ctx: number, out: number): Record<Tier, ModelSpec> {
  return {
    deep: { id: deep, tier: 'deep', contextWindow: ctx, maxOutput: out },
    balanced: { id: balanced, tier: 'balanced', contextWindow: ctx, maxOutput: out },
    fast: { id: fast, tier: 'fast', contextWindow: ctx, maxOutput: out },
  };
}

/**
 * Construit tous les fournisseurs supportes. Aucun n'est privilegie par
 * defaut : Forge utilise le premier de `providerOrder` qui est configure, et
 * bascule automatiquement sur les suivants en cas de panne ou de quota.
 */
export function buildProviders(cfg: ForgeConfig): Provider[] {
  const t = cfg.requestTimeoutMs;

  return [
    // --- Serveurs locaux : Forge tourne alors 100 % hors ligne -------------
    new OpenAICompatibleProvider({
      name: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      hostEnv: ['FORGE_OLLAMA_BASE_URL', 'OLLAMA_BASE_URL', 'OLLAMA_HOST'],
      ensurePathSuffix: '/v1',
      apiKeyEnv: [],
      requiresKey: false,
      models: models('qwen2.5-coder:32b', 'qwen2.5-coder:14b', 'qwen2.5-coder:7b', 128_000, 8_192),
      concurrency: 4,
      timeoutMs: t,
    }),
    new OpenAICompatibleProvider({
      name: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      hostEnv: ['FORGE_LMSTUDIO_BASE_URL', 'LMSTUDIO_BASE_URL', 'LMSTUDIO_HOST'],
      ensurePathSuffix: '/v1',
      apiKeyEnv: [],
      requiresKey: false,
      models: models('local-model', 'local-model', 'local-model', 128_000, 8_192),
      concurrency: 2,
      timeoutMs: t,
    }),

    // --- Services hebergés -------------------------------------------------
    new OpenAICompatibleProvider({
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      hostEnv: ['OPENAI_BASE_URL'],
      apiKeyEnv: ['OPENAI_API_KEY'],
      models: models('gpt-5', 'gpt-5', 'gpt-5-mini', 400_000, 32_000),
      concurrency: 24,
      timeoutMs: t,
    }),
    new AnthropicProvider(t),
    new GoogleProvider(t),
    new OpenAICompatibleProvider({
      name: 'mistral',
      baseUrl: 'https://api.mistral.ai/v1',
      apiKeyEnv: ['MISTRAL_API_KEY'],
      models: models('mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 128_000, 16_000),
      concurrency: 12,
      timeoutMs: t,
    }),
    new OpenAICompatibleProvider({
      name: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKeyEnv: ['GROQ_API_KEY'],
      models: models(
        'llama-3.3-70b-versatile',
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
        128_000,
        16_000,
      ),
      concurrency: 16,
      timeoutMs: t,
    }),
    new OpenAICompatibleProvider({
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnv: ['DEEPSEEK_API_KEY'],
      models: models('deepseek-reasoner', 'deepseek-chat', 'deepseek-chat', 128_000, 8_192),
      concurrency: 12,
      timeoutMs: t,
    }),
    new OpenAICompatibleProvider({
      name: 'xai',
      baseUrl: 'https://api.x.ai/v1',
      apiKeyEnv: ['XAI_API_KEY'],
      models: models('grok-4', 'grok-4', 'grok-3-mini', 256_000, 16_000),
      concurrency: 12,
      timeoutMs: t,
    }),
    new OpenAICompatibleProvider({
      name: 'together',
      baseUrl: 'https://api.together.xyz/v1',
      apiKeyEnv: ['TOGETHER_API_KEY'],
      models: models(
        'Qwen/Qwen2.5-Coder-32B-Instruct',
        'Qwen/Qwen2.5-Coder-32B-Instruct',
        'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        128_000,
        8_192,
      ),
      concurrency: 12,
      timeoutMs: t,
    }),
    new OpenAICompatibleProvider({
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: ['OPENROUTER_API_KEY'],
      models: models(
        'openai/gpt-5',
        'anthropic/claude-sonnet-5',
        'google/gemini-2.5-flash',
        200_000,
        32_000,
      ),
      extraHeaders: { 'x-title': 'Forge' },
      concurrency: 16,
      timeoutMs: t,
    }),
    new AzureOpenAIProvider(t),
    new OpenAICompatibleProvider({
      name: 'cohere',
      baseUrl: 'https://api.cohere.ai/compatibility/v1',
      apiKeyEnv: ['COHERE_API_KEY'],
      models: models('command-a-03-2025', 'command-r-plus', 'command-r', 256_000, 8_192),
      concurrency: 12,
      timeoutMs: t,
    }),
    new OpenAICompatibleProvider({
      name: 'perplexity',
      baseUrl: 'https://api.perplexity.ai',
      apiKeyEnv: ['PERPLEXITY_API_KEY'],
      models: models('sonar-pro', 'sonar-pro', 'sonar', 128_000, 8_192),
      concurrency: 8,
      timeoutMs: t,
    }),
    new OpenAICompatibleProvider({
      name: 'fireworks',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      apiKeyEnv: ['FIREWORKS_API_KEY'],
      models: models(
        'accounts/fireworks/models/qwen2p5-coder-32b-instruct',
        'accounts/fireworks/models/qwen2p5-coder-32b-instruct',
        'accounts/fireworks/models/llama-v3p1-8b-instruct',
        128_000,
        8_192,
      ),
      concurrency: 16,
      timeoutMs: t,
    }),
    new OpenAICompatibleProvider({
      name: 'cerebras',
      baseUrl: 'https://api.cerebras.ai/v1',
      apiKeyEnv: ['CEREBRAS_API_KEY'],
      models: models('qwen-3-coder-480b', 'llama-3.3-70b', 'llama3.1-8b', 128_000, 8_192),
      concurrency: 12,
      timeoutMs: t,
    }),
    new OpenAICompatibleProvider({
      name: 'nebius',
      baseUrl: 'https://api.studio.nebius.ai/v1',
      apiKeyEnv: ['NEBIUS_API_KEY'],
      models: models(
        'Qwen/Qwen2.5-Coder-32B-Instruct',
        'Qwen/Qwen2.5-Coder-32B-Instruct',
        'meta-llama/Meta-Llama-3.1-8B-Instruct',
        128_000,
        8_192,
      ),
      concurrency: 12,
      timeoutMs: t,
    }),
    new OpenAICompatibleProvider({
      name: 'sambanova',
      baseUrl: 'https://api.sambanova.ai/v1',
      apiKeyEnv: ['SAMBANOVA_API_KEY'],
      models: models('Llama-3.3-70B-Instruct', 'Llama-3.3-70B-Instruct', 'Meta-Llama-3.1-8B-Instruct', 128_000, 8_192),
      concurrency: 12,
      timeoutMs: t,
    }),
    new OpenAICompatibleProvider({
      name: 'huggingface',
      baseUrl: 'https://router.huggingface.co/v1',
      apiKeyEnv: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
      models: models(
        'Qwen/Qwen2.5-Coder-32B-Instruct',
        'Qwen/Qwen2.5-Coder-32B-Instruct',
        'meta-llama/Llama-3.1-8B-Instruct',
        128_000,
        8_192,
      ),
      concurrency: 8,
      timeoutMs: t,
    }),

    // --- Serveurs auto-heberges (vLLM, llama.cpp, TGI, LiteLLM...) ---------
    new OpenAICompatibleProvider({
      name: 'vllm',
      baseUrl: 'http://127.0.0.1:8000/v1',
      hostEnv: ['FORGE_VLLM_BASE_URL', 'VLLM_BASE_URL'],
      ensurePathSuffix: '/v1',
      apiKeyEnv: ['VLLM_API_KEY'],
      requiresKey: false,
      models: models('local-model', 'local-model', 'local-model', 128_000, 8_192),
      concurrency: 8,
      timeoutMs: t,
    }),
    new OpenAICompatibleProvider({
      name: 'llamacpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      hostEnv: ['FORGE_LLAMACPP_BASE_URL', 'LLAMACPP_BASE_URL'],
      ensurePathSuffix: '/v1',
      apiKeyEnv: [],
      requiresKey: false,
      models: models('local-model', 'local-model', 'local-model', 128_000, 8_192),
      concurrency: 2,
      timeoutMs: t,
    }),

    /**
     * Connecteur universel : n'importe quel service parlant l'API
     * `/chat/completions` peut etre branche sans toucher au code.
     *   FORGE_CUSTOM_BASE_URL=https://mon-service/v1
     *   FORGE_CUSTOM_API_KEY=...            (facultatif)
     *   FORGE_CUSTOM_MODEL_BALANCED=mon-modele
     */
    new OpenAICompatibleProvider({
      name: 'custom',
      baseUrl: 'http://127.0.0.1:8081/v1',
      hostEnv: ['FORGE_CUSTOM_BASE_URL'],
      apiKeyEnv: ['FORGE_CUSTOM_API_KEY'],
      requiresKey: false,
      models: models('custom-model', 'custom-model', 'custom-model', 128_000, 8_192),
      concurrency: 8,
      timeoutMs: t,
    }),
  ];
}

export interface ResolvedModel {
  provider: Provider;
  model: ModelSpec;
}

/**
 * Choisit les modeles a essayer pour un palier donne : le fournisseur
 * prefere d'abord, puis tous les autres en repli. Aucun point de defaillance
 * unique — si un service tombe, la generation continue.
 */
export class ModelRouter {
  private readonly providers: Provider[];

  constructor(
    private readonly cfg: ForgeConfig,
    providers?: Provider[],
  ) {
    this.providers = providers ?? buildProviders(cfg);
  }

  all(): Provider[] {
    return this.providers;
  }

  configured(): Provider[] {
    const order = this.cfg.providerOrder;
    const rank = (name: string) => {
      const index = order.indexOf(name);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    return this.providers
      .filter((provider) => provider.isConfigured())
      .sort((a, b) => rank(a.name) - rank(b.name));
  }

  get(name: string): Provider | undefined {
    return this.providers.find((provider) => provider.name === name);
  }

  /** Chaine de repli complete pour un palier. */
  candidates(tier: Tier, preferred?: string): ResolvedModel[] {
    const configured = this.configured();
    if (configured.length === 0) return [];

    const ordered = preferred
      ? [...configured].sort((a, b) =>
          a.name === preferred ? -1 : b.name === preferred ? 1 : 0,
        )
      : configured;

    return ordered.map((provider) => ({ provider, model: provider.modelFor(tier) }));
  }
}
