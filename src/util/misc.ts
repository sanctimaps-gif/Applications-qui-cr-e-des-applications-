import crypto from 'node:crypto';

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function shortId(bytes = 6): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function slugify(input: string, fallback = 'app'): string {
  const slug = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Backoff exponentiel avec jitter complet, borne a 30 s. */
export function backoffDelay(attempt: number, base = 500, cap = 30_000): number {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.round(Math.random() * exp);
}

export function truncate(text: string, maxChars: number, marker = '\n... [tronque] ...\n'): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

/** Estimation de tokens suffisante pour du budget/telemetrie (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
