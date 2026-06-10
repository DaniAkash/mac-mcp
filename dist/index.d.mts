import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Database } from "bun:sqlite";
import { ZodRawShape } from "zod";

//#region src/constants.d.ts
declare const MAC_MCP_HOME: string;
declare const ALL_DOMAINS: readonly [
  "mail",
  "notes",
  "calendar",
  "reminders",
  "contacts",
  "messages",
  "spotlight",
];
type DomainName = (typeof ALL_DOMAINS)[number];
declare const SERVER_NAME = "mac-mcp";
//#endregion
//#region src/config/configSchema.d.ts
interface Config {
  config_version: number;
  domains: {
    enabled: DomainName[];
  };
  index: {
    path: string;
    staleness_hours: number;
  };
  mail: {
    max_emails_per_mailbox: number;
    exclude_mailboxes: string[];
    default_account: string;
    default_mailbox: string;
    sync_interval_seconds: number;
  };
}
declare class ConfigError extends Error {
  constructor(message: string);
}
//#endregion
//#region src/config/config.d.ts
interface LoadOptions {
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
declare function loadConfig(opts?: LoadOptions): Config;
//#endregion
//#region src/jxa/executor.d.ts
declare class JxaError extends Error {
  readonly preview?: string | undefined;
  constructor(message: string, preview?: string);
}
declare class JxaTimeoutError extends JxaError {
  constructor(ms: number);
}
interface RunOpts {
  /** Per-call timeout in ms. Default 120s. */
  timeoutMs?: number;
  /**
   * Raw JXA helper scripts (e.g. the MAIL_CORE constant) prepended to
   * `script` before invocation. Passed by content, not by name, so the
   * bundler always includes them. Callers import the core constants
   * from `src/jxa/cores/` directly.
   */
  cores?: string[];
}
/**
 * Run a JXA script via `osascript -l JavaScript`. The combined script is
 * (selected cores ++ user script). Stdout is parsed as JSON; parse failures
 * surface a truncated preview to help debugging without leaking secrets.
 */
declare function runJxa<T = unknown>(script: string, opts?: RunOpts): Promise<T>;
//#endregion
//#region src/jxa/cores/mailCore.d.ts
/**
 * JXA core injected before every Mail-domain script. Defines a global
 * `MailCore` with helpers for the things mac-mcp's mail tools need:
 * - listing accounts and mailboxes
 * - resolving an account by display name (fallback to the first account)
 * - resolving a mailbox by name, with an alias map for the cross-provider
 *   naming chaos (Sent vs Sent Items vs Sent Messages vs Sent Mail, etc.)
 * - batchFetch: pulls N properties for an array of messages with one IPC
 *   round trip per property, rather than N x P round trips
 *
 * Every helper is READ-ONLY. Adding a write call here trips the JXA regex
 * sweep in tests/unit/readOnly.test.ts.
 *
 * Exported as a string constant rather than a separate .js file so the
 * bundler includes it in dist; loading via fs.readFileSync at runtime
 * broke `bunx -y github:...` consumers because cores/*.js was not
 * reachable from the bundle entry.
 */
declare const MAIL_CORE =
  '\nconst Mail = Application("Mail");\n\nconst MAILBOX_ALIASES = {\n  Inbox: ["INBOX", "Inbox"],\n  Sent: ["Sent", "Sent Items", "Sent Messages", "Sent Mail"],\n  Drafts: ["Drafts", "Draft"],\n  Trash: ["Trash", "Deleted Items", "Deleted Messages", "Bin"],\n  Junk: ["Junk", "Junk Email", "Spam", "Bulk Mail"],\n  Archive: ["Archive", "All Mail", "[Gmail]/All Mail"],\n};\n\nfunction findAccountByName(name) {\n  const accounts = Mail.accounts();\n  if (!name) return accounts[0];\n  for (const a of accounts) {\n    try {\n      if (a.name() === name) return a;\n    } catch {}\n  }\n  const lower = name.toLowerCase();\n  for (const a of accounts) {\n    try {\n      if (a.name().toLowerCase() === lower) return a;\n    } catch {}\n  }\n  return null;\n}\n\nfunction findMailboxByName(account, name) {\n  if (!account) return null;\n  if (!name) return null;\n  const boxes = account.mailboxes();\n  for (const m of boxes) {\n    try {\n      if (m.name() === name) return m;\n    } catch {}\n  }\n  let candidates = [name];\n  for (const canonical of Object.keys(MAILBOX_ALIASES)) {\n    const group = MAILBOX_ALIASES[canonical];\n    if (group.indexOf(name) !== -1 || canonical === name) {\n      candidates = group;\n      break;\n    }\n  }\n  for (const c of candidates) {\n    for (const m of boxes) {\n      try {\n        if (m.name() === c) return m;\n      } catch {}\n    }\n  }\n  const lower = name.toLowerCase();\n  for (const m of boxes) {\n    try {\n      if (m.name().toLowerCase() === lower) return m;\n    } catch {}\n  }\n  return null;\n}\n\nglobalThis.MailCore = {\n  listAccounts() {\n    const result = [];\n    const accounts = Mail.accounts();\n    for (const a of accounts) {\n      try {\n        result.push({ name: a.name(), id: a.id() });\n      } catch {}\n    }\n    return result;\n  },\n\n  listMailboxes(accountName) {\n    const account = findAccountByName(accountName);\n    if (!account) return [];\n    const result = [];\n    const boxes = account.mailboxes();\n    for (const m of boxes) {\n      try {\n        result.push({ name: m.name(), unreadCount: m.unreadCount() });\n      } catch {}\n    }\n    return result;\n  },\n\n  getAccount: findAccountByName,\n  getMailbox: findMailboxByName,\n\n  batchFetch(messages, props) {\n    const result = {};\n    for (const p of props) {\n      try {\n        result[p] = messages[p]();\n      } catch {\n        result[p] = [];\n      }\n    }\n    return result;\n  },\n};\n';
//#endregion
//#region src/server/readOnly.d.ts
/**
 * Guard for any future write tool. v0.1 never calls this because no write
 * tools exist; the function is kept so a future write-prefixed tool can
 * import and call it as its first line. Two test sweeps (`AST` + JXA-template
 * regex) enforce the invariant from the outside.
 */
declare class ReadOnlyError extends Error {
  constructor();
}
declare function ensureWritable(): void;
//#endregion
//#region src/types.d.ts
interface ToolModule {
  name: string;
  description: string;
  inputShape: ZodRawShape;
  domain: DomainName;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}
interface ResourceModule {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: () => Promise<unknown>;
}
interface DomainIndexStatus {
  available: boolean;
  reason?: string;
  [key: string]: unknown;
}
interface DomainPlugin {
  name: DomainName;
  tools: ToolModule[];
  resources?: ResourceModule[];
  /** Snapshot of the domain's local index health for index://status. */
  getIndexStatus?: () => Promise<DomainIndexStatus>;
}
//#endregion
//#region src/server/registry.d.ts
interface Registry {
  plugins: DomainPlugin[];
  toolNames: string[];
  resourceUris: string[];
}
//#endregion
//#region src/server/server.d.ts
interface CreatedServer {
  server: McpServer;
  registry: Registry;
}
declare function createServer(config: Config, version: string): Promise<CreatedServer>;
declare function startStdioServer(config: Config, version: string): Promise<void>;
//#endregion
//#region src/utils/logger.d.ts
type Level = "debug" | "info" | "warn" | "error";
declare function isLogLevel(v: unknown): v is Level;
/**
 * Parse a string into a Level, returning "info" for anything unrecognised.
 * Exported so the env-var path and tests share the same coercion.
 */
declare function parseLogLevel(v: string | undefined): Level;
declare function setLogLevel(level: Level): void;
declare function getLogLevel(): Level;
//#endregion
//#region src/utils/paths.d.ts
/**
 * Reject paths that escape the expected root. Both sides are passed through
 * realpathSync when they exist so a symlink that points outside the root
 * cannot smuggle an attacker-controlled path through. For non-existent
 * paths (test fixtures, paths about to be created) we fall back to
 * `resolve()` which still normalises `..` traversal.
 */
declare function isWithin(candidate: string, root: string): boolean;
//#endregion
//#region src/utils/sqlite.d.ts
interface ConnectionOpts {
  /** Create the file (and its parent directory) if missing. Default true. */
  create?: boolean;
  /** Override pragma values. */
  pragmas?: Partial<Pragmas>;
}
interface Pragmas {
  journal_mode: string;
  synchronous: string;
  busy_timeout: number;
  foreign_keys: string;
}
declare const DEFAULT_PRAGMAS: Pragmas;
/**
 * Open a writable SQLite connection for an index DB we own. Applies the
 * project-wide pragma defaults so behaviour does not drift across modules.
 */
declare function createConnection(path: string, opts?: ConnectionOpts): Database;
/**
 * Open a read-only handle to a SQLite file we do NOT own (Apple's Envelope
 * Index, chat.db, etc.). `immutable=1` skips locking so we can read even while
 * the owning app holds a write lock.
 */
declare function createReadOnlyConnection(path: string): Database;
//#endregion
//#region src/utils/timeout.d.ts
declare class TimeoutError extends Error {
  constructor(ms: number, label?: string);
}
/**
 * Race a promise against a timeout. Throws `TimeoutError` if the timeout fires first.
 */
declare function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T>;
//#endregion
export {
  ALL_DOMAINS,
  type Config,
  ConfigError,
  DEFAULT_PRAGMAS,
  type DomainName,
  type DomainPlugin,
  JxaError,
  JxaTimeoutError,
  MAC_MCP_HOME,
  MAIL_CORE,
  ReadOnlyError,
  type ResourceModule,
  SERVER_NAME,
  TimeoutError,
  type ToolModule,
  createConnection,
  createReadOnlyConnection,
  createServer,
  ensureWritable,
  getLogLevel,
  isLogLevel,
  isWithin,
  loadConfig,
  parseLogLevel,
  runJxa,
  setLogLevel,
  startStdioServer,
  withTimeout,
};
