#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { loadConfig, loadDotEnv, type ForgeConfig } from './config.js';
import { EventBus } from './util/events.js';
import { Logger, color } from './util/logger.js';
import { LLMClient } from './llm/client.js';
import { ModelRouter } from './providers/registry.js';
import { GitHubClient } from './git/github.js';
import { Workspace } from './fs/workspace.js';
import { buildApp, publishProject } from './pipeline/orchestrator.js';
import { iterateProject } from './pipeline/iterate.js';
import { RECIPES } from './recipes.js';
import { startServer } from './server/http.js';
import { formatDuration, toError } from './util/misc.js';
import { ResponseCache } from './llm/cache.js';
import type { BuildOptions } from './pipeline/types.js';

interface Flags {
  _: string[];
  [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const [rawKey, inlineValue] = arg.slice(2).split('=');
      const key = (rawKey ?? '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      if (!key) continue;
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
      } else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) {
        flags[key] = argv[++i]!;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true;
    } else {
      (flags._ as string[]).push(arg);
    }
  }
  return flags;
}

const str = (flags: Flags, key: string): string | undefined =>
  typeof flags[key] === 'string' ? (flags[key] as string) : undefined;
const bool = (flags: Flags, key: string, fallback?: boolean): boolean | undefined =>
  flags[key] === undefined ? fallback : flags[key] !== false && flags[key] !== 'false';

const HELP = `${color.bold('forge')} — genere des applications completes avec une IA, sans limite.

${color.bold('USAGE')}
  forge new "<description>" [options]
  forge iterate <repertoire> "<modification>" [options]
  forge serve [--port 7331] [--host 127.0.0.1]
  forge publish <repertoire> [--repo nom] [--public]
  forge providers
  forge stacks
  forge doctor
  forge cache clear

${color.bold('OPTIONS DE `new`')}
  --out <dir>            Repertoire de sortie (defaut: <workspace>/<slug>)
  --name <nom>           Nom impose du projet
  --stack <pile>         Pile imposee, ex. "Python + FastAPI + SQLite"
  --provider <nom>       Force un fournisseur (openai, anthropic, google, ollama...)
  --no-verify            N'execute pas install/build/test
  --repair <n>           Boucles de reparation (0 = illimite, defaut: illimite)
  --github               Cree un depot GitHub et y pousse le projet
  --repo <nom>           Nom du depot GitHub
  --owner <org>          Organisation proprietaire du depot
  --public               Depot public (defaut: prive)
  --branch <nom>         Pousse sur cette branche
  --pr                   Ouvre une pull request depuis --branch
  --release <tag>        Publie une release (ex. v0.1.0)
  --topics <a,b,c>       Sujets du depot (defaut: deduits du projet)
  --pages                Active GitHub Pages (sites statiques)
  --ci                   Ajoute un workflow GitHub Actions au projet genere
  --json                 Sortie JSON (integration dans un script)
  --quiet                Journal minimal

${color.bold('EXEMPLES')}
  forge new "Un raccourcisseur d'URL avec statistiques, API REST et tests"
  forge new "Un jeu de la vie en Rust avec rendu terminal" --stack "Rust" --github --public
  forge new "Un portfolio statique" --github --public --pages --release v1.0.0
  forge iterate ./mon-app "Ajoute une pagination et les tests correspondants"
  forge iterate ./mon-app "Passe la base en PostgreSQL" --github --branch feat/pg --pr
  forge serve --port 8080

${color.bold('CONFIGURATION')}
  Au moins un fournisseur : OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY,
  MISTRAL_API_KEY, GROQ_API_KEY, DEEPSEEK_API_KEY, OPENROUTER_API_KEY, XAI_API_KEY,
  TOGETHER_API_KEY — ou 100 % local avec OLLAMA_BASE_URL.
  GitHub : GITHUB_TOKEN (droits repo + workflow).
`;

/**
 * `--quiet` reduit le bruit de progression, mais laisse passer les
 * avertissements, les erreurs et le resume final : c'est le journal qui est
 * silencieux, pas le resultat.
 */
