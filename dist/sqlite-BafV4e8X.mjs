import { b as DEFAULT_SQLITE_BUSY_TIMEOUT_MS } from "./server-ChRQlHdB.mjs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
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
export { createConnection as n, createReadOnlyConnection as r, DEFAULT_PRAGMAS as t };
