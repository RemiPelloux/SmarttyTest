import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const order: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const SECRET_PATTERNS: RegExp[] = [
  /(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /((?:api[_-]?key|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi,
];

/** Redacts likely secrets and the values of sensitive environment variables (spec §30.2). */
export function redact(text: string, extraValues: readonly string[] = []): string {
  let out = text;
  for (const value of extraValues) {
    if (value.length >= 6) out = out.split(value).join("[REDACTED]");
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, prefix: string | undefined, secret: string | undefined) =>
      typeof secret === "string" && typeof prefix === "string"
        ? `${prefix}[REDACTED]`
        : "[REDACTED]",
    );
  }
  return out;
}

function sensitiveEnvValues(): string[] {
  return Object.entries(process.env)
    .filter(
      ([key, value]) =>
        value && /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(key),
    )
    .map(([, value]) => value as string);
}

export interface LogRecord {
  level: Exclude<LogLevel, "silent">;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
  time: string;
}

export type LogSink = (record: LogRecord, formatted: string) => void;

export interface Logger {
  error(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
  readonly level: LogLevel;
}

export interface LoggerOptions {
  level?: LogLevel;
  json?: boolean;
  scope?: string;
  sinks?: LogSink[];
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "warn";
  const scope = options.scope ?? "smarttest";
  const sinks = options.sinks ?? [(_record, formatted) => process.stderr.write(`${formatted}\n`)];
  const secrets = sensitiveEnvValues();
  const emit = (
    lvl: Exclude<LogLevel, "silent">,
    message: string,
    data?: Record<string, unknown>,
  ) => {
    if (order[lvl] > order[level]) return;
    const record: LogRecord = {
      level: lvl,
      scope,
      message: redact(message, secrets),
      time: new Date().toISOString(),
    };
    if (data)
      record.data = JSON.parse(redact(JSON.stringify(data), secrets)) as Record<string, unknown>;
    const formatted = options.json
      ? JSON.stringify(record)
      : `[${lvl}] ${scope}: ${record.message}${record.data ? ` ${JSON.stringify(record.data)}` : ""}`;
    for (const sink of sinks) sink(record, formatted);
  };
  return {
    level,
    error: (m, d) => emit("error", m, d),
    warn: (m, d) => emit("warn", m, d),
    info: (m, d) => emit("info", m, d),
    debug: (m, d) => emit("debug", m, d),
    child: (child) => createLogger({ ...options, level, scope: `${scope}:${child}`, sinks }),
  };
}

/** Appends JSON log lines to a file, rotating to `<file>.1` past `maxBytes`. Never throws. */
export function fileSink(path: string, maxBytes = 1024 * 1024): LogSink {
  // Sync I/O keeps log ordering deterministic and works inside exit paths.
  return (record) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      try {
        if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`);
      } catch {
        /* first write */
      }
      appendFileSync(path, `${JSON.stringify(record)}\n`);
    } catch {
      /* logging must never break a command */
    }
  };
}

export const silentLogger: Logger = createLogger({ level: "silent" });