function attachConsole(bus: EventBus, logger: Logger, quiet: boolean): void {
  bus.onEvent((event) => {
    switch (event.type) {
      case 'phase':
        if (!quiet) logger.step(event.message);
        break;
      case 'plan':
        if (!quiet) logger.info(`  ${color.dim(`${event.name} · ${event.files} fichiers · ${event.stack}`)}`);
        break;
      case 'file:done':
        if (!quiet) {
          logger.info(
            `  ${color.green('✔')} ${event.path} ${color.dim(`${event.bytes} o · ${formatDuration(event.ms)} · ${event.index}/${event.total}`)}`,
          );
        }
        break;
      case 'file:error':
        logger.warn(`${event.path}: ${event.error}`);
        break;
      case 'command':
        if (!quiet || event.code !== 0) {
          logger.info(
            `  ${event.code === 0 ? color.green('$') : color.red('$')} ${event.command} ${color.dim(`→ ${event.code} · ${formatDuration(event.ms)}`)}`,
          );
        }
        if (event.code !== 0 && !quiet) logger.info(color.dim(event.output.slice(0, 1_500)));
        break;
      case 'repair':
        if (!quiet) logger.step(`reparation ${event.attempt}`);
        break;
      case 'github':
        logger.success(`GitHub : ${event.action}${event.url ? ` → ${event.url}` : ''}`);
        break;
      case 'log':
        if (event.level === 'error') logger.error(event.message);
        else if (event.level === 'warn') logger.warn(event.message);
        else if (!quiet) logger.debug(event.message);
        break;
      case 'error':
        logger.error(event.message);
        break;
      default:
        break;
    }
  });
}

