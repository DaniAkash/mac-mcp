import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { parseMailboxUrl } from "../../../src/domains/mail/index/envelopeDirect.ts";

test("parseMailboxUrl: imap://uuid/INBOX", () => {
  const r = parseMailboxUrl("imap://07761D36-5854-41F7-8FD8-9686DB21500C/INBOX");
  expect(r?.scheme).toBe("imap");
  expect(r?.uuid).toBe("07761D36-5854-41F7-8FD8-9686DB21500C");
  expect(r?.mailbox).toBe("INBOX");
});

test("parseMailboxUrl: percent-decoded Gmail label", () => {
  const r = parseMailboxUrl("imap://UUID/%5BGmail%5D/All%20Mail");
  expect(r?.mailbox).toBe("[Gmail]/All Mail");
});

test("parseMailboxUrl: local:// scheme", () => {
  const r = parseMailboxUrl("local://UUID/SendLater");
  expect(r?.scheme).toBe("local");
  expect(r?.mailbox).toBe("SendLater");
});

test("parseMailboxUrl: ews:// scheme survives", () => {
  const r = parseMailboxUrl("ews://UUID/Inbox");
  expect(r?.scheme).toBe("ews");
  expect(r?.mailbox).toBe("Inbox");
});

test("parseMailboxUrl: malformed URL returns null", () => {
  expect(parseMailboxUrl("not a url at all")).toBe(null);
  expect(parseMailboxUrl("")).toBe(null);
});

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
});
afterEach(() => {
  db.close();
});
