import { run, hasBinary } from '../fs/exec.js';

/**
 * Initialise un depot git local dans le projet genere. Optionnel : la
 * publication GitHub passe par l'API et ne depend pas du binaire `git`.
 */
export async function initRepo(
  dir: string,
  options: { branch?: string; message?: string } = {},
): Promise<{ ok: boolean; detail: string }> {
  if (!(await hasBinary('git', dir))) {
    return { ok: false, detail: 'git introuvable dans le PATH' };
  }

  const branch = options.branch ?? 'main';
  const message = options.message ?? 'chore: initialisation du projet genere par Forge';

  const steps = [
    `git init -q -b ${branch}`,
    'git add -A',
    // Identite locale au depot : ne touche pas a la configuration globale.
    'git -c user.email=forge@localhost -c user.name=Forge commit -q -m ' +
      JSON.stringify(message) +
      ' --no-gpg-sign',
  ];

  for (const command of steps) {
    const result = await run(command, { cwd: dir, timeoutMs: 60_000 });
    if (result.code !== 0) {
      return { ok: false, detail: `${command}: ${result.output.slice(0, 300)}` };
    }
  }
  return { ok: true, detail: `depot git initialise sur ${branch}` };
}

/** Ajoute une remote et pousse via le binaire git (alternative a l'API). */
export async function pushToRemote(
  dir: string,
  remoteUrl: string,
  branch = 'main',
): Promise<{ ok: boolean; detail: string }> {
  const add = await run(`git remote add origin ${JSON.stringify(remoteUrl)}`, {
    cwd: dir,
    timeoutMs: 30_000,
  });
  if (add.code !== 0) {
    await run(`git remote set-url origin ${JSON.stringify(remoteUrl)}`, {
      cwd: dir,
      timeoutMs: 30_000,
    });
  }

  const push = await run(`git push -u origin ${branch}`, { cwd: dir, timeoutMs: 180_000 });
  return {
    ok: push.code === 0,
    detail: push.code === 0 ? 'pousse' : push.output.slice(0, 400),
  };
}
