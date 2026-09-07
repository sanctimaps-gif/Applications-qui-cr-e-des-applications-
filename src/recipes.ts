import type { Commands } from './pipeline/types.js';

/**
 * Connaissance par ecosysteme : commandes canoniques, fichiers ignores et
 * etapes de CI. Elle sert de filet de securite quand le plan produit par le
 * modele oublie une commande, et permet de generer une CI correcte quel que
 * soit le langage — pas seulement pour Node.
 */
export interface Recipe {
  runtime: string;
  /** Valeurs de `runtime` ou de `language` qui doivent tomber sur cette recette. */
  aliases: string[];
  /** Fichiers manifestes qui identifient l'ecosysteme. */
  manifests: string[];
  commands: Commands;
  gitignore: string[];
  /** Etapes YAML inserees dans le workflow GitHub Actions. */
  ciSetup: string[];
}

const COMMON_IGNORES = ['.env', '.DS_Store', '*.log'];

export const RECIPES: Recipe[] = [
  {
    runtime: 'node',
    aliases: ['node', 'nodejs', 'javascript', 'typescript', 'js', 'ts', 'react', 'next', 'express', 'fastify'],
    manifests: ['package.json'],
    commands: {
      install: 'npm install --no-audit --no-fund',
      // `--if-present` : une commande absente ne fait pas echouer la verification.
      build: 'npm run build --if-present',
      lint: 'npm run lint --if-present',
      test: 'npm test --if-present',
      start: 'npm start',
    },
    gitignore: ['node_modules/', 'dist/', 'build/', '.next/', 'coverage/', ...COMMON_IGNORES],
    ciSetup: ['      - uses: actions/setup-node@v4', '        with:', "          node-version: '20'"],
  },
  {
    runtime: 'bun',
    aliases: ['bun'],
    manifests: ['package.json', 'bun.lockb'],
    commands: { install: 'bun install', test: 'bun test', start: 'bun run start' },
    gitignore: ['node_modules/', 'dist/', ...COMMON_IGNORES],
    ciSetup: ['      - uses: oven-sh/setup-bun@v2'],
  },
  {
    runtime: 'deno',
    aliases: ['deno'],
    manifests: ['deno.json', 'deno.jsonc'],
    commands: { test: 'deno test -A', lint: 'deno lint', start: 'deno run -A main.ts' },
    gitignore: ['.deno/', ...COMMON_IGNORES],
    ciSetup: ['      - uses: denoland/setup-deno@v2', '        with:', "          deno-version: v2.x"],
  },
  {
    runtime: 'python',
    aliases: ['python', 'py', 'python3', 'fastapi', 'django', 'flask'],
    manifests: ['requirements.txt', 'pyproject.toml', 'setup.py'],
    commands: {
      install: 'python -m pip install -r requirements.txt',
      test: 'python -m pytest -q',
      start: 'python main.py',
    },
    gitignore: ['__pycache__/', '*.py[cod]', '.venv/', 'venv/', '.pytest_cache/', '*.egg-info/', ...COMMON_IGNORES],
    ciSetup: ['      - uses: actions/setup-python@v5', '        with:', "          python-version: '3.12'"],
  },
  {
    runtime: 'go',
    aliases: ['go', 'golang'],
    manifests: ['go.mod'],
    commands: { install: 'go mod download', build: 'go build ./...', test: 'go test ./...', lint: 'go vet ./...' },
    gitignore: ['bin/', '*.exe', ...COMMON_IGNORES],
    ciSetup: ['      - uses: actions/setup-go@v5', '        with:', "          go-version: '1.23'"],
  },
  {
    runtime: 'rust',
    aliases: ['rust', 'cargo'],
    manifests: ['Cargo.toml'],
    commands: { build: 'cargo build --locked || cargo build', test: 'cargo test', lint: 'cargo clippy -- -D warnings' },
    gitignore: ['target/', ...COMMON_IGNORES],
    ciSetup: ['      - uses: dtolnay/rust-toolchain@stable'],
  },
  {
    runtime: 'java',
    aliases: ['java', 'kotlin', 'maven', 'gradle', 'spring'],
    manifests: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    commands: { build: 'mvn -B -q package -DskipTests', test: 'mvn -B -q test' },
    gitignore: ['target/', 'build/', '.gradle/', ...COMMON_IGNORES],
    ciSetup: [
      '      - uses: actions/setup-java@v4',
      '        with:',
      "          distribution: 'temurin'",
      "          java-version: '21'",
    ],
  },
  {
    runtime: 'ruby',
    aliases: ['ruby', 'rails', 'sinatra'],
    manifests: ['Gemfile'],
    commands: { install: 'bundle install', test: 'bundle exec rake test' },
    gitignore: ['vendor/bundle/', '.bundle/', ...COMMON_IGNORES],
    ciSetup: ['      - uses: ruby/setup-ruby@v1', '        with:', "          ruby-version: '3.3'"],
  },
  {
    runtime: 'php',
    aliases: ['php', 'laravel', 'symfony'],
    manifests: ['composer.json'],
    commands: { install: 'composer install --no-interaction', test: 'vendor/bin/phpunit' },
    gitignore: ['vendor/', ...COMMON_IGNORES],
    ciSetup: ['      - uses: shivammathur/setup-php@v2', '        with:', "          php-version: '8.3'"],
  },
  {
    runtime: 'dotnet',
    aliases: ['dotnet', 'csharp', 'c#', '.net'],
    manifests: ['*.csproj', '*.sln'],
    commands: { install: 'dotnet restore', build: 'dotnet build --no-restore', test: 'dotnet test --no-build' },
    gitignore: ['bin/', 'obj/', ...COMMON_IGNORES],
    ciSetup: ['      - uses: actions/setup-dotnet@v4', '        with:', "          dotnet-version: '8.0.x'"],
  },
  {
    runtime: 'static',
    aliases: ['static', 'html', 'site', 'web'],
    manifests: ['index.html'],
    commands: {},
    gitignore: [...COMMON_IGNORES],
    ciSetup: [],
  },
];

