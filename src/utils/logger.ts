export type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function isLogLevel(v: unknown): v is Level {
  return v === "debug" || v === "info" || v === "warn" || v === "error";
}

/**
 * Parse a string into a Level, returning "info" for anything unrecognised.
 * Exported so the env-var path and tests share the same coercion.
 */
export function parseLogLevel(v: string | undefined): Level {
  return isLogLevel(v) ? v : "info";
}

let currentLevel: Level = parseLogLevel(process.env.MAC_MCP_LOG_LEVEL);

// Surface a warning if the env var was set but unrecognised. We use stderr
// directly (not the logger) because the logger filter has just been resolved
// to the fallback level and we want this to always print.
if (process.env.MAC_MCP_LOG_LEVEL !== undefined && !isLogLevel(process.env.MAC_MCP_LOG_LEVEL)) {
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      msg: "invalid MAC_MCP_LOG_LEVEL, falling back to info",
      value: process.env.MAC_MCP_LOG_LEVEL,
    })}\n`,
  );
}

export function setLogLevel(level: Level): void {
  currentLevel = level;
}

export function getLogLevel(): Level {
  return currentLevel;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
