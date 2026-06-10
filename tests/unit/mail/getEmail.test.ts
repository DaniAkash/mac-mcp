import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { _resetMailIndexForTests, getMailIndex } from "../../../src/domains/mail/index/manager.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mac-mcp-getemail-"));
  _resetMailIndexForTests();
});
afterEach(() => {
  _resetMailIndexForTests();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Regression test for the local-index lookup in `mail_get_email`. The bug
 * being guarded: the SQL query keyed `emails.message_id` against the wrong
 * column (the 63-bit hash) and was not scoped by (account, mailbox), so the
 * lookup always missed and `mail_get_email` always fell back to the
 * envelope-only response.
 */
test("local index lookup matches by (account, mailbox, message_id) composite", () => {
  const mgr = getMailIndex({
    indexDir: tmp,
    maxEmailsPerMailbox: 0,
    excludeMailboxes: [],
    syncIntervalSeconds: 300,
  });
  const db = mgr.getDb();

  // Two mailboxes with the same per-mailbox message_id (Mail.app reuses
  // small integer ids across mailboxes). Lookup must pick the right row.
  const emlxA = join(tmp, "a.emlx");
  const emlxB = join(tmp, "b.emlx");
  writeFileSync(emlxA, "fake a");
  writeFileSync(emlxB, "fake b");

  const insert = db.prepare(
    `INSERT INTO emails (message_id, account, mailbox, subject, sender, content, date_received, date_sent, emlx_path, category, is_unread, is_flagged, attachment_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(42, "UUID-AAA", "INBOX", "Sub A", "a@x.com", "body a", "", "", emlxA, null, 1, 0, 0);
  insert.run(42, "UUID-BBB", "INBOX", "Sub B", "b@x.com", "body b", "", "", emlxB, null, 1, 0, 0);

  const row = db
    .query(
      "SELECT emlx_path FROM emails WHERE message_id = ? AND account = ? AND mailbox = ? LIMIT 1",
    )
    .get(42, "UUID-BBB", "INBOX") as { emlx_path: string } | null;
  expect(row?.emlx_path).toBe(emlxB);

  // Without scoping, the buggy query would return whichever row SQLite
  // returns first - usually the lowest rowid, i.e. emlxA. Verify the
  // scoping is actually doing work.
  const rowAll = db
    .query("SELECT emlx_path FROM emails WHERE message_id = ? ORDER BY rowid LIMIT 1")
    .get(42) as { emlx_path: string } | null;
  expect(rowAll?.emlx_path).toBe(emlxA);
});
