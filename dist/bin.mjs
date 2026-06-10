#!/usr/bin/env bun
import {
  S as SERVER_NAME,
  _ as DEFAULT_CONFIG_PATH,
  c as setLogLevel,
  f as loadConfig,
  m as detectMailDir,
  n as startStdioServer,
  r as readIndexStatus,
} from "./server-BTVN4ZGR.mjs";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { defineCommand, runCommand, runMain } from "citty";
import { glob } from "node:fs/promises";
//#region src/utils/perms.ts
/**
 * Probe Full Disk Access by attempting to read-open a system-protected SQLite.
 * Mail's `Envelope Index` is the canonical FDA litmus test on modern macOS.
 */
async function checkFullDiskAccess() {
  const mailDir = detectMailDir();
  if (!mailDir)
    return {
      name: "Full Disk Access",
      passed: false,
      detail: "Mail data directory not found (Mail.app may not have run).",
      fix: "Open Mail.app once to initialise its storage, then re-run.",
    };
  const target = (await Array.fromAsync(glob(`${mailDir.path}/MailData/Envelope Index*`))).find(
    (p) => p.endsWith("Envelope Index"),
  );
  if (!target || !existsSync(target))
    return {
      name: "Full Disk Access",
      passed: false,
      detail: "Envelope Index not present yet.",
      fix: "Open Mail.app and let it finish indexing, then re-run.",
    };
  try {
    const db = new Database(`file:${target}?mode=ro&immutable=1`, { create: false });
    db.query("SELECT 1").get();
    db.close();
    return {
      name: "Full Disk Access",
      passed: true,
    };
  } catch (e) {
    return {
      name: "Full Disk Access",
      passed: false,
      detail: e.message,
      fix: "System Settings > Privacy & Security > Full Disk Access. add your terminal or MCP client.",
    };
  }
}
function checkMacOsVersion() {
  const out = Bun.spawnSync(["sw_vers", "-productVersion"]).stdout.toString().trim();
  if (!out)
    return {
      name: "macOS version",
      passed: false,
      detail: "could not read sw_vers",
    };
  const major = Number(out.split(".")[0]);
  const passed = Number.isFinite(major) && major >= 14;
  return {
    name: "macOS version",
    passed,
    detail: `${out} (Mail categories require 15+)`,
    fix: passed ? void 0 : "macOS 14 or newer is required.",
  };
}
function checkHomeDirWritable() {
  const home = homedir();
  if (!existsSync(home))
    return {
      name: "Home directory writable",
      passed: false,
      detail: `${home} not found`,
    };
  try {
    accessSync(home, constants.W_OK);
    return {
      name: "Home directory writable",
      passed: true,
    };
  } catch {
    return {
      name: "Home directory writable",
      passed: false,
      detail: `${home} exists but is not writable`,
      fix: "Check filesystem permissions on the home directory.",
    };
  }
}
//#endregion
//#region src/cli/commands/doctor.ts
const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Probe macOS permissions and print a status checklist.",
  },
  async run() {
    const checks = [checkHomeDirWritable(), checkMacOsVersion(), await checkFullDiskAccess()];
    let allPass = true;
    for (const c of checks) {
      const mark = c.passed ? "ok  " : "fail";
      process.stdout.write(`[${mark}] ${c.name}\n`);
      if (c.detail) process.stdout.write(`       ${c.detail}\n`);
      if (!c.passed && c.fix) process.stdout.write(`       fix: ${c.fix}\n`);
      if (!c.passed) allPass = false;
    }
    process.exit(allPass ? 0 : 1);
  },
});
//#endregion
//#region src/cli/commands/indexCmd.ts
const indexCommand = defineCommand({
  meta: {
    name: "index",
    description: "Bulk-build domain indexes. No-op in v0.1; implemented in the mail domain PR.",
  },
  args: {
    domain: {
      type: "string",
      description: "Comma-separated list of domains to index. Defaults to all enabled.",
    },
  },
  run() {
    process.stderr.write("no domain indexes are wired up yet; this command is a placeholder.\n");
  },
});
//#endregion
//#region src/config/configTemplate.ts
const CONFIG_TEMPLATE = `# mac-mcp configuration
# All keys are optional. Anything not set falls back to a built-in default.
# Every key has a matching environment variable prefixed with MAC_MCP_.
# Resolution order: CLI flag > env var > this file > default.

config_version = 1

[domains]
# Which domains to expose. Disable a domain to skip its tool registration
# AND its index build. Removing a domain here is the only way to avoid
# prompting the user for the matching macOS permission.
# enabled = ["mail", "notes", "calendar", "reminders", "contacts", "messages", "spotlight"]
# env: MAC_MCP_DOMAINS_ENABLED (comma-separated)

[index]
# Where per-domain SQLite indexes live. The directory is created 0o700 on first use.
# path = "~/.mac-mcp"
# env: MAC_MCP_INDEX_PATH

# Number of hours since last sync before status surfaces a "stale" warning.
# staleness_hours = 24
# env: MAC_MCP_INDEX_STALENESS_HOURS

[mail]
# Cap the number of emails ingested per mailbox during a full build.
# Set to 0 for uncapped (use uncapped only if you know your largest mailbox fits).
# max_emails_per_mailbox = 5000
# env: MAC_MCP_MAIL_MAX_EMAILS_PER_MAILBOX

# Mailbox display names to skip entirely. An EMPTY array means "no exclusions",
# not "fall back to default": the default is ["Drafts"].
# exclude_mailboxes = ["Drafts"]
# env: MAC_MCP_MAIL_EXCLUDE_MAILBOXES (comma-separated)

# Account display name used when a tool input does not specify one.
# Empty string means "all accounts".
# default_account = ""
# env: MAC_MCP_MAIL_DEFAULT_ACCOUNT

# Mailbox name used when a tool input does not specify one.
# Empty string means "all mailboxes".
# default_mailbox = ""
# env: MAC_MCP_MAIL_DEFAULT_MAILBOX

# How often (seconds) the server re-syncs the Mail index in the background.
# Minimum 30.
# sync_interval_seconds = 300
# env: MAC_MCP_MAIL_SYNC_INTERVAL_SECONDS
`;
//#endregion
//#region src/cli/commands/init.ts
const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Write the config.toml template to ~/.mac-mcp/config.toml.",
  },
  args: {
    force: {
      type: "boolean",
      description: "Overwrite an existing config file.",
      default: false,
    },
  },
  run({ args }) {
    const path = DEFAULT_CONFIG_PATH;
    if (existsSync(path) && !args.force) {
      process.stderr.write(`${path} already exists. Use --force to overwrite.\n`);
      process.exit(1);
    }
    mkdirSync(dirname(path), {
      recursive: true,
      mode: 448,
    });
    writeFileSync(path, CONFIG_TEMPLATE, {
      encoding: "utf8",
      mode: 384,
    });
    chmodSync(path, 384);
    process.stderr.write(`wrote ${path}\n`);
  },
});
//#endregion
//#region src/cli/commands/rebuild.ts
const rebuildCommand = defineCommand({
  meta: {
    name: "rebuild",
    description: "Delete and rebuild a domain index. (No-op in v0.1.)",
  },
  args: {
    domain: {
      type: "string",
      description: "Domain to rebuild.",
      required: true,
    },
  },
  run() {
    process.stderr.write("no domain indexes are wired up yet; this command is a placeholder.\n");
  },
});
//#endregion
//#region package.json
var version = "0.0.0";
//#endregion
//#region src/cli/version.ts
function getVersion() {
  return version;
}
//#endregion
//#region src/cli/commands/serve.ts
const serveCommand = defineCommand({
  meta: {
    name: "serve",
    description: "Start the MCP server over stdio.",
  },
  args: {
    verbose: {
      type: "boolean",
      description: "Set log level to debug.",
      default: false,
    },
  },
  async run({ args }) {
    if (args.verbose) setLogLevel("debug");
    await startStdioServer(loadConfig(), getVersion());
    await new Promise(() => {});
  },
});
//#endregion
//#region src/cli/commands/status.ts
const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Print per-domain index health as JSON.",
  },
  async run() {
    const config = loadConfig();
    const snapshot = await readIndexStatus([]);
    const out = {
      configuredDomains: config.domains.enabled,
      indexes: snapshot,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  },
});
//#endregion
//#region src/bin.ts
runMain(
  defineCommand({
    meta: {
      name: SERVER_NAME,
      version: getVersion(),
      description: "Read-only MCP server for native macOS apps.",
    },
    subCommands: {
      serve: serveCommand,
      init: initCommand,
      status: statusCommand,
      index: indexCommand,
      rebuild: rebuildCommand,
      doctor: doctorCommand,
    },
    /** No subcommand: treat as `serve` so `bunx mac-mcp` Just Works as the MCP server. */
    async run(ctx) {
      await runCommand(serveCommand, { rawArgs: ctx.rawArgs });
    },
  }),
);
//#endregion
export {};
