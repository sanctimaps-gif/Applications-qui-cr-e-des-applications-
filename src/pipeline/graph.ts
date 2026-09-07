import type { FileSpec } from './types.js';

/**
 * Ordonnance les fichiers en vagues : tous les fichiers d'une meme vague sont
 * independants entre eux et se generent donc en parallele. C'est ce qui rend
 * Forge rapide sur les gros projets — une application de 40 fichiers se
 * genere en 5 ou 6 vagues, pas en 40 appels sequentiels.
 *
 * Les cycles ne bloquent pas : les fichiers restants sont regroupes dans une
 * derniere vague, car un plan imparfait ne doit pas faire echouer le build.
 */
export function topologicalWaves(files: readonly FileSpec[]): FileSpec[][] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const remaining = new Map(
    files.map((file) => [file.path, new Set(file.dependsOn.filter((dep) => byPath.has(dep)))]),
  );
  const done = new Set<string>();
  const waves: FileSpec[][] = [];

  while (remaining.size > 0) {
    const ready: FileSpec[] = [];
    for (const [path, deps] of remaining) {
      let satisfied = true;
      for (const dep of deps) {
        if (!done.has(dep)) {
          satisfied = false;
          break;
        }
      }
      if (satisfied) ready.push(byPath.get(path)!);
    }

    if (ready.length === 0) {
      // Cycle detecte : on degrade proprement plutot que de boucler.
      waves.push([...remaining.keys()].map((path) => byPath.get(path)!));
      break;
    }

    // Les fichiers les plus complexes demarrent en premier dans la vague :
    // ils dominent le temps total, autant les lancer tot.
    ready.sort((a, b) => b.complexity - a.complexity);
    waves.push(ready);
    for (const file of ready) {
      done.add(file.path);
      remaining.delete(file.path);
    }
  }

  return waves;
}
