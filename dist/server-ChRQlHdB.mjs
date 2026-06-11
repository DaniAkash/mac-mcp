import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { parse } from "smol-toml";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
//#region src/constants.ts
const MAC_MCP_HOME = process.env.MAC_MCP_HOME ?? join(homedir(), ".mac-mcp");
const DEFAULT_INDEX_DIR = MAC_MCP_HOME;
const DEFAULT_CONFIG_PATH = join(MAC_MCP_HOME, "config.toml");
const DEFAULT_JXA_TIMEOUT_MS = 12e4;
const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5e3;
const ALL_DOMAINS = ["mail", "notes", "calendar", "reminders", "contacts", "messages", "spotlight"];
const SERVER_NAME = "mac-mcp";
//#endregion
//#region src/utils/paths.ts
const MAIL_ROOT = `${homedir()}/Library/Mail`;
/**
 * Find the highest-versioned Mail.app storage directory, e.g. V10, V11.
 * Returns null if Mail.app has never run or Full Disk Access is missing.
 */
function detectMailDir() {
  if (!existsSync(MAIL_ROOT)) return null;
  let entries;
  try {
    entries = readdirSync(MAIL_ROOT);
  } catch {
    return null;
  }
  const versions = [];
  for (const entry of entries) {
    const match = entry.match(/^V(\d+)$/);
    if (!match) continue;
    const version = Number(match[1]);
    if (!Number.isFinite(version)) continue;
    versions.push({
      version,
      path: `${MAIL_ROOT}/${entry}`,
    });
  }
  if (versions.length === 0) return null;
  versions.sort((a, b) => b.version - a.version);
  return versions[0] ?? null;
}
/**
 * Best-effort symlink-aware resolve. When the path exists, this calls
 * realpathSync so symlinks are followed. When the path does not exist (e.g.
 * test fixtures, or callers checking a path before creating it), it falls
 * back to plain `resolve()` which still handles `..` traversal normalisation.
 */
function safeRealpath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}
/**
 * Reject paths that escape the expected root. Both sides are passed through
 * realpathSync when they exist so a symlink that points outside the root
 * cannot smuggle an attacker-controlled path through. For non-existent
 * paths (test fixtures, paths about to be created) we fall back to
 * `resolve()` which still normalises `..` traversal.
 */
function isWithin(candidate, root) {
  const r1 = safeRealpath(candidate);
  const r2 = safeRealpath(root);
  if (r1 === r2) return true;
  return r1.startsWith(`${r2}/`);
}
function expandTilde(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return `${homedir()}${path.slice(1)}`;
  return path;
}
//#endregion
//#region src/config/configSchema.ts
const CONFIG_SCHEMA = [
  {
    path: "config_version",
    type: "number",
    default: 1,
    extra: (v) => (v === 1 ? null : `unsupported config_version ${String(v)}`),
  },
  {
    path: "domains.enabled",
    type: "domain[]",
    default: ALL_DOMAINS.slice(),
    envVar: "MAC_MCP_DOMAINS_ENABLED",
  },
  {
    path: "index.path",
    type: "string",
    default: DEFAULT_INDEX_DIR,
    envVar: "MAC_MCP_INDEX_PATH",
  },
  {
    path: "index.staleness_hours",
    type: "number",
    default: 24,
    envVar: "MAC_MCP_INDEX_STALENESS_HOURS",
    extra: (v) => (typeof v === "number" && v >= 0 ? null : "must be >= 0"),
  },
  {
    path: "mail.max_emails_per_mailbox",
    type: "number",
    default: 5e3,
    envVar: "MAC_MCP_MAIL_MAX_EMAILS_PER_MAILBOX",
    extra: (v) => (typeof v === "number" && v >= 0 ? null : "must be >= 0"),
  },
  {
    path: "mail.exclude_mailboxes",
    type: "string[]",
    default: ["Drafts"],
    envVar: "MAC_MCP_MAIL_EXCLUDE_MAILBOXES",
  },
  {
    path: "mail.default_account",
    type: "string",
    default: "",
    envVar: "MAC_MCP_MAIL_DEFAULT_ACCOUNT",
  },
  {
    path: "mail.default_mailbox",
    type: "string",
    default: "",
    envVar: "MAC_MCP_MAIL_DEFAULT_MAILBOX",
  },
  {
    path: "mail.sync_interval_seconds",
    type: "number",
    default: 300,
    envVar: "MAC_MCP_MAIL_SYNC_INTERVAL_SECONDS",
    extra: (v) => (typeof v === "number" && v >= 30 ? null : "must be >= 30"),
  },
];
const SCHEMA_PATHS = new Set(CONFIG_SCHEMA.map((e) => e.path));
const SCHEMA_SECTIONS = new Set(
  CONFIG_SCHEMA.map((e) => e.path.split("."))
    .filter((p) => p.length > 1)
    .map((p) => p[0]),
);
/**
 * Return true if a given dotted path is known to the schema. Used for typo
 * protection during TOML load.
 */
