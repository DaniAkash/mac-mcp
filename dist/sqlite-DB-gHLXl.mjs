import { b as DEFAULT_SQLITE_BUSY_TIMEOUT_MS, d as safeStringify } from "./server-BTVN4ZGR.mjs";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
const CORES_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "cores");
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
  const cores = (opts.cores ?? []).map(loadCore).join("\n\n");
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
const coreCache = /* @__PURE__ */ new Map();
function loadCore(name) {
  const cached = coreCache.get(name);
  if (cached !== void 0) return cached;
  const path = join(CORES_DIR, `${name}Core.js`);
  let body;
  try {
    body = readFileSync(path, "utf8");
  } catch (e) {
    throw new JxaError(`cannot load JXA core "${name}" at ${path}: ${e.message}`);
  }
  coreCache.set(name, body);
  return body;
}
/**
 * List the names of cores currently bundled. Used by tests and diagnostics
 * to enumerate which JXA helpers are available.
 */
function listCores() {
  try {
    return readdirSync(CORES_DIR)
      .filter((f) => f.endsWith("Core.js"))
      .map((f) => f.replace(/Core\.js$/, ""));
  } catch {
    return [];
  }
}
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
  JxaTimeoutError as a,
  TimeoutError as c,
  JxaError as i,
  withTimeout as l,
  createConnection as n,
  listCores as o,
  createReadOnlyConnection as r,
  runJxa as s,
  DEFAULT_PRAGMAS as t,
};
