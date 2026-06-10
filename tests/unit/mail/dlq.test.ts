import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  clearFailure,
  countFailures,
  listFailures,
  recordFailure,
} from "../../../src/domains/mail/index/dlq.ts";
import { SCHEMA_V1 } from "../../../src/domains/mail/index/schema.sql.ts";
import { createConnection } from "../../../src/utils/sqlite.ts";

let tmp: string;
let db: ReturnType<typeof createConnection>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mac-mcp-dlq-"));
  db = createConnection(join(tmp, "mail.db"));
  db.exec(SCHEMA_V1);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("recordFailure inserts a new row", () => {
  recordFailure(db, {
    emlxPath: "/x/1.emlx",
    account: "A",
    mailbox: "INBOX",
    errorType: "parse",
    errorMessage: "boom",
  });
  expect(countFailures(db)).toBe(1);
});

test("recordFailure on conflicting path bumps attempt_count", () => {
  recordFailure(db, {
    emlxPath: "/x/2.emlx",
    account: "A",
    mailbox: "INBOX",
    errorType: "parse",
    errorMessage: "first",
  });
  recordFailure(db, {
    emlxPath: "/x/2.emlx",
    account: "A",
    mailbox: "INBOX",
    errorType: "parse",
    errorMessage: "second",
  });
  expect(countFailures(db)).toBe(1);
  const entries = listFailures(db);
  expect(entries[0]?.attempt_count).toBe(2);
  expect(entries[0]?.error_message).toBe("second");
});

test("clearFailure deletes a row", () => {
  recordFailure(db, {
    emlxPath: "/x/3.emlx",
    account: "A",
    mailbox: "INBOX",
    errorType: "parse",
    errorMessage: "x",
  });
  expect(countFailures(db)).toBe(1);
  clearFailure(db, "/x/3.emlx");
  expect(countFailures(db)).toBe(0);
});

test("listFailures honours the limit", () => {
  for (let i = 0; i < 5; i++) {
    recordFailure(db, {
      emlxPath: `/x/${i}.emlx`,
      account: "A",
      mailbox: "INBOX",
      errorType: "parse",
      errorMessage: "x",
    });
  }
  expect(listFailures(db, 3)).toHaveLength(3);
});
