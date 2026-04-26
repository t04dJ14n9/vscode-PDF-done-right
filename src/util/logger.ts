import * as vscode from 'vscode';

/**
 * Single OutputChannel for PDF Done Right. Lazy-created on first use.
 * Levels are free-form but filtered by `paperlink.debugLogging`.
 */
class Logger {
  private channel: vscode.OutputChannel | undefined;

  private get debugEnabled(): boolean {
    try {
      return vscode.workspace.getConfiguration('paperlink').get<boolean>('debugLogging', false);
    } catch {
      return false;
    }
  }

  private get ch(): vscode.OutputChannel {
    if (!this.channel) {
      this.channel = vscode.window.createOutputChannel('PDF Done Right');
    }
    return this.channel;
  }

  private stamp(): string {
    return new Date().toISOString();
  }

  info(msg: string, ...args: unknown[]): void {
    this.ch.appendLine(`${this.stamp()} [INFO] ${msg}${formatArgs(args)}`);
  }

  warn(msg: string, ...args: unknown[]): void {
    this.ch.appendLine(`${this.stamp()} [WARN] ${msg}${formatArgs(args)}`);
  }

  error(msg: string, err?: unknown): void {
    const errPart = err === undefined ? '' : ` :: ${formatError(err)}`;
    this.ch.appendLine(`${this.stamp()} [ERR ] ${msg}${errPart}`);
  }

  debug(msg: string, ...args: unknown[]): void {
    if (!this.debugEnabled) return;
    this.ch.appendLine(`${this.stamp()} [DBG ] ${msg}${formatArgs(args)}`);
  }

  dispose(): void {
    this.channel?.dispose();
    this.channel = undefined;
  }
}

function formatArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  return ' ' + args.map(a => (typeof a === 'string' ? a : safeJson(a))).join(' ');
}

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return safeJson(e);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Module-level singleton. Import and use: `log.info(...)`. */
export const log = new Logger();
