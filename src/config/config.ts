import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { ALL_DOMAINS, DEFAULT_CONFIG_PATH, type DomainName } from "../constants.ts";
import { expandTilde } from "../utils/paths.ts";
import {
  CONFIG_SCHEMA,
  type Config,
  ConfigError,
  isKnownPath,
  isKnownSection,
} from "./configSchema.ts";

export type { Config };
export { ConfigError };

export interface LoadOptions {
  configPath?: string;
  /** Skip reading TOML; useful for tests. */
  skipFile?: boolean;
  /** Skip reading env vars; useful for tests. */
  skipEnv?: boolean;
  /** CLI overrides keyed by dotted schema path. Win over env + TOML. */
  cliOverrides?: Record<string, unknown>;
}

/**
 * Load configuration in precedence order: CLI > env > TOML > built-in default.
 * Throws ConfigError on validation failure.
 */
export function loadConfig(opts: LoadOptions = {}): Config {
  const fromFile = opts.skipFile ? {} : readFromFile(opts.configPath ?? DEFAULT_CONFIG_PATH);
  const fromEnv = opts.skipEnv ? {} : readFromEnv();
  const fromCli = opts.cliOverrides ?? {};

  const out: Record<string, unknown> = {};
  for (const entry of CONFIG_SCHEMA) {
    const raw =
      fromCli[entry.path] ?? fromEnv[entry.path] ?? getPath(fromFile, entry.path) ?? entry.default;
    const parsed = coerce(entry.path, raw, entry.type);
    if (entry.extra) {
      const err = entry.extra(parsed);
      if (err) throw new ConfigError(`${entry.path}: ${err}`);
    }
    setPath(out, entry.path, parsed);
  }
  const out2 = out as unknown as Config;
  out2.index.path = expandTilde(out2.index.path);
  return out2;
}

function readFromFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`cannot read config file ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (e) {
    throw new ConfigError(`cannot parse ${path}: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ConfigError(`${path}: expected a table at top level`);
  }
  validateNoUnknownKeys(parsed as Record<string, unknown>);
  return parsed as Record<string, unknown>;
}

function readFromEnv(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of CONFIG_SCHEMA) {
    if (!entry.envVar) continue;
    const v = process.env[entry.envVar];
    if (v === undefined) continue;
    out[entry.path] = v;
  }
  return out;
}

function validateNoUnknownKeys(obj: Record<string, unknown>): void {
  for (const [section, val] of Object.entries(obj)) {
    if (typeof val !== "object" || val === null) {
      if (!isKnownPath(section)) {
        throw new ConfigError(`unknown top-level key: ${section}`);
      }
      continue;
    }
    if (!isKnownSection(section)) {
      throw new ConfigError(`unknown section: [${section}]`);
    }
    for (const key of Object.keys(val as Record<string, unknown>)) {
      const path = `${section}.${key}`;
      if (!isKnownPath(path)) {
        throw new ConfigError(`unknown key: ${path}`);
      }
    }
  }
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === undefined || cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (p === undefined) continue;
    if (typeof cur[p] !== "object" || cur[p] === null) {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) cur[last] = value;
}

function coerce(path: string, raw: unknown, type: string): unknown {
  if (raw === undefined) {
    throw new ConfigError(`${path}: missing value (no default)`);
  }
  switch (type) {
    case "number": {
      if (typeof raw === "boolean") {
        throw new ConfigError(`${path}: expected number, got bool`);
      }
      const n = typeof raw === "string" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isFinite(n)) {
        throw new ConfigError(`${path}: expected number, got ${typeof raw}`);
      }
      return n;
    }
    case "string": {
      if (typeof raw === "string") return raw;
      throw new ConfigError(`${path}: expected string, got ${typeof raw}`);
    }
    case "string[]": {
      if (Array.isArray(raw)) {
        for (const v of raw) {
          if (typeof v !== "string") {
            throw new ConfigError(`${path}: expected array of strings, got ${typeof v}`);
          }
        }
        return raw.slice();
      }
      if (typeof raw === "string") {
        if (raw === "") return [];
        return raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }
      throw new ConfigError(`${path}: expected array of strings`);
    }
    case "domain[]": {
      const arr = coerce(path, raw, "string[]") as string[];
      for (const d of arr) {
        if (!ALL_DOMAINS.includes(d as DomainName)) {
          throw new ConfigError(`${path}: unknown domain "${d}". valid: ${ALL_DOMAINS.join(", ")}`);
        }
      }
      return arr as DomainName[];
    }
    default:
      throw new ConfigError(`${path}: unsupported type ${type}`);
  }
}
