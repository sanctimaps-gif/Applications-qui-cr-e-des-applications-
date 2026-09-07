import { EventEmitter } from 'node:events';

export type ForgeEvent =
  | { type: 'phase'; phase: string; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error' | 'debug'; message: string }
  | { type: 'plan'; files: number; stack: string; name: string }
  | { type: 'file:start'; path: string; index: number; total: number }
  | { type: 'file:done'; path: string; bytes: number; ms: number; index: number; total: number }
  | { type: 'file:error'; path: string; error: string }
  | { type: 'llm'; provider: string; model: string; ms: number; inputTokens: number; outputTokens: number; cached: boolean }
  | { type: 'command'; command: string; code: number; ms: number; output: string }
  | { type: 'repair'; attempt: number; reason: string }
  | { type: 'github'; action: string; url?: string }
  | { type: 'done'; projectDir: string; files: number; ms: number; repoUrl?: string }
  | { type: 'error'; message: string };

export type ForgeEventEnvelope = ForgeEvent & { at: number };

/** Bus d'evenements type, consomme par la CLI, le serveur (SSE) et les tests. */
export class EventBus extends EventEmitter {
  private readonly history: ForgeEventEnvelope[] = [];
  private readonly historyLimit: number;

  constructor(historyLimit = 5000) {
    super();
    this.setMaxListeners(0);
    this.historyLimit = historyLimit;
  }

  emitEvent(event: ForgeEvent): void {
    const envelope: ForgeEventEnvelope = { ...event, at: Date.now() };
    this.history.push(envelope);
    if (this.history.length > this.historyLimit) this.history.shift();
    this.emit('event', envelope);
  }

  onEvent(listener: (event: ForgeEventEnvelope) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  replay(): ForgeEventEnvelope[] {
    return [...this.history];
  }

  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void {
    this.emitEvent({ type: 'log', level, message });
  }
}
