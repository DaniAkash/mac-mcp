import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createConnection, createReadOnlyConnection } from "../../src/utils/sqlite.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mac-mcp-sqlite-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("createConnection applies project pragmas", () => {
  const db = createConnection(join(tmp, "test.db"));
  const journal = (db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null)
    ?.journal_mode;
  expect(journal?.toLowerCase()).toBe("wal");
  const fk = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number } | null)
    ?.foreign_keys;
  expect(fk).toBe(1);
  db.close();
});

test("createConnection creates parent directories", () => {
  const path = join(tmp, "nested/deep/path/test.db");
  const db = createConnection(path);
  db.exec("CREATE TABLE t(a INTEGER)");
  db.exec("INSERT INTO t VALUES (1)");
  const row = db.query("SELECT a FROM t").get() as { a: number };
  expect(row.a).toBe(1);
  db.close();
});

test("createReadOnlyConnection refuses writes", () => {
  const path = join(tmp, "ro.db");
  const writer = createConnection(path);
  writer.exec("CREATE TABLE t(a INTEGER)");
  writer.exec("INSERT INTO t VALUES (1)");
  writer.close();

  const reader = createReadOnlyConnection(path);
  expect(reader.query("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 1 });
  expect(() => reader.exec("INSERT INTO t VALUES (2)")).toThrow();
  reader.close();
});