async function cmdNew(flags: Flags, cfg: ForgeConfig, logger: Logger): Promise<number> {
  const prompt = (flags._ as string[]).slice(1).join(' ').trim();
  if (!prompt) {
    logger.error('description manquante. Exemple : forge new "Une API de gestion de taches"');
    return 2;
  }

  const asJson = bool(flags, 'json', false)!;
  const quiet = bool(flags, 'quiet', false)! || asJson;
  const bus = new EventBus();
  if (!asJson) attachConsole(bus, logger, quiet);

  const llm = new LLMClient(cfg, bus);
  if (!llm.hasProvider()) {
    logger.error(
      "Aucun fournisseur configure. Definissez une cle (ex. export OPENAI_API_KEY=...) ou lancez Ollama et exportez OLLAMA_BASE_URL=http://127.0.0.1:11434/v1. Detail : forge doctor",
    );
    return 3;
  }

  const controller = new AbortController();
  const onSigint = () => {
    logger.warn('interruption demandee, arret en cours…');
    controller.abort();
  };
  process.once('SIGINT', onSigint);

  const options: BuildOptions = {
    prompt,
    name: str(flags, 'name'),
    stack: str(flags, 'stack'),
    outDir: str(flags, 'out') ? path.resolve(str(flags, 'out')!) : undefined,
    verify: bool(flags, 'verify', undefined),
    maxRepairAttempts: str(flags, 'repair') ? Number.parseInt(str(flags, 'repair')!, 10) : undefined,
    github: bool(flags, 'github', false),
    repoName: str(flags, 'repo'),
    repoOwner: str(flags, 'owner'),
    repoPrivate: !bool(flags, 'public', false),
    branch: str(flags, 'branch'),
    pullRequest: bool(flags, 'pr', false),
    release: str(flags, 'release'),
    topics: str(flags, 'topics')?.split(',').map((t) => t.trim()).filter(Boolean),
    pages: bool(flags, 'pages', false),
    withCi: bool(flags, 'ci', true),
    provider: str(flags, 'provider'),
    signal: controller.signal,
  };

  try {
    const result = await buildApp({ cfg, bus, llm }, options);

    if (asJson) {
      process.stdout.write(
        `${JSON.stringify(
          {
            projectDir: result.projectDir,
            name: result.spec.name,
            stack: result.spec.stack,
            files: result.files.map((f) => f.path),
            verified: result.verification.ok,
            repairAttempts: result.repairAttempts,
            repo: result.repo,
            usage: result.usage,
            ms: result.ms,
          },
          null,
          2,
        )}\n`,
      );
      return result.verification.ok ? 0 : 1;
    }

    logger.info('');
    logger.success(`${result.spec.name} — ${result.files.length} fichiers en ${formatDuration(result.ms)}`);
    logger.info(`  ${color.dim('repertoire')}  ${result.projectDir}`);
    logger.info(`  ${color.dim('pile')}        ${result.spec.stack}`);
    logger.info(
      `  ${color.dim('verification')} ${
        !result.verification.ran
          ? color.dim('desactivee')
          : result.verification.ok
            ? color.green('succes')
            : color.red(`echec apres ${result.repairAttempts} reparation(s)`)
      }`,
    );
    logger.info(
      `  ${color.dim('modeles')}     ${result.usage.requests} requetes · ${result.usage.cacheHits} en cache · ${result.usage.inputTokens + result.usage.outputTokens} tokens`,
    );
    if (result.repo) {
      logger.info(`  ${color.dim('depot')}       ${result.repo.url}`);
      if (result.repo.pullRequestUrl) logger.info(`  ${color.dim('pull request')} ${result.repo.pullRequestUrl}`);
      if (result.repo.releaseUrl) logger.info(`  ${color.dim('release')}     ${result.repo.releaseUrl}`);
      if (result.repo.pagesUrl) logger.info(`  ${color.dim('pages')}       ${result.repo.pagesUrl}`);
    }

    const next = result.spec.commands.dev ?? result.spec.commands.start;
    if (next) {
      logger.info('');
      logger.info(`  Pour demarrer :  cd ${result.projectDir} && ${next}`);
    }
    return result.verification.ran && !result.verification.ok ? 1 : 0;
  } catch (error) {
    logger.error(toError(error).message);
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

async function cmdIterate(flags: Flags, cfg: ForgeConfig, logger: Logger): Promise<number> {
  const positional = flags._ as string[];
  const dir = positional[1];
  const request = positional.slice(2).join(' ').trim();

  if (!dir || !request) {
    logger.error('utilisation : forge iterate <repertoire> "<modification demandee>"');
    return 2;
  }

  const asJson = bool(flags, 'json', false)!;
  const quiet = bool(flags, 'quiet', false)! || asJson;
  const bus = new EventBus();
  if (!asJson) attachConsole(bus, logger, quiet);

  const llm = new LLMClient(cfg, bus);
  if (!llm.hasProvider()) {
    logger.error('Aucun fournisseur configure. Detail : forge doctor');
    return 3;
  }

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);

  try {
    const result = await iterateProject(
      { cfg, bus, llm },
      {
        dir: path.resolve(dir),
        request,
        verify: bool(flags, 'verify', undefined),
        maxRepairAttempts: str(flags, 'repair') ? Number.parseInt(str(flags, 'repair')!, 10) : undefined,
        provider: str(flags, 'provider'),
        github: bool(flags, 'github', false),
        repoName: str(flags, 'repo'),
        repoOwner: str(flags, 'owner'),
        repoPrivate: !bool(flags, 'public', false),
        branch: str(flags, 'branch'),
        pullRequest: bool(flags, 'pr', false),
        commitMessage: str(flags, 'message'),
        signal: controller.signal,
      },
    );

    if (asJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.verification.ran && !result.verification.ok ? 1 : 0;
    }

    logger.info('');
    logger.success(result.summary);
    for (const file of result.created) logger.info(`  ${color.green('+')} ${file}`);
    for (const file of result.modified) logger.info(`  ${color.cyan('~')} ${file}`);
    for (const file of result.deleted) logger.info(`  ${color.red('-')} ${file}`);
    logger.info(
      `  ${color.dim('verification')} ${
        !result.verification.ran
          ? color.dim('desactivee')
          : result.verification.ok
            ? color.green('succes')
            : color.red(`echec apres ${result.repairAttempts} reparation(s)`)
      }`,
    );
    if (result.repo?.pullRequestUrl) logger.info(`  ${color.dim('pull request')} ${result.repo.pullRequestUrl}`);
    else if (result.repo) logger.info(`  ${color.dim('depot')}       ${result.repo.url}`);

    return result.verification.ran && !result.verification.ok ? 1 : 0;
  } catch (error) {
    logger.error(toError(error).message);
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

function cmdStacks(logger: Logger): number {
  logger.info(color.bold('Ecosystemes reconnus\n'));
  for (const recipe of RECIPES) {
    const commands = Object.entries(recipe.commands)
      .filter(([, value]) => Boolean(value))
      .map(([key, value]) => `${key}: ${value}`)
      .join('  ·  ');
    logger.info(`  ${color.cyan(recipe.runtime.padEnd(8))} ${color.dim(recipe.manifests.join(', ') || '—')}`);
    if (commands) logger.info(`  ${' '.repeat(8)} ${color.dim(commands)}`);
  }
  logger.info('');
  logger.info(
    color.dim(
      "Un ecosysteme non liste reste possible : le plan fournit alors ses propres commandes.",
    ),
  );
  return 0;
}

async function cmdServe(flags: Flags, cfg: ForgeConfig, logger: Logger): Promise<number> {
  const port = str(flags, 'port') ? Number.parseInt(str(flags, 'port')!, 10) : cfg.port;
  const host = str(flags, 'host') ?? cfg.host;
  const { url } = await startServer({ ...cfg, port, host });

  const router = new ModelRouter(cfg);
  const providers = router.configured().map((p) => p.name);

  logger.success(`Forge ecoute sur ${color.bold(url)}`);
  logger.info(`  ${color.dim('fournisseurs')} ${providers.join(', ') || color.red('aucun configure')}`);
  logger.info(`  ${color.dim('github')}       ${GitHubClient.isConfigured(cfg) ? 'configure' : 'non configure'}`);
  logger.info(`  ${color.dim('projets')}      ${cfg.maxProjects === 0 ? 'illimites' : cfg.maxProjects}`);
  if (cfg.authToken) logger.info(`  ${color.dim('auth')}         jeton requis (?token=...)`);
  logger.info(color.dim('\nCtrl+C pour arreter.'));

  await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
  logger.info('arret.');
  return 0;
}

async function cmdPublish(flags: Flags, cfg: ForgeConfig, logger: Logger): Promise<number> {
  const dir = (flags._ as string[])[1];
  if (!dir) {
    logger.error('repertoire manquant. Exemple : forge publish ./mon-projet --repo mon-projet');
    return 2;
  }
  if (!GitHubClient.isConfigured(cfg)) {
    logger.error('GITHUB_TOKEN absent.');
    return 3;
  }

  const root = path.resolve(dir);
  const workspace = new Workspace(root);
  const bus = new EventBus();
  attachConsole(bus, logger, false);

  const manifest = await workspace.tryRead('.forge.json');
  const parsed = manifest ? (JSON.parse(manifest) as { spec?: { name?: string; summary?: string } }) : undefined;
  const name = str(flags, 'repo') ?? parsed?.spec?.name ?? path.basename(root);

  try {
    const repo = await publishProject(
      { cfg, bus, llm: new LLMClient(cfg, bus) },
      workspace,
      {
        name,
        slug: name,
        summary: parsed?.spec?.summary ?? `Projet ${name}`,
        stack: '',
        language: '',
        runtime: 'other',
        features: [],
        files: [],
        commands: {},
        env: [],
      },
      {
        prompt: '',
        repoName: str(flags, 'repo') ?? name,
        repoOwner: str(flags, 'owner'),
        repoPrivate: !bool(flags, 'public', false),
      },
    );
    logger.success(`publie : ${repo.url}`);
    return 0;
  } catch (error) {
    logger.error(toError(error).message);
    return 1;
  }
}

function cmdProviders(cfg: ForgeConfig, logger: Logger): number {
  const router = new ModelRouter(cfg);
  const configured = new Set(router.configured().map((p) => p.name));

  logger.info(color.bold('Fournisseurs'));
  for (const provider of router.all()) {
    const ok = configured.has(provider.name);
    const mark = ok ? color.green('●') : color.dim('○');
    const models = ok
      ? color.dim(
          `deep=${provider.modelFor('deep').id} balanced=${provider.modelFor('balanced').id} fast=${provider.modelFor('fast').id}`,
        )
      : color.dim('non configure');
    logger.info(`  ${mark} ${provider.name.padEnd(11)} ${models}`);
  }
  logger.info('');
  logger.info(color.dim(`ordre de preference : ${cfg.providerOrder.join(' > ')}`));
  return configured.size > 0 ? 0 : 1;
}

async function cmdDoctor(cfg: ForgeConfig, logger: Logger): Promise<number> {
  const router = new ModelRouter(cfg);
  const configured = router.configured();

  logger.info(color.bold('Diagnostic Forge\n'));
  logger.info(`  node          ${process.version}`);
  logger.info(`  workspace     ${cfg.workspace}`);
  logger.info(`  cache         ${cfg.cache ? cfg.cacheDir : 'desactive'}`);
  logger.info(
    `  limites       projets=${cfg.maxProjects || 'illimite'} fichiers=${cfg.maxFiles || 'illimite'} reparations=${cfg.maxRepairAttempts || 'illimite'} tokens=${cfg.maxTokens || 'illimite'}`,
  );
  logger.info('');

  if (configured.length === 0) {
    logger.error('aucun fournisseur configure');
  } else {
    logger.info(color.bold('Fournisseurs configures'));
    for (const provider of configured) {
      const probe = provider.probe ? await provider.probe() : { ok: true, detail: 'sonde indisponible' };
      logger.info(
        `  ${probe.ok ? color.green('●') : color.red('✖')} ${provider.name.padEnd(11)} ${color.dim(probe.detail)}`,
      );
    }
  }

  logger.info('');
  logger.info(color.bold('GitHub'));
  if (!GitHubClient.isConfigured(cfg)) {
    logger.info(`  ${color.dim('○')} GITHUB_TOKEN absent`);
  } else {
    try {
      const me = await new GitHubClient(cfg).me();
      logger.info(`  ${color.green('●')} connecte en tant que ${me.login}`);
    } catch (error) {
      logger.info(`  ${color.red('✖')} ${toError(error).message.slice(0, 200)}`);
    }
  }

  return configured.length > 0 ? 0 : 1;
}

async function main(): Promise<number> {
  loadDotEnv();
  const flags = parseArgs(process.argv.slice(2));
  const command = (flags._ as string[])[0] ?? 'help';
  const cfg = loadConfig();
  // Seul `--json` fait taire la sortie standard ; `--quiet` allege le journal
  // mais conserve le resume final, qui est le resultat attendu.
  const logger = new Logger(bool(flags, 'json', false) ? 'warn' : cfg.logLevel);

  if (bool(flags, 'help', false) || command === 'help' || command === '--help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (bool(flags, 'version', false) || command === 'version') {
    process.stdout.write('forge 0.1.0\n');
    return 0;
  }

  switch (command) {
    case 'new':
    case 'create':
    case 'build':
      return cmdNew(flags, cfg, logger);
    case 'serve':
    case 'server':
      return cmdServe(flags, cfg, logger);
    case 'iterate':
    case 'edit':
    case 'modify':
      return cmdIterate(flags, cfg, logger);
    case 'publish':
      return cmdPublish(flags, cfg, logger);
    case 'providers':
      return cmdProviders(cfg, logger);
    case 'stacks':
    case 'recipes':
      return cmdStacks(logger);
    case 'doctor':
      return cmdDoctor(cfg, logger);
    case 'cache':
      if ((flags._ as string[])[1] === 'clear') {
        await new ResponseCache(cfg.cacheDir, true).clear();
        logger.success('cache vide');
        return 0;
      }
      logger.error('sous-commande inconnue. Utilisation : forge cache clear');
      return 2;
    default:
      logger.error(`commande inconnue : ${command}`);
      process.stdout.write(`\n${HELP}\n`);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${toError(error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
