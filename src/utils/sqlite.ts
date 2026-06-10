import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_SQLITE_BUSY_TIMEOUT_MS } from "../constants.ts";

export interface ConnectionOpts {
  /** Create the file (and its parent directory) if missing. Default true. */
  create?: boolean;
  /** Override pragma values. */
  pragmas?: Partial<Pragmas>;
}

export interface Pragmas {
  journal_mode: string;
  synchronous: string;
  busy_timeout: number;
  foreign_keys: string;
}

export const DEFAULT_PRAGMAS: Pragmas = {
  journal_mode: "WAL",
  synchronous: "NORMAL",
  busy_timeout: DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  foreign_keys: "ON",
};

/**
 * Open a writable SQLite connection for an index DB we own. Applies the
 * project-wide pragma defaults so behaviour does not drift across modules.
 */
export function createConnection(path: string, opts: ConnectionOpts = {}): Database {
  const create = opts.create ?? true;
  if (create) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create });
  applyPragmas(db, { ...DEFAULT_PRAGMAS, ...opts.pragmas });
  return db;
}

/**
 * Open a read-only handle to a SQLite file we do NOT own (Apple's Envelope
 * Index, chat.db, etc.). `immutable=1` skips locking so we can read even while
 * the owning app holds a write lock.
 */
export function createReadOnlyConnection(path: string): Database {
  return new Database(`file:${path}?immutable=1`, { readonly: true, create: false });
}

function applyPragmas(db: Database, pragmas: Pragmas): void {
  db.exec(`PRAGMA journal_mode=${pragmas.journal_mode}`);
  db.exec(`PRAGMA synchronous=${pragmas.synchronous}`);
  db.exec(`PRAGMA busy_timeout=${pragmas.busy_timeout}`);
  db.exec(`PRAGMA foreign_keys=${pragmas.foreign_keys}`);
}
