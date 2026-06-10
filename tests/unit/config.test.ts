import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../../src/config/config.ts";

let tmp: string;
const ENV_KEYS = [
  "MAC_MCP_DOMAINS_ENABLED",
  "MAC_MCP_INDEX_PATH",
  "MAC_MCP_INDEX_STALENESS_HOURS",
  "MAC_MCP_MAIL_MAX_EMAILS_PER_MAILBOX",
  "MAC_MCP_MAIL_EXCLUDE_MAILBOXES",
  "MAC_MCP_MAIL_DEFAULT_ACCOUNT",
  "MAC_MCP_MAIL_DEFAULT_MAILBOX",
  "MAC_MCP_MAIL_SYNC_INTERVAL_SECONDS",
];
const envBackup = new Map<string, string | undefined>();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mac-mcp-config-"));
  for (const k of ENV_KEYS) {
    envBackup.set(k, process.env[k]);
    delete process.env[k];
  }
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of envBackup) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  envBackup.clear();
});

function writeToml(body: string): string {
  const path = join(tmp, "config.toml");
  writeFileSync(path, body);
  return path;
}

test("returns defaults when nothing is set", () => {
  const cfg = loadConfig({ skipFile: true, skipEnv: true });
  expect(cfg.config_version).toBe(1);
  expect(cfg.domains.enabled).toContain("mail");
  expect(cfg.mail.exclude_mailboxes).toEqual(["Drafts"]);
  expect(cfg.mail.sync_interval_seconds).toBe(300);
});

test("TOML overrides defaults", () => {
  const path = writeToml(`
config_version = 1
[domains]
enabled = ["mail", "notes"]
[mail]
max_emails_per_mailbox = 999
`);
  const cfg = loadConfig({ configPath: path, skipEnv: true });
  expect(cfg.domains.enabled).toEqual(["mail", "notes"]);
  expect(cfg.mail.max_emails_per_mailbox).toBe(999);
});

test("env overrides TOML", () => {
  const path = writeToml(`
[mail]
max_emails_per_mailbox = 100
`);
  process.env.MAC_MCP_MAIL_MAX_EMAILS_PER_MAILBOX = "555";
  const cfg = loadConfig({ configPath: path });
  expect(cfg.mail.max_emails_per_mailbox).toBe(555);
});

test("CLI overrides env", () => {
  process.env.MAC_MCP_MAIL_MAX_EMAILS_PER_MAILBOX = "555";
  const cfg = loadConfig({
    skipFile: true,
    cliOverrides: { "mail.max_emails_per_mailbox": 777 },
  });
  expect(cfg.mail.max_emails_per_mailbox).toBe(777);
});

test("unknown top-level section rejected", () => {
  const path = writeToml(`[bogus]\nfoo = 1\n`);
  expect(() => loadConfig({ configPath: path, skipEnv: true })).toThrow(ConfigError);
});

test("unknown key inside known section rejected", () => {
  const path = writeToml(`[mail]\nnonsense = true\n`);
  expect(() => loadConfig({ configPath: path, skipEnv: true })).toThrow(ConfigError);
});

test("empty exclude_mailboxes array stays empty (no default fallback)", () => {
  const path = writeToml(`[mail]\nexclude_mailboxes = []\n`);
  const cfg = loadConfig({ configPath: path, skipEnv: true });
  expect(cfg.mail.exclude_mailboxes).toEqual([]);
});

test("empty env-var string parses as empty array", () => {
  process.env.MAC_MCP_MAIL_EXCLUDE_MAILBOXES = "";
  const cfg = loadConfig({ skipFile: true });
  expect(cfg.mail.exclude_mailboxes).toEqual([]);
});

test("comma-separated env var parses to array", () => {
  process.env.MAC_MCP_MAIL_EXCLUDE_MAILBOXES = "Drafts, Spam, Junk";
  const cfg = loadConfig({ skipFile: true });
  expect(cfg.mail.exclude_mailboxes).toEqual(["Drafts", "Spam", "Junk"]);
});

test("bool-in-number-slot rejected", () => {
  const path = writeToml(`[mail]\nmax_emails_per_mailbox = true\n`);
  expect(() => loadConfig({ configPath: path, skipEnv: true })).toThrow(ConfigError);
});

test("negative number rejected by extra validator", () => {
  const path = writeToml(`[mail]\nmax_emails_per_mailbox = -1\n`);
  expect(() => loadConfig({ configPath: path, skipEnv: true })).toThrow(ConfigError);
});

test("unknown domain in domains.enabled rejected", () => {
  const path = writeToml(`[domains]\nenabled = ["mail", "bogus"]\n`);
  expect(() => loadConfig({ configPath: path, skipEnv: true })).toThrow(ConfigError);
});

test("missing config file falls back to defaults silently", () => {
  const cfg = loadConfig({ configPath: join(tmp, "does-not-exist.toml"), skipEnv: true });
  expect(cfg.config_version).toBe(1);
});

test("sync_interval_seconds below 30 rejected", () => {
  const path = writeToml(`[mail]\nsync_interval_seconds = 10\n`);
  expect(() => loadConfig({ configPath: path, skipEnv: true })).toThrow(ConfigError);
});
