import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { _resetMailIndexForTests, getMailIndex } from "../../../src/domains/mail/index/manager.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mac-mcp-mgr-"));
  _resetMailIndexForTests();
});
afterEach(() => {
  _resetMailIndexForTests();
  rmSync(tmp, { recursive: true, force: true });
});

test("getMailIndex initialises with config and reports an empty status", () => {
  const mgr = getMailIndex({
    indexDir: tmp,
    maxEmailsPerMailbox: 100,
    excludeMailboxes: ["Drafts"],
    syncIntervalSeconds: 300,
  });
  const status = mgr.getStatus();
  expect(status.available).toBe(true);
  expect(status.emailCount).toBe(0);
  expect(status.mailboxCount).toBe(0);
  expect(status.failedJobsCount).toBe(0);
  expect(status.syncInProgress).toBe(false);
  expect(status.path).toBe(`${tmp}/mail.db`);
});

test("getMailIndex throws when called before init", () => {
  _resetMailIndexForTests();
  expect(() => getMailIndex()).toThrow();
});
