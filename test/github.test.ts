import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { loadConfig } from '../src/config.js';
import { GitHubClient, GitHubError } from '../src/git/github.js';

interface Call {
  method: string;
  url: string;
  body: any;
}

type Route = (call: Call, res: http.ServerResponse) => void;

async function stubGitHub(routes: Record<string, Route>): Promise<{
  client: GitHubClient;
  calls: Call[];
  close: () => Promise<void>;
}> {
  const calls: Call[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const call: Call = { method: req.method ?? 'GET', url: req.url ?? '', body };
      calls.push(call);

      const key = `${call.method} ${call.url}`;
      const route = routes[key] ?? routes[`${call.method} *`];
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"message":"Not Found"}');
        return;
      }
      route(call, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const cfg = loadConfig({
    github: { token: 'jeton-de-test', apiUrl: `http://127.0.0.1:${port}`, owner: undefined },
  });

  return {
    client: new GitHubClient(cfg),
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const ok = (res: http.ServerResponse, body: unknown, status = 200): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const REPO = {
  name: 'demo',
  full_name: 'moi/demo',
  owner: { login: 'moi' },
  html_url: 'https://github.com/moi/demo',
  clone_url: 'https://github.com/moi/demo.git',
  default_branch: 'main',
  private: true,
};

test('un depot vide recoit un commit initial sans parent', async () => {
  const stub = await stubGitHub({
    'POST /user/repos': (_call, res) => ok(res, REPO, 201),
    'POST /repos/moi/demo/git/blobs': (call, res) =>
      ok(res, { sha: `blob-${(call.body.content as string).length}` }, 201),
    // Depot neuf : aucune reference n'existe encore.
    'GET /repos/moi/demo/git/ref/heads/main': (_call, res) => ok(res, { message: 'Not Found' }, 404),
    'POST /repos/moi/demo/git/trees': (_call, res) => ok(res, { sha: 'tree-1' }, 201),
    'POST /repos/moi/demo/git/commits': (_call, res) => ok(res, { sha: 'commit-1' }, 201),
    'POST /repos/moi/demo/git/refs': (_call, res) => ok(res, {}, 201),
  });

  try {
    const repo = await stub.client.createRepo({ name: 'demo', description: 'un projet' });
    assert.equal(repo.owner, 'moi');
    assert.equal(repo.defaultBranch, 'main');

    const result = await stub.client.pushFiles({
      owner: 'moi',
      repo: 'demo',
      branch: 'main',
      message: 'feat: initial',
      files: [
        { path: 'README.md', content: '# demo\n' },
        { path: 'run.sh', content: 'echo ok\n', mode: '100755' },
      ],
    });
    assert.equal(result.commitSha, 'commit-1');

    const tree = stub.calls.find((call) => call.url.endsWith('/git/trees'))!;
    // Pas de base_tree : le depot n'avait pas d'historique.
    assert.equal(tree.body.base_tree, undefined);
    assert.equal(tree.body.tree.length, 2);
    assert.equal(tree.body.tree[1].mode, '100755', 'le bit executable est conserve');

    const commit = stub.calls.find((call) => call.url.endsWith('/git/commits'))!;
    assert.deepEqual(commit.body.parents, [], 'commit initial sans parent');

    // La reference est creee, pas mise a jour.
    assert.ok(stub.calls.some((call) => call.method === 'POST' && call.url.endsWith('/git/refs')));
    assert.ok(!stub.calls.some((call) => call.method === 'PATCH'));
  } finally {
    await stub.close();
  }
});

test('un depot existant est mis a jour sur son historique', async () => {
  const stub = await stubGitHub({
    'POST /repos/moi/demo/git/blobs': (_call, res) => ok(res, { sha: 'blob-1' }, 201),
    'GET /repos/moi/demo/git/ref/heads/main': (_call, res) => ok(res, { object: { sha: 'parent-1' } }),
    'GET /repos/moi/demo/git/commits/parent-1': (_call, res) => ok(res, { tree: { sha: 'tree-parent' } }),
    'POST /repos/moi/demo/git/trees': (_call, res) => ok(res, { sha: 'tree-2' }, 201),
    'POST /repos/moi/demo/git/commits': (_call, res) => ok(res, { sha: 'commit-2' }, 201),
    'PATCH /repos/moi/demo/git/refs/heads/main': (_call, res) => ok(res, {}),
  });

  try {
    await stub.client.pushFiles({
      owner: 'moi',
      repo: 'demo',
      branch: 'main',
      message: 'feat: suite',
      files: [{ path: 'README.md', content: '# v2\n' }],
    });

    const tree = stub.calls.find((call) => call.url.endsWith('/git/trees'))!;
    assert.equal(tree.body.base_tree, 'tree-parent', 'le nouvel arbre part de l existant');

    const commit = stub.calls.find((call) => call.url.endsWith('/git/commits'))!;
    assert.deepEqual(commit.body.parents, ['parent-1']);

    const patch = stub.calls.find((call) => call.method === 'PATCH')!;
    assert.equal(patch.body.sha, 'commit-2');
    assert.equal(patch.body.force, false, 'jamais de reecriture forcee de l historique');
  } finally {
    await stub.close();
  }
});

test('un nom de depot deja pris reutilise le depot existant', async () => {
  const stub = await stubGitHub({
    'POST /user/repos': (_call, res) => ok(res, { message: 'name already exists' }, 422),
    'GET /user': (_call, res) => ok(res, { login: 'moi', name: 'Moi' }),
    'GET /repos/moi/demo': (_call, res) => ok(res, REPO),
  });

  try {
    const repo = await stub.client.createRepo({ name: 'demo' });
    assert.equal(repo.fullName, 'moi/demo');
  } finally {
    await stub.close();
  }
});

test('une erreur serveur est rejouee puis propagee', async () => {
  let attempts = 0;
  const stub = await stubGitHub({
    'GET /user': (_call, res) => {
      attempts++;
      if (attempts < 3) return ok(res, { message: 'oups' }, 500);
      return ok(res, { login: 'moi', name: null });
    },
  });

  try {
    const me = await stub.client.me();
    assert.equal(me.login, 'moi');
    assert.equal(attempts, 3, 'les deux premieres tentatives ont ete rejouees');
  } finally {
    await stub.close();
  }
});

test('une erreur 404 est signalee sans etre rejouee', async () => {
  const stub = await stubGitHub({});
  try {
    await assert.rejects(
      () => stub.client.createPullRequest({ owner: 'moi', repo: 'demo', title: 't', head: 'a', base: 'b', body: '' }),
      (error: unknown) => error instanceof GitHubError && error.status === 404,
    );
    assert.equal(stub.calls.length, 1);
  } finally {
    await stub.close();
  }
});

test('branche, sujets, release et pull request', async () => {
  const stub = await stubGitHub({
    'GET /repos/moi/demo/git/ref/heads/main': (_call, res) => ok(res, { object: { sha: 'sha-main' } }),
    'POST /repos/moi/demo/git/refs': (_call, res) => ok(res, {}, 201),
    'PUT /repos/moi/demo/topics': (call, res) => ok(res, { names: call.body.names }),
    'POST /repos/moi/demo/releases': (call, res) =>
      ok(res, { html_url: 'https://github.com/moi/demo/releases/tag/v1', tag_name: call.body.tag_name }, 201),
    'POST /repos/moi/demo/pulls': (_call, res) =>
      ok(res, { html_url: 'https://github.com/moi/demo/pull/1', number: 1 }, 201),
  });

  try {
    const branch = await stub.client.createBranch({ owner: 'moi', repo: 'demo', branch: 'feat/x', from: 'main' });
    assert.equal(branch.sha, 'sha-main');

    // Les sujets sont normalises : minuscules, tirets, sans accents parasites.
    const topics = await stub.client.setTopics('moi', 'demo', ['TypeScript', 'API REST', '!!!']);
    assert.deepEqual(topics, ['typescript', 'api-rest']);

    const release = await stub.client.createRelease({ owner: 'moi', repo: 'demo', tag: 'v1' });
    assert.equal(release.tag, 'v1');

    const pr = await stub.client.createPullRequest({
      owner: 'moi',
      repo: 'demo',
      title: 'feat',
      head: 'feat/x',
      base: 'main',
      body: 'corps',
    });
    assert.equal(pr.number, 1);
  } finally {
    await stub.close();
  }
});

test('une branche deja existante ne fait pas echouer la publication', async () => {
  const stub = await stubGitHub({
    'GET /repos/moi/demo/git/ref/heads/main': (_call, res) => ok(res, { object: { sha: 'sha-main' } }),
    'POST /repos/moi/demo/git/refs': (_call, res) => ok(res, { message: 'Reference already exists' }, 422),
  });

  try {
    const branch = await stub.client.createBranch({ owner: 'moi', repo: 'demo', branch: 'feat/x', from: 'main' });
    assert.equal(branch.branch, 'feat/x');
  } finally {
    await stub.close();
  }
});

test('sans jeton, le client refuse de se construire', () => {
  const cfg = loadConfig({ github: { token: undefined, apiUrl: 'https://api.github.com', owner: undefined } });
  assert.equal(GitHubClient.isConfigured(cfg), false);
  assert.throws(() => new GitHubClient(cfg), /GITHUB_TOKEN absent/);
});