function isKnownPath(path) {
  return SCHEMA_PATHS.has(path);
}
function isKnownSection(section) {
  return SCHEMA_SECTIONS.has(section);
}
var ConfigError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
};
//#endregion
//#region src/config/config.ts
/**
 * Load configuration in precedence order: CLI > env > TOML > built-in default.
 * Throws ConfigError on validation failure.
 */
function loadConfig(opts = {}) {
  const fromFile = opts.skipFile ? {} : readFromFile(opts.configPath ?? DEFAULT_CONFIG_PATH);
  const fromEnv = opts.skipEnv ? {} : readFromEnv();
  const fromCli = opts.cliOverrides ?? {};
  const out = {};
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
  const out2 = out;
  out2.index.path = expandTilde(out2.index.path);
  return out2;
}
function readFromFile(path) {
  if (!existsSync(path)) return {};
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`cannot read config file ${path}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = parse(raw);
  } catch (e) {
    throw new ConfigError(`cannot parse ${path}: ${e.message}`);
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new ConfigError(`${path}: expected a table at top level`);
  validateNoUnknownKeys(parsed);
  return parsed;
}
function readFromEnv() {
  const out = {};
  for (const entry of CONFIG_SCHEMA) {
    if (!entry.envVar) continue;
    const v = process.env[entry.envVar];
    if (v === void 0) continue;
    out[entry.path] = v;
  }
  return out;
}
function validateNoUnknownKeys(obj) {
  for (const [section, val] of Object.entries(obj)) {
    if (typeof val !== "object" || val === null) {
      if (!isKnownPath(section)) throw new ConfigError(`unknown top-level key: ${section}`);
      continue;
    }
    if (!isKnownSection(section)) throw new ConfigError(`unknown section: [${section}]`);
    for (const key of Object.keys(val)) {
      const path = `${section}.${key}`;
      if (!isKnownPath(path)) throw new ConfigError(`unknown key: ${path}`);
    }
  }
}
function getPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur === void 0 || cur === null || typeof cur !== "object") return void 0;
    cur = cur[p];
  }
  return cur;
}
function setPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (p === void 0) continue;
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (last !== void 0) cur[last] = value;
}
function coerce(path, raw, type) {
  if (raw === void 0) throw new ConfigError(`${path}: missing value (no default)`);
  switch (type) {
    case "number": {
      if (typeof raw === "boolean") throw new ConfigError(`${path}: expected number, got bool`);
      const n = typeof raw === "string" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isFinite(n))
        throw new ConfigError(`${path}: expected number, got ${typeof raw}`);
      return n;
    }
    case "string":
      if (typeof raw === "string") return raw;
      throw new ConfigError(`${path}: expected string, got ${typeof raw}`);
    case "string[]":
      if (Array.isArray(raw)) {
        for (const v of raw)
          if (typeof v !== "string")
            throw new ConfigError(`${path}: expected array of strings, got ${typeof v}`);
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
    case "domain[]": {
      const arr = coerce(path, raw, "string[]");
      for (const d of arr)
        if (!ALL_DOMAINS.includes(d))
          throw new ConfigError(`${path}: unknown domain "${d}". valid: ${ALL_DOMAINS.join(", ")}`);
      return arr;
    }
    default:
      throw new ConfigError(`${path}: unsupported type ${type}`);
  }
}
//#endregion
//#region src/utils/json.ts
const DEFAULT_MAX_LEN = 500;
/**
 * JSON.stringify with a length cap and unprintable-binary safety. Useful for
 * log lines that quote external program output (osascript stderr, parser
 * payloads, etc.) where the full text could be enormous.
 */
function safeStringify(value, maxLen = DEFAULT_MAX_LEN) {
  let s;
  try {
    s = JSON.stringify(value, replacer);
  } catch (e) {
    s = `[unserialisable: ${e.message}]`;
  }
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}...[truncated ${s.length - maxLen}b]`;
}
function replacer(_key, value) {
  if (value instanceof Error)
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  if (typeof value === "bigint") return value.toString();
  return value;
}
//#endregion
//#region src/server/readOnly.ts
/**
 * Guard for any future write tool. v0.1 never calls this because no write
 * tools exist; the function is kept so a future write-prefixed tool can
 * import and call it as its first line. Two test sweeps (`AST` + JXA-template
 * regex) enforce the invariant from the outside.
 */
