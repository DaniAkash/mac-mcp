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

test("getStatus reports lastSync + stalenessHours once a sync row exists", () => {
  const mgr = getMailIndex({
    indexDir: tmp,
    maxEmailsPerMailbox: 0,
    excludeMailboxes: [],
    syncIntervalSeconds: 300,
  });
  // Manually write the sentinel row using the same UPSERT shape sync.ts uses.
  mgr.getDb().run(
    `INSERT INTO sync_state (account, mailbox, last_sync, message_count)
       VALUES ('__global', '__global', datetime('now'), 0)
       ON CONFLICT(account, mailbox) DO UPDATE SET last_sync = excluded.last_sync`,
  );
  const status = mgr.getStatus();
  expect(status.lastSync).not.toBe(null);
  expect(status.lastSync).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // Just-now sync, so staleness is tiny but non-null.
  expect(status.stalenessHours).not.toBe(null);
  expect(status.stalenessHours).toBeLessThan(1);
});
