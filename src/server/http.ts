import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ForgeConfig } from '../config.js';
import { loadConfig } from '../config.js';
import { ModelRouter } from '../providers/registry.js';
import { GitHubClient } from '../git/github.js';
import { Workspace } from '../fs/workspace.js';
import { toError } from '../util/misc.js';
import { JobQueue } from './jobs.js';
import { EventBus } from '../util/events.js';
import { LLMClient } from '../llm/client.js';
import { publishProject } from '../pipeline/orchestrator.js';
import type { BuildOptions } from '../pipeline/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage, maxBytes = 2_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error('corps de requete trop volumineux');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function authorized(req: http.IncomingMessage, cfg: ForgeConfig): boolean {
  if (!cfg.authToken) return true;
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header === `Bearer ${cfg.authToken}`) return true;
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get('token') === cfg.authToken;
}

/**
 * Serveur HTTP sans dependance : API JSON + flux SSE + interface web statique.
 */
export function createServer(cfg: ForgeConfig = loadConfig()): {
  server: http.Server;
  queue: JobQueue;
} {
  const queue = new JobQueue(cfg);
  const router = new ModelRouter(cfg);

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      const err = toError(error);
      if (!res.headersSent) json(res, 500, { error: err.message });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = url.pathname.replace(/\/+$/, '') || '/';

    res.setHeader('x-forge', 'forge-ai');

    if (route.startsWith('/api') && !authorized(req, cfg)) {
      json(res, 401, { error: 'jeton invalide' });
      return;
    }

    // --- API ---------------------------------------------------------------
    if (route === '/api/health') {
      json(res, 200, {
        ok: true,
        providers: router.configured().map((p) => p.name),
        github: GitHubClient.isConfigured(cfg),
        jobs: queue.stats(),
        limits: {
          maxProjects: cfg.maxProjects === 0 ? 'illimite' : cfg.maxProjects,
          maxFiles: cfg.maxFiles === 0 ? 'illimite' : cfg.maxFiles,
          maxRepairAttempts: cfg.maxRepairAttempts === 0 ? 'illimite' : cfg.maxRepairAttempts,
        },
      });
      return;
    }

    if (route === '/api/providers') {
      json(res, 200, {
        configured: router.configured().map((provider) => ({
          name: provider.name,
          models: {
            deep: provider.modelFor('deep').id,
            balanced: provider.modelFor('balanced').id,
            fast: provider.modelFor('fast').id,
          },
        })),
        available: router.all().map((provider) => provider.name),
      });
      return;
    }

    if (route === '/api/projects' && req.method === 'POST') {
      const body = (await readBody(req)) as Partial<BuildOptions> & { prompt?: string };
      if (!body.prompt || typeof body.prompt !== 'string' || body.prompt.trim().length < 3) {
        json(res, 400, { error: 'champ "prompt" requis' });
        return;
      }
      const job = queue.submit({
        prompt: body.prompt.trim(),
        name: body.name,
        stack: body.stack,
        verify: body.verify,
        github: body.github,
        repoName: body.repoName,
        repoPrivate: body.repoPrivate,
        repoOwner: body.repoOwner,
        branch: body.branch,
        pullRequest: body.pullRequest,
        release: body.release,
        topics: body.topics,
        pages: body.pages,
        withCi: body.withCi ?? true,
        provider: body.provider,
        maxRepairAttempts: body.maxRepairAttempts,
      });
      json(res, 202, queue.summarize(job));
      return;
    }

    if (route === '/api/projects' && req.method === 'GET') {
      json(res, 200, { jobs: queue.list(), stats: queue.stats() });
      return;
    }

    const jobMatch = /^\/api\/projects\/([a-z0-9]+)(\/[a-z]+)?$/i.exec(route);
    if (jobMatch) {
      const job = queue.get(jobMatch[1]!);
      if (!job) {
        json(res, 404, { error: 'projet inconnu' });
        return;
      }
      const action = jobMatch[2];

      if (!action && req.method === 'GET') {
        json(res, 200, {
          ...queue.summarize(job),
          spec: job.result?.spec,
          verification: job.result?.verification,
          usage: job.result?.usage,
        });
        return;
      }

      if (action === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        // Rejouer l'historique : un client qui se connecte tard voit tout.
        for (const event of job.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
          res.write(`data: ${JSON.stringify({ type: 'end', status: job.status, at: Date.now() })}\n\n`);
          res.end();
          return;
        }

        const unsubscribe = queue.subscribe(job.id, (event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          if (event.type === 'done' || event.type === 'error') {
            res.write(`data: ${JSON.stringify({ type: 'end', status: job.status, at: Date.now() })}\n\n`);
          }
        });
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }

      if (action === '/cancel' && req.method === 'POST') {
        json(res, 200, { cancelled: queue.cancel(job.id) });
        return;
      }

      if (action === '/publish' && req.method === 'POST') {
        if (!job.result) {
          json(res, 409, { error: 'projet non termine' });
          return;
        }
        const body = (await readBody(req)) as {
          repoName?: string;
          private?: boolean;
          owner?: string;
          branch?: string;
          pullRequest?: boolean;
          release?: string;
          topics?: string[];
          pages?: boolean;
        };
        const bus = new EventBus();
        const deps = { cfg, bus, llm: new LLMClient(cfg, bus) };
        const workspace = new Workspace(job.result.projectDir);
        const repo = await publishProject(deps, workspace, job.result.spec, {
          prompt: job.prompt,
          repoName: body.repoName,
          repoPrivate: body.private ?? true,
          repoOwner: body.owner,
          branch: body.branch,
          pullRequest: body.pullRequest,
          release: body.release,
          topics: body.topics,
          pages: body.pages,
        });
        job.result.repo = repo;
        json(res, 200, repo);
        return;
      }

      if (action === '/iterate' && req.method === 'POST') {
        if (!job.result) {
          json(res, 409, { error: 'projet non termine' });
          return;
        }
        const body = (await readBody(req)) as { request?: string } & Record<string, unknown>;
        if (!body.request || typeof body.request !== 'string' || body.request.trim().length < 3) {
          json(res, 400, { error: 'champ "request" requis' });
          return;
        }
        // L'iteration devient un nouveau job : le suivi SSE reste identique.
        const next = queue.submitIteration({
          dir: job.result.projectDir,
          request: body.request.trim(),
          verify: body['verify'] as boolean | undefined,
          github: body['github'] as boolean | undefined,
          repoName: body['repoName'] as string | undefined,
          branch: body['branch'] as string | undefined,
          pullRequest: body['pullRequest'] as boolean | undefined,
          provider: body['provider'] as string | undefined,
        });
        json(res, 202, queue.summarize(next));
        return;
      }
    }

    if (route.startsWith('/api')) {
      json(res, 404, { error: 'route inconnue' });
      return;
    }

    // --- Fichiers statiques ------------------------------------------------
    const relative = route === '/' ? 'index.html' : route.slice(1);
    const target = path.join(PUBLIC_DIR, relative);
    if (!target.startsWith(PUBLIC_DIR)) {
      json(res, 403, { error: 'interdit' });
      return;
    }
    try {
      const content = await fs.readFile(target);
      res.writeHead(200, {
        'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
        'content-length': content.length,
      });
      res.end(content);
    } catch {
      json(res, 404, { error: 'introuvable' });
    }
  }

  return { server, queue };
}

export function startServer(cfg: ForgeConfig = loadConfig()): Promise<{ url: string; close: () => Promise<void> }> {
  const { server } = createServer(cfg);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      resolve({
        url: `http://${cfg.host}:${cfg.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