var ReadOnlyError = class extends Error {
  constructor() {
    super("mac-mcp is read-only. Write operations are disabled by design.");
    this.name = "ReadOnlyError";
  }
};
function ensureWritable() {
  throw new ReadOnlyError();
}
/** The list of name prefixes that mark a tool as performing a write. */
const WRITE_TOOL_PREFIXES = [
  "send_",
  "delete_",
  "move_",
  "mark_",
  "create_",
  "update_",
  "save_",
  "set_",
];
function isWriteToolName(name) {
  for (const p of WRITE_TOOL_PREFIXES) {
    if (name.startsWith(p)) return true;
    if (name.includes(`_${p}`)) return true;
  }
  return false;
}
//#endregion
//#region src/utils/logger.ts
const LEVEL_ORDER = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
function isLogLevel(v) {
  return v === "debug" || v === "info" || v === "warn" || v === "error";
}
/**
 * Parse a string into a Level, returning "info" for anything unrecognised.
 * Exported so the env-var path and tests share the same coercion.
 */
function parseLogLevel(v) {
  return isLogLevel(v) ? v : "info";
}
let currentLevel = parseLogLevel(process.env.MAC_MCP_LOG_LEVEL);
if (process.env.MAC_MCP_LOG_LEVEL !== void 0 && !isLogLevel(process.env.MAC_MCP_LOG_LEVEL))
  process.stderr.write(
    `${JSON.stringify({
      ts: /* @__PURE__ */ new Date().toISOString(),
      level: "warn",
      msg: "invalid MAC_MCP_LOG_LEVEL, falling back to info",
      value: process.env.MAC_MCP_LOG_LEVEL,
    })}\n`,
  );
function setLogLevel(level) {
  currentLevel = level;
}
function getLogLevel() {
  return currentLevel;
}
function write(level, msg, fields) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const entry = {
    ts: /* @__PURE__ */ new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}
const logger = {
  debug: (msg, fields) => write("debug", msg, fields),
  info: (msg, fields) => write("info", msg, fields),
  warn: (msg, fields) => write("warn", msg, fields),
  error: (msg, fields) => write("error", msg, fields),
};
//#endregion
//#region src/server/resources/indexStatus.ts
const INDEX_STATUS_URI = "index://status";
/**
 * Collect the per-domain index health snapshot. Plugins without a
 * `getIndexStatus` opt out (returns `{ available: true }`).
 */
