import { homedir } from "node:os";
import { join } from "node:path";

export const MAC_MCP_HOME = process.env.MAC_MCP_HOME ?? join(homedir(), ".mac-mcp");

export const DEFAULT_INDEX_DIR = MAC_MCP_HOME;
export const DEFAULT_CONFIG_PATH = join(MAC_MCP_HOME, "config.toml");

export const DEFAULT_JXA_TIMEOUT_MS = 120_000;
export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5000;

export const ALL_DOMAINS = [
  "mail",
  "notes",
  "calendar",
  "reminders",
  "contacts",
  "messages",
  "spotlight",
] as const;

export type DomainName = (typeof ALL_DOMAINS)[number];

export const SERVER_NAME = "mac-mcp";
