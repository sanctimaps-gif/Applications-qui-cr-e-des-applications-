import type { LLMClient } from '../llm/client.js';
import type { EventBus } from '../util/events.js';
import type { ForgeConfig } from '../config.js';
import { limit } from '../config.js';
import { extractJson } from '../util/json.js';
import { isRecord, truncate } from '../util/misc.js';
import { normalizeRelPath, type Workspace } from '../fs/workspace.js';
import { Pool } from '../util/pool.js';
import type { AppSpec, VerificationReport } from './types.js';
import { regenerateFile } from './generate.js';
import { verifyProject } from './verify.js';

const TRIAGE_SYSTEM = `Tu diagnostiques l'echec du build d'un projet.

A partir de la sortie d'erreur reelle, identifie les fichiers a corriger et la cause racine de chaque probleme.
- Cible le moins de fichiers possible, mais tous ceux qui sont reellement en cause.
- Une erreur "module introuvable" se corrige presque toujours dans le manifeste de dependances ou dans l'import fautif.
- Ne propose jamais de supprimer, ignorer ou desactiver un test pour faire passer le build.

Reponds UNIQUEMENT par un JSON :
{ "diagnosis": string, "fixes": [{ "path": string, "problem": string }] }`;

interface Triage {
  diagnosis: string;
  fixes: Array<{ path: string; problem: string }>;
}

function parseTriage(text: string): Triage | undefined {
  const raw = extractJson<unknown>(text);
  if (!isRecord(raw)) return undefined;
  const fixes = Array.isArray(raw['fixes']) ? raw['fixes'] : [];
  const parsed = fixes.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry['path'] !== 'string') return [];
    const path = normalizeRelPath(entry['path']);
    if (!path) return [];
    return [
      {
        path,
        problem: typeof entry['problem'] === 'string' ? entry['problem'] : 'erreur de build',
      },
    ];
  });
  if (parsed.length === 0) return undefined;
  return {
    diagnosis: typeof raw['diagnosis'] === 'string' ? raw['diagnosis'] : '',
    // On accepte les fichiers nouveaux (le plan peut avoir oublie un module),
    // mais on borne a un nombre raisonnable par tour.
    fixes: parsed.slice(0, 12),
  };
}

/**
 * Phase 4 — auto-reparation. Tant que la verification echoue, Forge lit les
 * erreurs reelles, cible les fichiers fautifs, les regenere en parallele et
 * relance. Par defaut `maxRepairAttempts = 0` : la boucle continue tant
 * qu'elle progresse (aucune limite arbitraire), avec un garde-fou contre les
 * boucles improductives.
 */
export async function repairLoop(
  llm: LLMClient,
  bus: EventBus,
  cfg: ForgeConfig,
  spec: AppSpec,
  workspace: Workspace,
  initial: VerificationReport,
  options: { maxAttempts?: number; provider?: string; signal?: AbortSignal } = {},
): Promise<{ verification: VerificationReport; attempts: number }> {
  let report = initial;
  if (report.ok || !report.ran) return { verification: report, attempts: 0 };

  const max = limit(options.maxAttempts ?? cfg.maxRepairAttempts);
  const hardStop = Number.isFinite(max) ? (max as number) : 25; // garde-fou anti-boucle
  const known = new Set(spec.files.map((file) => file.path));
  const pool = new Pool(8);

  let attempts = 0;
  let lastDigest = '';
  let stagnation = 0;

  while (!report.ok && attempts < hardStop) {
    if (options.signal?.aborted) break;
    attempts++;

    bus.emitEvent({
      type: 'repair',
      attempt: attempts,
      reason: truncate(report.failureDigest, 400),
    });

    const tree = spec.files.map((file) => file.path).join('\n');
    const triageText = await llm.askText(
      'deep',
      TRIAGE_SYSTEM,
      `Projet : ${spec.name} (${spec.stack})

FICHIERS DU PROJET :
${tree}

SORTIE D'ERREUR :
${truncate(report.failureDigest, 12_000)}

Diagnostique et liste les fichiers a corriger.`,
      { temperature: 0, maxTokens: 4_000, noCache: true, provider: options.provider, signal: options.signal },
    );

    const triage = parseTriage(triageText);
    if (!triage) {
      bus.log('warn', 'diagnostic illisible, arret de la boucle de reparation');
      break;
    }
    bus.log('info', `reparation ${attempts}: ${truncate(triage.diagnosis, 240)}`);

    const outcomes = await pool.settle(triage.fixes, (fix) =>
      regenerateFile(llm, bus, cfg, spec, workspace, fix.path, `${triage.diagnosis}\n\n${fix.problem}\n\n${report.failureDigest}`, {
        provider: options.provider,
        signal: options.signal,
      }),
    );

    let changed = 0;
    for (const [i, outcome] of outcomes.entries()) {
      const fix = triage.fixes[i]!;
      if (outcome.ok && outcome.value) {
        changed++;
        if (!known.has(fix.path)) {
          known.add(fix.path);
          spec.files.push({
            path: fix.path,
            purpose: 'Ajoute pendant la reparation',
            dependsOn: [],
            complexity: 3,
            exports: [],
          });
        }
      } else if (!outcome.ok) {
        bus.emitEvent({ type: 'file:error', path: fix.path, error: outcome.error.message });
      }
    }

    if (changed === 0) {
      bus.log('warn', 'aucune correction applicable, arret de la boucle');
      break;
    }

    report = await verifyProject(bus, cfg, spec, workspace.root, {
      signal: options.signal,
      // Les dependances sont deja installees sauf si c'est justement l'etape
      // qui a echoue.
      skipInstall: initial.steps.some((step) => step.name === 'install' && step.ok),
    });

    // Si l'erreur est rigoureusement identique deux tours de suite, la boucle
    // n'apprend plus rien : on s'arrete plutot que de bruler des tokens.
    if (report.failureDigest === lastDigest) {
      stagnation++;
      if (stagnation >= 2) {
        bus.log('warn', 'erreur inchangee apres deux tentatives, arret de la reparation');
        break;
      }
    } else {
      stagnation = 0;
    }
    lastDigest = report.failureDigest;
  }

  return { verification: report, attempts };
}
