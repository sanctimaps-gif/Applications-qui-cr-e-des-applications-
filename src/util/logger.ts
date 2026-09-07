import type { LogLevel } from '../config.js';

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const useColor = process.stdout.isTTY && !process.env['NO_COLOR'];
const ESC = '';
const paint = (code: string, text: string) =>
  useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text;

export const color = {
  dim: (t: string) => paint('2', t),
  bold: (t: string) => paint('1', t),
  red: (t: string) => paint('31', t),
  green: (t: string) => paint('32', t),
  yellow: (t: string) => paint('33', t),
  blue: (t: string) => paint('34', t),
  magenta: (t: string) => paint('35', t),
  cyan: (t: string) => paint('36', t),
};

export class Logger {
  constructor(private level: LogLevel = 'info') {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private enabled(level: Exclude<LogLevel, 'silent'>): boolean {
    return ORDER[this.level] >= ORDER[level];
  }

  error(msg: string): void {
    if (this.enabled('error')) process.stderr.write(`${color.red('✖')} ${msg}\n`);
  }
  warn(msg: string): void {
    if (this.enabled('warn')) process.stderr.write(`${color.yellow('!')} ${msg}\n`);
  }
  info(msg: string): void {
    if (this.enabled('info')) process.stdout.write(`${msg}\n`);
  }
  step(msg: string): void {
    if (this.enabled('info')) process.stdout.write(`${color.cyan('▸')} ${msg}\n`);
  }
  success(msg: string): void {
    if (this.enabled('info')) process.stdout.write(`${color.green('✔')} ${msg}\n`);
  }
  debug(msg: string): void {
    if (this.enabled('debug')) process.stdout.write(`${color.dim(`· ${msg}`)}\n`);
  }
}
