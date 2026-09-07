import test from 'node:test';
import assert from 'node:assert/strict';

import { RECIPES, detectRecipe, fillCommands, findRecipe, gitignoreFor, workflowFor } from '../src/recipes.js';

test('chaque ecosysteme est resolu par son runtime et ses alias', () => {
  assert.equal(findRecipe('node').runtime, 'node');
  assert.equal(findRecipe('python').runtime, 'python');
  assert.equal(findRecipe('', 'TypeScript').runtime, 'node');
  assert.equal(findRecipe('', 'Rust').runtime, 'rust');
  assert.equal(findRecipe('inconnu', 'brainfuck').runtime, 'other');
});

test("l'ecosysteme se deduit des fichiers presents", () => {
  assert.equal(detectRecipe(['src/main.go', 'go.mod']).runtime, 'go');
  assert.equal(detectRecipe(['app/requirements.txt']).runtime, 'python');
  assert.equal(detectRecipe(['Cargo.toml', 'src/main.rs']).runtime, 'rust');
  assert.equal(detectRecipe(['MyApp.csproj']).runtime, 'dotnet');
  assert.equal(detectRecipe(['index.html', 'style.css']).runtime, 'static');
  assert.equal(detectRecipe(['notes.txt']).runtime, 'other');
});

test('les commandes manquantes sont completees, les existantes preservees', () => {
  const filled = fillCommands({ test: 'vitest run' }, findRecipe('node'), ['package.json', 'src/a.ts']);
  assert.equal(filled.test, 'vitest run', 'la commande du plan gagne');
  assert.equal(filled.install, 'npm install --no-audit --no-fund');
  assert.match(filled.build!, /--if-present/);
});

test('sans manifeste, aucune commande n est inventee', () => {
  // Proposer `npm install` a un projet sans package.json ne ferait qu'echouer.
  const filled = fillCommands({}, findRecipe('node'), ['index.html']);
  assert.deepEqual(filled, {});
});

test('le workflow CI reprend les etapes de l ecosysteme', () => {
  const python = workflowFor(findRecipe('python'), {
    install: 'pip install -r requirements.txt',
    test: 'pytest',
  });
  assert.match(python, /actions\/setup-python@v5/);
  assert.match(python, /- run: pytest/);
  assert.ok(!python.includes('setup-node'));

  const go = workflowFor(findRecipe('go'), { test: 'go test ./...' });
  assert.match(go, /actions\/setup-go@v5/);
});

test('le .gitignore est adapte a l ecosysteme', () => {
  assert.match(gitignoreFor(findRecipe('node')), /node_modules\//);
  assert.match(gitignoreFor(findRecipe('python')), /__pycache__\//);
  assert.match(gitignoreFor(findRecipe('rust')), /target\//);
  // Les entrees communes sont partout.
  for (const recipe of RECIPES) assert.match(gitignoreFor(recipe), /\.env/);
});