const FALLBACK: Recipe = {
  runtime: 'other',
  aliases: [],
  manifests: [],
  commands: {},
  gitignore: [...COMMON_IGNORES],
  ciSetup: [],
};

/** Recette correspondant a un runtime/langage, avec repli neutre. */
export function findRecipe(runtime: string, language = ''): Recipe {
  const needle = `${runtime} ${language}`.toLowerCase();
  return (
    RECIPES.find((recipe) => recipe.runtime === runtime.toLowerCase()) ??
    RECIPES.find((recipe) => recipe.aliases.some((alias) => needle.includes(alias))) ??
    FALLBACK
  );
}

/** Recette deduite des fichiers reellement presents dans un projet. */
export function detectRecipe(files: readonly string[]): Recipe {
  const names = new Set(files.map((file) => file.split('/').pop() ?? file));
  for (const recipe of RECIPES) {
    for (const manifest of recipe.manifests) {
      if (manifest.startsWith('*.')) {
        const extension = manifest.slice(1);
        if (files.some((file) => file.endsWith(extension))) return recipe;
      } else if (names.has(manifest)) {
        return recipe;
      }
    }
  }
  return FALLBACK;
}

/**
 * Complete les commandes manquantes du plan avec celles de l'ecosysteme, mais
 * seulement si le manifeste correspondant est reellement planifie : proposer
 * `npm install` a un projet sans package.json ne ferait qu'echouer.
 */
export function fillCommands(commands: Commands, recipe: Recipe, plannedFiles: readonly string[]): Commands {
  const hasManifest =
    recipe.manifests.length === 0 ||
    recipe.manifests.some((manifest) =>
      manifest.startsWith('*.')
        ? plannedFiles.some((file) => file.endsWith(manifest.slice(1)))
        : plannedFiles.some((file) => file === manifest || file.endsWith(`/${manifest}`)),
    );
  if (!hasManifest) return commands;

  const merged: Commands = { ...commands };
  for (const [key, value] of Object.entries(recipe.commands) as Array<[keyof Commands, string]>) {
    if (!merged[key]) merged[key] = value;
  }
  return merged;
}

/** Contenu de .gitignore adapte a l'ecosysteme. */
export function gitignoreFor(recipe: Recipe): string {
  return `${recipe.gitignore.join('\n')}\n`;
}

/** Workflow GitHub Actions adapte a l'ecosysteme. */
export function workflowFor(recipe: Recipe, commands: Commands): string {
  const steps = [
    '      - uses: actions/checkout@v4',
    ...recipe.ciSetup,
    ...(commands.install ? [`      - run: ${commands.install}`] : []),
    ...(commands.lint ? [`      - run: ${commands.lint}`] : []),
    ...(commands.build ? [`      - run: ${commands.build}`] : []),
    ...(commands.test ? [`      - run: ${commands.test}`] : []),
  ];

  return `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${steps.join('\n')}
`;
}
