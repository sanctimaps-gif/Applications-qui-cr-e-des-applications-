import { spawn } from 'node:child_process';
import { truncate } from '../util/misc.js';

export interface ExecResult {
  command: string;
  code: number;
  stdout: string;
  stderr: string;
  output: string;
  ms: number;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxOutputChars?: number;
}

/**
 * Execute une commande shell dans l'espace de travail du projet et capture sa
 * sortie. Ne jette jamais sur un code de retour non nul : l'appelant decide,
 * la boucle de reparation a besoin de la sortie d'erreur.
 */
export function run(command: string, options: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 300_000;
  const maxOutput = options.maxOutputChars ?? 24_000;

  return new Promise<ExecResult>((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      env: { ...process.env, ...options.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = () => child.kill('SIGKILL');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > maxOutput * 4) stdout = stdout.slice(-maxOutput * 2);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > maxOutput * 4) stderr = stderr.slice(-maxOutput * 2);
    });

    const finish = (code: number) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const output = truncate([stdout, stderr].filter(Boolean).join('\n'), maxOutput);
      resolve({
        command,
        code,
        stdout: truncate(stdout, maxOutput),
        stderr: truncate(stderr, maxOutput),
        output,
        ms: Date.now() - started,
        timedOut,
      });
    };

    child.on('error', (error) => {
      stderr += `\n${error.message}`;
      finish(127);
    });
    child.on('close', (code) => finish(timedOut ? 124 : (code ?? 1)));
  });
}

/** Vrai si un binaire est disponible dans le PATH. */
export async function hasBinary(name: string, cwd = process.cwd()): Promise<boolean> {
  const probe = process.platform === 'win32' ? `where ${name}` : `command -v ${name}`;
  const result = await run(probe, { cwd, timeoutMs: 10_000 });
  return result.code === 0;
}