async function readIndexStatus(plugins) {
  const out = {};
  for (const p of plugins)
    if (p.getIndexStatus)
      try {
        out[p.name] = await p.getIndexStatus();
      } catch (e) {
        out[p.name] = {
          available: false,
          reason: e.message,
        };
      }
    else out[p.name] = { available: true };
  return out;
}
//#endregion
//#region src/server/registry.ts
/**
 * Static map of domain → loader. Each domain PR adds its entry.
 */
const DOMAIN_LOADERS = {
  mail: async (config) => {
    const { buildMailPlugin } = await import("./plugin-BJcExnKl.mjs");
    return buildMailPlugin(config);
  },
  spotlight: async () => {
    const { buildSpotlightPlugin } = await import("./plugin-DmhAdsU8.mjs");
    return buildSpotlightPlugin();
  },
  contacts: async () => {
    const { buildContactsPlugin } = await import("./plugin-w3YYQIu1.mjs");
    return buildContactsPlugin();
  },
};
async function buildRegistry(server, config) {
  const plugins = [];
  for (const domain of config.domains.enabled) {
    const loader = DOMAIN_LOADERS[domain];
    if (!loader) {
      logger.debug(`domain "${domain}" enabled in config but no plugin loaded yet`, { domain });
      continue;
    }
    try {
      const plugin = await loader(config);
      plugins.push(plugin);
    } catch (e) {
      logger.error(`failed to load domain "${domain}"`, {
        domain,
        error: e.message,
      });
    }
  }
  const toolNames = [];
  for (const plugin of plugins)
    for (const tool of plugin.tools) {
      if (isWriteToolName(tool.name)) {
        logger.error(`refusing to register write-prefixed tool ${tool.name}`);
        continue;
      }
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputShape,
        },
        async (args) => {
          const result = await tool.handler(args);
          return {
            content: [
              {
                type: "text",
                text: typeof result === "string" ? result : safeStringify(result, 1e6),
              },
            ],
          };
        },
      );
      toolNames.push(tool.name);
    }
  const resourceUris = [];
  server.registerResource(
    "index-status",
    INDEX_STATUS_URI,
    {
      description: "Per-domain index health snapshot",
      mimeType: "application/json",
    },
    async () => {
      const data = await readIndexStatus(plugins);
      return {
        contents: [
          {
            uri: INDEX_STATUS_URI,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );
  resourceUris.push(INDEX_STATUS_URI);
  for (const plugin of plugins)
    for (const resource of plugin.resources ?? []) {
      server.registerResource(
        resource.name,
        resource.uri,
        {
          description: resource.description,
          mimeType: resource.mimeType,
        },
        async () => {
          const data = await resource.read();
          return {
            contents: [
              {
                uri: resource.uri,
                mimeType: resource.mimeType,
                text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
              },
            ],
          };
        },
      );
      resourceUris.push(resource.uri);
    }
  return {
    plugins,
    toolNames,
    resourceUris,
  };
}
//#endregion
//#region src/server/server.ts
async function createServer(config, version) {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );
  return {
    server,
    registry: await buildRegistry(server, config),
  };
}
async function startStdioServer(config, version) {
  const { server, registry } = await createServer(config, version);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`${SERVER_NAME} v${version} listening`, {
    domains: registry.plugins.map((p) => p.name),
    tools: registry.toolNames.length,
    resources: registry.resourceUris.length,
  });
}
//#endregion
export {
  SERVER_NAME as S,
  DEFAULT_CONFIG_PATH as _,
  isLogLevel as a,
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS as b,
  setLogLevel as c,
  safeStringify as d,
  loadConfig as f,
  ALL_DOMAINS as g,
  isWithin as h,
  getLogLevel as i,
  ReadOnlyError as l,
  detectMailDir as m,
  startStdioServer as n,
  logger as o,
  ConfigError as p,
  readIndexStatus as r,
  parseLogLevel as s,
  createServer as t,
  ensureWritable as u,
  DEFAULT_INDEX_DIR as v,
  MAC_MCP_HOME as x,
  DEFAULT_JXA_TIMEOUT_MS as y,
};
