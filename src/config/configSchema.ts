import type { DomainName } from "../constants.ts";
import { ALL_DOMAINS, DEFAULT_INDEX_DIR } from "../constants.ts";

export interface Config {
  config_version: number;
  domains: { enabled: DomainName[] };
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

export type ValueType = "number" | "string" | "string[]" | "domain[]";

export interface SchemaEntry {
  /** Dotted path into Config, e.g. "domains.enabled". */
  path: string;
  type: ValueType;
  default: unknown;
  envVar?: string;
  /** Validate parsed value beyond type. Return an error message or null. */
  extra?: (v: unknown) => string | null;
}

export const CONFIG_SCHEMA: SchemaEntry[] = [
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
    default: 5000,
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
export function isKnownPath(path: string): boolean {
  return SCHEMA_PATHS.has(path);
}

export function isKnownSection(section: string): boolean {
  return SCHEMA_SECTIONS.has(section);
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
