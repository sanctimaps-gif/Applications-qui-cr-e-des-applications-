import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../util/misc.js';

interface CacheEntry {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  provider: string;
  at: number;
}

/**
 * Cache deux niveaux (memoire + disque) des reponses de modeles. Regenerer un
 * projet apres une modification mineure ne repaie pas les fichiers inchanges :
 * c'est le gain de performance le plus visible a l'usage.
 */
export class ResponseCache {
  private readonly memory = new Map<string, CacheEntry>();
  private readonly memoryLimit: number;

  constructor(
    private readonly dir: string,
    private readonly enabled: boolean,
    memoryLimit = 512,
  ) {
    this.memoryLimit = memoryLimit;
  }

  static key(parts: unknown[]): string {
    return sha256(JSON.stringify(parts));
  }

  private file(key: string): string {
    // Repartition en sous-dossiers : evite un repertoire de 100k entrees.
    return path.join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    if (!this.enabled) return undefined;
    const hit = this.memory.get(key);
    if (hit) return hit;
    try {
      const raw = await fs.readFile(this.file(key), 'utf8');
      const entry = JSON.parse(raw) as CacheEntry;
      this.remember(key, entry);
      return entry;
    } catch {
      return undefined;
    }
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    if (!this.enabled) return;
    this.remember(key, entry);
    const target = this.file(key);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(entry), 'utf8');
    } catch {
      /* le cache est un bonus : une ecriture ratee ne doit rien casser */
    }
  }

  private remember(key: string, entry: CacheEntry): void {
    if (this.memory.size >= this.memoryLimit) {
      const oldest = this.memory.keys().next().value;
      if (oldest !== undefined) this.memory.delete(oldest);
    }
    this.memory.set(key, entry);
  }

  async clear(): Promise<void> {
    this.memory.clear();
    await fs.rm(this.dir, { recursive: true, force: true });
  }
}
