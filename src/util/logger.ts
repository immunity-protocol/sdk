/**
 * Tiny namespaced logger. Zero deps. Writes to stderr.
 *
 * Enable specific namespaces via the `IMMUNITY_DEBUG` env var, comma-separated:
 *
 *   IMMUNITY_DEBUG=settlement,cache node my-agent.js
 *
 * `*` enables all. Unset (the default) silences everything below `warn`.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const envFlag = process.env.IMMUNITY_DEBUG ?? "";
const enabled = new Set(
  envFlag
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const allOn = enabled.has("*");

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function shouldLog(ns: string, level: LogLevel): boolean {
  if (level === "warn" || level === "error") return true;
  return allOn || enabled.has(ns);
}

function emit(ns: string, level: LogLevel, args: unknown[]): void {
  if (!shouldLog(ns, level)) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [immunity:${ns}] [${level}]`;
  const line = [prefix, ...args];
  if (level === "error" || level === "warn") {
    console.error(...line);
  } else {
    console.error(...line);
  }
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  child: (suffix: string) => Logger;
}

export function createLogger(namespace: string): Logger {
  const log =
    (level: LogLevel) =>
    (...args: unknown[]) =>
      emit(namespace, level, args);
  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child(suffix: string): Logger {
      return createLogger(`${namespace}:${suffix}`);
    },
  };
}

export function logLevelOrder(level: LogLevel): number {
  return order[level];
}
