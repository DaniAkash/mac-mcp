/**
 * End-to-end tests that hit real Mail.app + the live Envelope Index. These
 * require Full Disk Access and Mail to be configured with at least one
 * account, so they only run when MAC_MCP_E2E=1 is set. CI never sets this
 * env var, so these tests are skipped on every CI run.
 *
 * Run locally with:
 *
 *   bun run test:e2e
 *
 * or directly:
 *
 *   MAC_MCP_E2E=1 bun test tests/e2e
 */
import { glob } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { _clearAccountMapForTests } from "../../src/domains/mail/index/accountMap.ts";
import { openEnvelopeIndex } from "../../src/domains/mail/index/envelopeDirect.ts";
import { _resetMailIndexForTests, getMailIndex } from "../../src/domains/mail/index/manager.ts";
import { TOOL as getEmailTool } from "../../src/server/tools/mail/getEmail.ts";
import { TOOL as getEmailLinksTool } from "../../src/server/tools/mail/getEmailLinks.ts";
import { TOOL as getEmailsTool } from "../../src/server/tools/mail/getEmails.ts";
import { TOOL as listAccountsTool } from "../../src/server/tools/mail/listAccounts.ts";
import { TOOL as listMailboxesTool } from "../../src/server/tools/mail/listMailboxes.ts";
import { detectMailDir } from "../../src/utils/paths.ts";

const E2E = process.env.MAC_MCP_E2E === "1";

interface AccountsResult {
  accounts: { name: string; id: string }[];
}
interface MailboxesResult {
  mailboxes: { account: string; name: string; unreadCount: number }[];
  hint?: string;
}
interface EmailsFlat {
  ordering: string;
  emails: {
    id: number;
    subject: string;
    sender: string;
    isUnread: boolean;
    category: string | null;
  }[];
  hint?: string;
}
interface EmailsGrouped {
  ordering: string;
  groups: Record<string, { id: number; isUnread: boolean; category: string | null }[]>;
  hint?: string;
}

