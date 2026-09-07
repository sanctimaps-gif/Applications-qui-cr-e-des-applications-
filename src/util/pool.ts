/**
 * Pool de concurrence sans dependance. `limit <= 0` => illimite.
 * Utilise pour paralleliser la generation de fichiers : c'est le principal
 * levier de performance de Forge.
 */
export class Pool {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  readonly limit: number;

  constructor(limit: number) {
    this.limit = limit > 0 ? limit : Number.POSITIVE_INFINITY;
  }

  get pending(): number {
    return this.waiters.length;
  }

  get running(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }

  /** map parallele bornee, conserve l'ordre des resultats. */
  async map<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    return Promise.all(items.map((item, i) => this.run(() => fn(item, i))));
  }

  /** Comme `map` mais ne rejette jamais : renvoie un resultat par element. */
  async settle<T, R>(
    items: readonly T[],
    fn: (item: T, index: number) => Promise<R>,
  ): Promise<Array<{ ok: true; value: R } | { ok: false; error: Error }>> {
    return Promise.all(
      items.map((item, i) =>
        this.run(async () => {
          try {
            return { ok: true as const, value: await fn(item, i) };
          } catch (error) {
            return { ok: false as const, error: error instanceof Error ? error : new Error(String(error)) };
          }
        }),
      ),
    );
  }
}

/** Semaphore simple, utile pour limiter les appels par fournisseur. */
export class Semaphore {
  private readonly pool: Pool;
  constructor(limit: number) {
    this.pool = new Pool(limit);
  }
  acquire<T>(fn: () => Promise<T>): Promise<T> {
    return this.pool.run(fn);
  }
}
