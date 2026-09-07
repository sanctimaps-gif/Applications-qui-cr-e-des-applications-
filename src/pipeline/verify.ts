import type { EventBus } from '../util/events.js';
import type { ForgeConfig } from '../config.js';
import { run } from '../fs/exec.js';
import { truncate } from '../util/misc.js';
import type { AppSpec, VerificationReport, VerificationStep } from './types.js';

/** Commandes obviously dangereuses : jamais executees, meme si planifiees. */
const BLOCKED = [
  /\brm\s+-rf\s+[/~]/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bshutdown\b|\breboot\b/,
  /\bcurl\b[^|]*\|\s*(ba)?sh/,
  /\bwget\b[^|]*\|\s*(ba)?sh/,
  /:\(\)\s*\{.*\};:/,
  /\bsudo\b/,
  /\bchmod\s+777\s+\//,
  /\bgit\s+push\b/,
];

export function isCommandAllowed(command: string): boolean {
  return !BLOCKED.some((pattern) => pattern.test(command));
}

/**
 * Phase 3 — verification. On execute reellement les commandes du projet :
 * c'est la seule preuve que le code genere fonctionne, et cela alimente la
 * boucle de reparation avec des erreurs vraies plutot que supposees.
 */
export async function verifyProject(
  bus: EventBus,
  cfg: ForgeConfig,
  spec: AppSpec,
  projectDir: string,
  options: { signal?: AbortSignal; skipInstall?: boolean } = {},
): Promise<VerificationReport> {
  const planned: Array<{ name: string; command: string | undefined }> = [
    { name: 'install', command: options.skipInstall ? undefined : spec.commands.install },
    { name: 'lint', command: spec.commands.lint },
    { name: 'build', command: spec.commands.build },
    { name: 'test', command: spec.commands.test },
  ];

  const steps: VerificationStep[] = [];
  bus.emitEvent({ type: 'phase', phase: 'verify', message: 'Verification du projet genere' });

  for (const { name, command } of planned) {
    if (!command) continue;
    if (!isCommandAllowed(command)) {
      bus.log('warn', `commande refusee par la politique de securite: ${command}`);
      continue;
    }

    const result = await run(command, {
      cwd: projectDir,
      timeoutMs: name === 'install' ? cfg.commandTimeoutMs * 2 : cfg.commandTimeoutMs,
      signal: options.signal,
    });

    const step: VerificationStep = {
      name,
      command,
      code: result.code,
      ms: result.ms,
      output: result.output,
      ok: result.code === 0,
    };
    steps.push(step);
    bus.emitEvent({
      type: 'command',
      command,
      code: result.code,
      ms: result.ms,
      output: truncate(result.output, 2_000),
    });

    // Sans dependances installees, build et test n'ont aucune valeur
    // diagnostique : on s'arrete la et on laisse la reparation travailler.
    if (!step.ok && name === 'install') break;
  }

  const failures = steps.filter((step) => !step.ok);
  const failureDigest = failures
    .map((step) => `### commande "${step.command}" — code ${step.code}\n${truncate(step.output, 6_000)}`)
    .join('\n\n');

  return {
    ran: steps.length > 0,
    ok: failures.length === 0,
    steps,
    failureDigest,
  };
}
