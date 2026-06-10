import { b as DEFAULT_SQLITE_BUSY_TIMEOUT_MS, d as safeStringify } from "./server-DxrEjUHN.mjs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
//#region src/utils/timeout.ts
var TimeoutError = class extends Error {
  constructor(ms, label) {
    super(label ? `${label} timed out after ${ms}ms` : `timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
};
/**
 * Race a promise against a timeout. Throws `TimeoutError` if the timeout fires first.
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolveFn, rejectFn) => {
    const timer = setTimeout(() => rejectFn(new TimeoutError(ms, label)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolveFn(v);
      },
      (e) => {
        clearTimeout(timer);
        rejectFn(e);
      },
    );
  });
}
//#endregion
//#region src/jxa/executor.ts
var JxaError = class extends Error {
  preview;
  constructor(message, preview) {
    super(message);
    this.preview = preview;
    this.name = "JxaError";
  }
};
var JxaTimeoutError = class extends JxaError {
  constructor(ms) {
    super(`osascript timed out after ${ms}ms`);
    this.name = "JxaTimeoutError";
  }
};
/**
 * Run a JXA script via `osascript -l JavaScript`. The combined script is
 * (selected cores ++ user script). Stdout is parsed as JSON; parse failures
 * surface a truncated preview to help debugging without leaking secrets.
 */
async function runJxa(script, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 12e4;
  const cores = (opts.cores ?? []).join("\n\n");
  const full = cores ? `${cores}\n\n${script}` : script;
  const proc = Bun.spawn(["osascript", "-l", "JavaScript", "-e", full], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await withTimeout(proc.exited, timeoutMs, "osascript");
  } catch (e) {
    proc.kill();
    if (e instanceof TimeoutError) throw new JxaTimeoutError(timeoutMs);
    throw e;
  }
  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new JxaError(`osascript exited ${proc.exitCode}: ${stderr.slice(0, 500)}`, stderr);
  }
  const stdout = (await new Response(proc.stdout).text()).trim();
  if (stdout.length === 0) return void 0;
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new JxaError(
      `failed to parse osascript output as JSON: ${e.message}`,
      safeStringify(stdout, 500),
    );
  }
}
//#endregion
//#region src/jxa/cores/mailCore.ts
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
const MAIL_CORE = `
const Mail = Application("Mail");

const MAILBOX_ALIASES = {
  Inbox: ["INBOX", "Inbox"],
  Sent: ["Sent", "Sent Items", "Sent Messages", "Sent Mail"],
  Drafts: ["Drafts", "Draft"],
  Trash: ["Trash", "Deleted Items", "Deleted Messages", "Bin"],
  Junk: ["Junk", "Junk Email", "Spam", "Bulk Mail"],
  Archive: ["Archive", "All Mail", "[Gmail]/All Mail"],
};

function findAccountByName(name) {
  const accounts = Mail.accounts();
  if (!name) return accounts[0];
  for (const a of accounts) {
    try {
      if (a.name() === name) return a;
    } catch {}
  }
  const lower = name.toLowerCase();
  for (const a of accounts) {
    try {
      if (a.name().toLowerCase() === lower) return a;
    } catch {}
  }
  return null;
}

function findMailboxByName(account, name) {
  if (!account) return null;
  if (!name) return null;
  const boxes = account.mailboxes();
  for (const m of boxes) {
    try {
      if (m.name() === name) return m;
    } catch {}
  }
  let candidates = [name];
  for (const canonical of Object.keys(MAILBOX_ALIASES)) {
    const group = MAILBOX_ALIASES[canonical];
    if (group.indexOf(name) !== -1 || canonical === name) {
      candidates = group;
      break;
    }
  }
  for (const c of candidates) {
    for (const m of boxes) {
      try {
        if (m.name() === c) return m;
      } catch {}
    }
  }
  const lower = name.toLowerCase();
  for (const m of boxes) {
    try {
      if (m.name().toLowerCase() === lower) return m;
    } catch {}
  }
  return null;
}

globalThis.MailCore = {
  listAccounts() {
    const result = [];
    const accounts = Mail.accounts();
    for (const a of accounts) {
      try {
        result.push({ name: a.name(), id: a.id() });
      } catch {}
    }
    return result;
  },

  listMailboxes(accountName) {
    const account = findAccountByName(accountName);
    if (!account) return [];
    const result = [];
    const boxes = account.mailboxes();
    for (const m of boxes) {
      try {
        result.push({ name: m.name(), unreadCount: m.unreadCount() });
      } catch {}
    }
    return result;
  },

  getAccount: findAccountByName,
  getMailbox: findMailboxByName,

  batchFetch(messages, props) {
    const result = {};
    for (const p of props) {
      try {
        result[p] = messages[p]();
      } catch {
        result[p] = [];
      }
    }
    return result;
  },
};
`;
//#endregion
//#region src/utils/sqlite.ts
const DEFAULT_PRAGMAS = {
  journal_mode: "WAL",
  synchronous: "NORMAL",
  busy_timeout: DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  foreign_keys: "ON",
};
/**
 * Open a writable SQLite connection for an index DB we own. Applies the
 * project-wide pragma defaults so behaviour does not drift across modules.
 */
function createConnection(path, opts = {}) {
  const create = opts.create ?? true;
  if (create)
    mkdirSync(dirname(path), {
      recursive: true,
      mode: 448,
    });
  const db = new Database(path, { create });
  applyPragmas(db, {
    ...DEFAULT_PRAGMAS,
    ...opts.pragmas,
  });
  return db;
}
/**
 * Open a read-only handle to a SQLite file we do NOT own (Apple's Envelope
 * Index, chat.db, etc.). `immutable=1` skips locking so we can read even while
 * the owning app holds a write lock.
 */
function createReadOnlyConnection(path) {
  return new Database(`file:${path}?immutable=1`, {
    readonly: true,
    create: false,
  });
}
function applyPragmas(db, pragmas) {
  db.exec(`PRAGMA journal_mode=${pragmas.journal_mode}`);
  db.exec(`PRAGMA synchronous=${pragmas.synchronous}`);
  db.exec(`PRAGMA busy_timeout=${pragmas.busy_timeout}`);
  db.exec(`PRAGMA foreign_keys=${pragmas.foreign_keys}`);
}
//#endregion
export {
  JxaError as a,
  TimeoutError as c,
  MAIL_CORE as i,
  withTimeout as l,
  createConnection as n,
  JxaTimeoutError as o,
  createReadOnlyConnection as r,
  runJxa as s,
  DEFAULT_PRAGMAS as t,
};
