import fs from 'node:fs/promises';
import path from 'node:path';
import type { ForgeConfig } from '../config.js';
import { limit, resolveConcurrency } from '../config.js';
import { EventBus, type ForgeEventEnvelope } from '../util/events.js';
import { LLMClient } from '../llm/client.js';
import { Pool } from '../util/pool.js';
import { shortId, toError } from '../util/misc.js';
import { buildApp } from '../pipeline/orchestrator.js';
import type { BuildOptions, BuildResult } from '../pipeline/types.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  prompt: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  options: BuildOptions;
  result?: BuildResult;
  error?: string;
  events: ForgeEventEnvelope[];
}

export interface JobSummary {
  id: string;
  prompt: string;
  status: JobStatus;
  createdAt: number;
  startedAt: number | undefined;
  finishedAt: number | undefined;
  name: string | undefined;
  projectDir: string | undefined;
  repoUrl: string | undefined;
  files: number;
  verified: boolean | undefined;
  error: string | undefined;
}

/**
 * File de generation. La file elle-meme est **non bornee** — Forge n'impose
 * aucun quota de creation ; seul le parallelisme est regle, pour ne pas
 * saturer la machine ni les quotas du fournisseur.
 */
export class JobQueue {
  private readonly jobs = new Map<string, Job>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<(event: ForgeEventEnvelope) => void>>();
  private readonly pool: Pool;

  constructor(private readonly cfg: ForgeConfig) {
    this.pool = new Pool(resolveConcurrency(cfg.jobConcurrency, 1));
    void this.restore();
  }

  private historyFile(): string {
    return path.join(this.cfg.home, 'jobs.json');
  }

  /** L'historique survit au redemarrage du serveur. */
  private async restore(): Promise<void> {
    try {
      const raw = await fs.readFile(this.historyFile(), 'utf8');
      const saved = JSON.parse(raw) as JobSummary[];
      for (const entry of saved) {
        if (this.jobs.has(entry.id)) continue;
        this.jobs.set(entry.id, {
          id: entry.id,
          prompt: entry.prompt,
          status: entry.status === 'running' || entry.status === 'queued' ? 'cancelled' : entry.status,
          createdAt: entry.createdAt,
          startedAt: entry.startedAt,
          finishedAt: entry.finishedAt,
          options: { prompt: entry.prompt },
          events: [],
          ...(entry.error ? { error: entry.error } : {}),
        });
      }
    } catch {
      /* premier demarrage */
    }
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(this.cfg.home, { recursive: true });
      await fs.writeFile(this.historyFile(), JSON.stringify(this.list(200), null, 2), 'utf8');
    } catch {
      /* l'historique est un confort, pas une exigence */
    }
  }

  submit(options: BuildOptions): Job {
    const max = limit(this.cfg.maxProjects);
    if (this.jobs.size >= max) {
      // Uniquement si l'operateur a explicitement fixe une limite.
      throw new Error(`limite de projets atteinte (${this.cfg.maxProjects})`);
    }

    const id = shortId();
    const job: Job = {
      id,
      prompt: options.prompt,
      status: 'queued',
      createdAt: Date.now(),
      options,
      events: [],
    };
    this.jobs.set(id, job);

    void this.pool.run(() => this.execute(job));
    return job;
  }

  private async execute(job: Job): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);

    const bus = new EventBus();
    bus.onEvent((event) => {
      job.events.push(event);
      if (job.events.length > 8_000) job.events.shift();
      for (const listener of this.listeners.get(job.id) ?? []) listener(event);
    });

    job.status = 'running';
    job.startedAt = Date.now();
    bus.emitEvent({ type: 'phase', phase: 'start', message: 'Demarrage de la generation' });

    try {
      const llm = new LLMClient(this.cfg, bus);
      job.result = await buildApp(
        { cfg: this.cfg, bus, llm },
        { ...job.options, signal: controller.signal },
      );
      job.status = 'done';
    } catch (error) {
      const err = toError(error);
      job.status = controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = err.message;
      bus.emitEvent({ type: 'error', message: err.message });
    } finally {
      job.finishedAt = Date.now();
      this.controllers.delete(job.id);
      void this.persist();
    }
  }

  cancel(id: string): boolean {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  subscribe(id: string, listener: (event: ForgeEventEnvelope) => void): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(id);
    };
  }

  summarize(job: Job): JobSummary {
    return {
      id: job.id,
      prompt: job.prompt,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      name: job.result?.spec.name,
      projectDir: job.result?.projectDir,
      repoUrl: job.result?.repo?.url,
      files: job.result?.files.length ?? 0,
      verified: job.result?.verification.ok,
      error: job.error,
    };
  }

  list(max = 100): JobSummary[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, max)
      .map((job) => this.summarize(job));
  }

  stats(): { queued: number; running: number; total: number; parallelism: number } {
    let queued = 0;
    let running = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'queued') queued++;
      else if (job.status === 'running') running++;
    }
    return {
      queued,
      running,
      total: this.jobs.size,
      parallelism: this.pool.limit === Infinity ? 0 : this.pool.limit,
    };
  }
}