describe.skipIf(!E2E)("mail e2e: direct handler calls against live Mail data", () => {
  beforeAll(() => {
    _clearAccountMapForTests();
    const handle = openEnvelopeIndex();
    if (!handle) {
      throw new Error(
        "Cannot open Envelope Index. Grant Full Disk Access to your terminal and retry, or unset MAC_MCP_E2E.",
      );
    }
    handle.close();
  });
  afterAll(() => {
    _clearAccountMapForTests();
  });

  test("mail_list_accounts: returns >=1 account with non-empty name and UUID-shaped id", async () => {
    const result = (await listAccountsTool.handler({})) as AccountsResult;
    expect(result.accounts.length).toBeGreaterThan(0);
    const first = result.accounts[0];
    expect(first?.name).toBeTruthy();
    expect(first?.id).toMatch(/^[0-9A-F-]{20,}$/i);
  });

  test("mail_list_mailboxes: returns at least one mailbox for the first account", async () => {
    const { accounts } = (await listAccountsTool.handler({})) as AccountsResult;
    const account = accounts[0]?.name;
    expect(account).toBeTruthy();
    const result = (await listMailboxesTool.handler({ account })) as MailboxesResult;
    expect(result.mailboxes.length).toBeGreaterThan(0);
    expect(result.mailboxes[0]?.unreadCount).toBeGreaterThanOrEqual(0);
  });

  test("mail_list_mailboxes: unknown account name yields an empty list with a hint", async () => {
    const result = (await listMailboxesTool.handler({
      account: "__definitely_not_a_real_account__",
    })) as MailboxesResult;
    expect(result.mailboxes).toEqual([]);
    expect(result.hint).toMatch(/no account matched/i);
  });

  test("mail_get_emails: flat list is sorted by date_received DESC", async () => {
    const result = (await getEmailsTool.handler({ limit: 10 })) as EmailsFlat;
    expect(result.ordering).toBe("date_received_desc");
    expect(result.emails.length).toBeGreaterThan(0);
    for (let i = 0; i + 1 < result.emails.length; i++) {
      const cur = (result.emails[i] as unknown as { dateReceived: string }).dateReceived;
      const next = (result.emails[i + 1] as unknown as { dateReceived: string }).dateReceived;
      // ISO 8601 timestamps sort lexicographically equivalent to chronological order.
      expect(cur >= next).toBe(true);
    }
  });

  test("mail_get_emails: filter=unread only returns isUnread:true items", async () => {
    const result = (await getEmailsTool.handler({ filter: "unread", limit: 10 })) as EmailsFlat;
    for (const e of result.emails) expect(e.isUnread).toBe(true);
  });

  test("mail_get_emails: group_by=unread returns {unread, read}", async () => {
    const result = (await getEmailsTool.handler({ group_by: "unread", limit: 5 })) as EmailsGrouped;
    expect(result.groups.unread).toBeDefined();
    expect(result.groups.read).toBeDefined();
    for (const e of result.groups.unread ?? []) expect(e.isUnread).toBe(true);
    for (const e of result.groups.read ?? []) expect(e.isUnread).toBe(false);
  });

  test("mail_get_emails: category filter returns only that category", async () => {
    const result = (await getEmailsTool.handler({
      category: "transactions",
      limit: 5,
    })) as EmailsFlat;
    if (result.hint?.match(/not available on this macOS/)) {
      return; // macOS 14: feature unsupported, this assertion does not apply
    }
    expect(result.emails.length).toBeGreaterThan(0);
    for (const e of result.emails) {
      expect(e.category).toBe("transactions");
    }
  });

  test("mail_get_emails: group_by=category returns the 5 buckets when supported", async () => {
    const result = (await getEmailsTool.handler({
      group_by: "category",
      limit: 3,
    })) as EmailsGrouped;
    if (result.hint?.match(/not available on this macOS/)) {
      // On macOS 14, only 'uncategorised' bucket should be present.
      expect(Object.keys(result.groups)).toEqual(["uncategorised"]);
      return;
    }
    const buckets = Object.keys(result.groups);
    expect(buckets).toContain("primary");
    expect(buckets).toContain("transactions");
    expect(buckets).toContain("updates");
    expect(buckets).toContain("promotions");
    expect(buckets).toContain("uncategorised");
  });

  test("mail_get_emails: group_by=account returns >=1 bucket keyed by display name", async () => {
    const result = (await getEmailsTool.handler({
      group_by: "account",
      limit: 5,
    })) as EmailsGrouped;
    const buckets = Object.keys(result.groups);
    expect(buckets.length).toBeGreaterThan(0);
    const { accounts } = (await listAccountsTool.handler({})) as AccountsResult;
    const knownNames = new Set(accounts.map((a) => a.name));
    for (const name of buckets) expect(knownNames.has(name)).toBe(true);
  });

  test("mail_get_email: fetches a real message by id", async () => {
    const list = (await getEmailsTool.handler({ limit: 1 })) as EmailsFlat;
    const first = list.emails[0];
    expect(first?.id).toBeDefined();
    if (!first) return;
    const result = (await getEmailTool.handler({ messageId: first.id })) as {
      id: number;
      subject: string;
      sender: string;
    };
    expect(result.id).toBe(first.id);
    expect(result.subject).toBe(first.subject);
    expect(result.sender).toBe(first.sender);
  });

  test("mail_get_email: unknown messageId returns an error string", async () => {
    const result = (await getEmailTool.handler({ messageId: 999_999_999_999 })) as {
      error?: string;
    };
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/No message with id/);
  });

  test("mail_get_email: with a populated local index, returns body + recipients from disk", async () => {
    // Pick the most recent email and find its .emlx on disk so we can seed
    // the local index. This proves the full disk-path branch of
    // mail_get_email - the one that always silently no-op'd before the
    // (account, mailbox, message_id) lookup fix.
    const list = (await getEmailsTool.handler({ limit: 1 })) as EmailsFlat & {
      emails: (EmailsFlat["emails"][number] & { mailbox?: string })[];
    };
    const first = list.emails[0];
    expect(first).toBeDefined();
    if (!first) return;

    const { accounts } = (await listAccountsTool.handler({})) as AccountsResult;
    const accountUuid = accounts.find(
      (a) => a.name === (first as { account?: string }).account,
    )?.id;
    expect(accountUuid).toBeDefined();
    const mailbox = (first as { mailbox?: string }).mailbox;
    expect(mailbox).toBeTruthy();

    const mailDir = detectMailDir();
    expect(mailDir).not.toBeNull();
    if (!mailDir || !accountUuid || !mailbox) return;

    // Translate "[Gmail]/All Mail" -> "[Gmail].mbox/All Mail.mbox" to walk the
    // on-disk path. .emlx files live under variable sharded subdirectories,
    // so glob for the id anywhere beneath the mailbox root.
    const mailboxPath = mailbox
      .split("/")
      .map((s) => `${s}.mbox`)
      .join("/");
    const searchRoot = `${mailDir.path}/${accountUuid}/${mailboxPath}`;
    const candidates = await Array.fromAsync(glob(`${searchRoot}/**/${first.id}.emlx`));
    const emlxPath = candidates[0];
    if (!emlxPath) {
      // Not every envelope row is materialised on disk (e.g. server-side
      // copies of [Gmail]/All Mail). Skip gracefully if we cannot find the
      // disk-backed payload - the unit test in tests/unit/mail/getEmail.test.ts
      // already covers the SQL lookup shape.
      return;
    }

    // Spin up an isolated local index pointing at a tmp dir, seed it with
    // the single row, then call the tool.
    const tmp = mkdtempSync(join(tmpdir(), "mac-mcp-e2e-getemail-"));
    try {
      _resetMailIndexForTests();
      const mgr = getMailIndex({
        indexDir: tmp,
        maxEmailsPerMailbox: 0,
        excludeMailboxes: [],
        syncIntervalSeconds: 86400,
      });
      mgr.getDb().run(
        `INSERT INTO emails (message_id, account, mailbox, subject, sender, content, date_received, date_sent, emlx_path, category, is_unread, is_flagged, attachment_count)
         VALUES (?, ?, ?, '', '', '', '', '', ?, NULL, 1, 0, 0)`,
        [first.id, accountUuid, mailbox, emlxPath],
      );

      const result = (await getEmailTool.handler({
        messageId: first.id,
        account: (first as { account?: string }).account,
        mailbox,
      })) as { body: string; recipients: { to: string[]; cc: string[]; bcc: string[] } };

      expect(typeof result.body).toBe("string");
      expect(result.body.length).toBeGreaterThan(0);
      // At least one recipient channel should be populated for a real message.
      const recipientCount =
        result.recipients.to.length + result.recipients.cc.length + result.recipients.bcc.length;
      expect(recipientCount).toBeGreaterThan(0);
    } finally {
      _resetMailIndexForTests();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("mail_get_email_links: unknown messageId returns an error envelope", async () => {
    const r = (await getEmailLinksTool.handler({ messageId: 999_999_999 })) as { error?: string };
    expect(r.error).toBeDefined();
  });

  test("mail_get_email_links: returns a links array shape for a real indexed email", async () => {
    const list = (await getEmailsTool.handler({ limit: 1 })) as EmailsFlat & {
      emails: (EmailsFlat["emails"][number] & { mailbox?: string; account?: string })[];
    };
    const first = list.emails[0];
    if (!first) return;
    const { accounts } = (await listAccountsTool.handler({})) as AccountsResult;
    const accountUuid = accounts.find((a) => a.name === first.account)?.id;
    const mailbox = first.mailbox;
    if (!accountUuid || !mailbox) return;
    const mailDir = detectMailDir();
    if (!mailDir) return;
    const mailboxPath = mailbox
      .split("/")
      .map((s) => `${s}.mbox`)
      .join("/");
    const searchRoot = `${mailDir.path}/${accountUuid}/${mailboxPath}`;
    const candidates = await Array.fromAsync(glob(`${searchRoot}/**/${first.id}.emlx`));
    const emlxPath = candidates[0];
    if (!emlxPath) return;
    const tmp = mkdtempSync(join(tmpdir(), "mac-mcp-e2e-links-"));
    try {
      _resetMailIndexForTests();
      const mgr = getMailIndex({
        indexDir: tmp,
        maxEmailsPerMailbox: 0,
        excludeMailboxes: [],
        syncIntervalSeconds: 86400,
      });
      mgr.getDb().run(
        `INSERT INTO emails (message_id, account, mailbox, subject, sender, content, date_received, date_sent, emlx_path, category, is_unread, is_flagged, attachment_count)
         VALUES (?, ?, ?, '', '', '', '', '', ?, NULL, 1, 0, 0)`,
        [first.id, accountUuid, mailbox, emlxPath],
      );
      const r = (await getEmailLinksTool.handler({
        messageId: first.id,
        account: first.account,
        mailbox,
        limit: 25,
      })) as {
        source?: string;
        links?: { url: string; kind: string }[];
        truncated?: boolean;
        error?: string;
      };
      expect(r.error).toBeUndefined();
      expect(r.source).toBeDefined();
      expect(["html", "text", "both"]).toContain(r.source as string);
      expect(Array.isArray(r.links)).toBe(true);
      for (const l of r.links ?? []) {
        expect(typeof l.url).toBe("string");
        expect(["http", "mailto", "tel", "other"]).toContain(l.kind);
      }
    } finally {
      _resetMailIndexForTests();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
