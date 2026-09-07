/**
 * Forge — API publique.
 *
 * Exemple :
 * ```ts
 * import { createForge, buildApp } from 'forge-ai';
 *
 * const forge = createForge();
 * forge.bus.onEvent((event) => console.log(event));
 * const result = await buildApp(forge, {
 *   prompt: "Une API de gestion de taches avec authentification et tests",
 *   github: true,
 * });
 * console.log(result.projectDir, result.repo?.url);
 * ```
 */

export { loadConfig, loadDotEnv, limit, resolveConcurrency, UNLIMITED } from './config.js';
export type { ForgeConfig, Tier, LogLevel } from './config.js';

export { EventBus } from './util/events.js';
export type { ForgeEvent, ForgeEventEnvelope } from './util/events.js';
export { Pool, Semaphore } from './util/pool.js';

export { LLMClient, NoProviderError } from './llm/client.js';
export type { AskOptions, UsageStats } from './llm/client.js';
export { ResponseCache } from './llm/cache.js';

export { ModelRouter, buildProviders } from './providers/registry.js';
export type { Provider, ModelSpec, Message, CompletionResult } from './providers/types.js';
export { ProviderError } from './providers/types.js';

export { Workspace } from './fs/workspace.js';
export { run, hasBinary } from './fs/exec.js';

export { planApp } from './pipeline/plan.js';
export { generateFiles, regenerateFile } from './pipeline/generate.js';
export { topologicalWaves } from './pipeline/graph.js';
export { verifyProject, isCommandAllowed } from './pipeline/verify.js';
export { repairLoop } from './pipeline/repair.js';
export { buildApp, publishProject, createForge } from './pipeline/orchestrator.js';
export type { ForgeDeps } from './pipeline/orchestrator.js';
export type {
  AppSpec,
  FileSpec,
  BuildOptions,
  BuildResult,
  GeneratedFile,
  VerificationReport,
  VerificationStep,
  Commands,
} from './pipeline/types.js';

export { GitHubClient, collectFiles } from './git/github.js';
export type { GitHubRepo, PushFile } from './git/github.js';
export { initRepo, pushToRemote } from './git/local.js';

export { JobQueue } from './server/jobs.js';
export type { Job, JobStatus, JobSummary } from './server/jobs.js';
export { createServer, startServer } from './server/http.js';
