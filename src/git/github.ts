import fs from 'node:fs/promises';
import path from 'node:path';
import type { ForgeConfig } from '../config.js';
import { backoffDelay, sleep } from '../util/misc.js';

export interface GitHubRepo {
  name: string;
  fullName: string;
  owner: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
}

export interface PushFile {
  path: string;
  content: string;
  /** 100644 fichier, 100755 executable. */
  mode?: '100644' | '100755';
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/**
 * Client GitHub REST minimal, sans dependance. Il publie un projet entier en
 * un seul commit via l'API Git Data (blobs -> arbre -> commit -> ref), ce qui
 * est nettement plus rapide qu'un appel par fichier et ne requiert meme pas
 * que `git` soit installe.
 */
export class GitHubClient {
  private readonly token: string;
  private readonly apiUrl: string;

  constructor(cfg: ForgeConfig, token?: string) {
    const resolved = token ?? cfg.github.token;
    if (!resolved) {
      throw new Error(
        'GITHUB_TOKEN absent. Creez un jeton avec les droits `repo` et `workflow`, puis exportez-le : export GITHUB_TOKEN=ghp_...',
      );
    }
    this.token = resolved;
    this.apiUrl = cfg.github.apiUrl;
  }

  static isConfigured(cfg: ForgeConfig): boolean {
    return Boolean(cfg.github.token);
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    retries = 3,
  ): Promise<T> {
    const url = endpoint.startsWith('http') ? endpoint : `${this.apiUrl}${endpoint}`;

    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'forge-ai',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120_000),
      });

      if (response.status === 204) return undefined as T;

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < retries) {
          await sleep(backoffDelay(attempt, 1_000));
          continue;
        }
        throw new GitHubError(
          `GitHub ${method} ${endpoint} -> ${response.status}: ${text.slice(0, 400)}`,
          response.status,
          text,
        );
      }

      return (await response.json()) as T;
    }
  }

  async me(): Promise<{ login: string; name: string | null }> {
    return this.request('GET', '/user');
  }

  async getRepo(owner: string, name: string): Promise<GitHubRepo | undefined> {
    try {
      const raw = await this.request<any>('GET', `/repos/${owner}/${name}`);
      return this.toRepo(raw);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return undefined;
      throw error;
    }
  }

  private toRepo(raw: any): GitHubRepo {
    return {
      name: raw.name,
      fullName: raw.full_name,
      owner: raw.owner?.login ?? '',
      htmlUrl: raw.html_url,
      cloneUrl: raw.clone_url,
      defaultBranch: raw.default_branch ?? 'main',
      private: Boolean(raw.private),
    };
  }

  /** Cree le depot, ou renvoie l'existant si le nom est deja pris. */
  async createRepo(options: {
    name: string;
    description?: string;
    private?: boolean;
    owner?: string;
  }): Promise<GitHubRepo> {
    const body = {
      name: options.name,
      description: (options.description ?? '').slice(0, 350),
      private: options.private ?? true,
      auto_init: false,
      has_issues: true,
      has_wiki: false,
    };

    const endpoint = options.owner ? `/orgs/${options.owner}/repos` : '/user/repos';
    try {
      return this.toRepo(await this.request<any>('POST', endpoint, body));
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422) {
        const owner = options.owner ?? (await this.me()).login;
        const existing = await this.getRepo(owner, options.name);
        if (existing) return existing;
      }
      throw error;
    }
  }

  /**
   * Publie un ensemble de fichiers en un commit unique. Les blobs partent en
   * parallele : publier 60 fichiers prend le temps du plus lent, pas la somme.
   */
  async pushFiles(options: {
    owner: string;
    repo: string;
    branch: string;
    message: string;
    files: PushFile[];
  }): Promise<{ commitSha: string; branch: string }> {
    const { owner, repo, branch, files } = options;
    const base = `/repos/${owner}/${repo}/git`;

    const blobs = await Promise.all(
      files.map(async (file) => {
        const blob = await this.request<{ sha: string }>('POST', `${base}/blobs`, {
          content: Buffer.from(file.content, 'utf8').toString('base64'),
          encoding: 'base64',
        });
        return {
          path: file.path,
          mode: file.mode ?? '100644',
          type: 'blob' as const,
          sha: blob.sha,
        };
      }),
    );

    // Un depot fraichement cree n'a aucune ref : le commit est alors sans parent.
    let parentSha: string | undefined;
    let baseTree: string | undefined;
    try {
      const ref = await this.request<{ object: { sha: string } }>(
        'GET',
        `${base}/ref/heads/${encodeURIComponent(branch)}`,
      );
      parentSha = ref.object.sha;
      const commit = await this.request<{ tree: { sha: string } }>(
        'GET',
        `${base}/commits/${parentSha}`,
      );
      baseTree = commit.tree.sha;
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 404) throw error;
    }

    const tree = await this.request<{ sha: string }>('POST', `${base}/trees`, {
      ...(baseTree ? { base_tree: baseTree } : {}),
      tree: blobs,
    });

    const commit = await this.request<{ sha: string }>('POST', `${base}/commits`, {
      message: options.message,
      tree: tree.sha,
      parents: parentSha ? [parentSha] : [],
    });

    if (parentSha) {
      await this.request('PATCH', `${base}/refs/heads/${encodeURIComponent(branch)}`, {
        sha: commit.sha,
        force: false,
      });
    } else {
      await this.request('POST', `${base}/refs`, {
        ref: `refs/heads/${branch}`,
        sha: commit.sha,
      });
    }

    return { commitSha: commit.sha, branch };
  }

  async createPullRequest(options: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<{ url: string; number: number }> {
    const pr = await this.request<any>('POST', `/repos/${options.owner}/${options.repo}/pulls`, {
      title: options.title,
      head: options.head,
      base: options.base,
      body: options.body,
    });
    return { url: pr.html_url, number: pr.number };
  }
}

/** Lit un repertoire de projet et le convertit en fichiers publiables. */
export async function collectFiles(
  root: string,
  relativePaths: string[],
): Promise<PushFile[]> {
  const files = await Promise.all(
    relativePaths.map(async (relative) => {
      const full = path.join(root, relative);
      const [content, stat] = await Promise.all([
        fs.readFile(full, 'utf8'),
        fs.stat(full),
      ]);
      const executable = (stat.mode & 0o111) !== 0;
      return {
        path: relative,
        content,
        mode: executable ? ('100755' as const) : ('100644' as const),
      };
    }),
  );
  return files;
}
