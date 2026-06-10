import type { Database } from "bun:sqlite";
import { createReadOnlyConnection } from "../../../utils/sqlite.ts";
import { detectMailDir } from "../../../utils/paths.ts";
import type { EmailSummary, MailCategory } from "../mail.types.ts";
import {
  CATEGORY_INT_BY_LABEL,
  labelForCategoryInt,
  probeCategorySupport,
  type CategorySupport,
} from "./categories.ts";

export interface EnvelopeIndexHandle {
  db: Database;
  path: string;
  categorySupport: CategorySupport;
  close: () => void;
}

export function openEnvelopeIndex(): EnvelopeIndexHandle | null {
  const mailDir = detectMailDir();
  if (!mailDir) return null;
  const path = `${mailDir.path}/MailData/Envelope Index`;
  let db: Database;
  try {
    db = createReadOnlyConnection(path);
  } catch {
    return null;
  }
  const categorySupport = probeCategorySupport(db);
  return {
    db,
    path,
    categorySupport,
    close: () => db.close(),
  };
}

export interface ParsedMailboxUrl {
  scheme: string;
  uuid: string;
  mailbox: string;
}

/**
 * Mail's `mailboxes.url` is shaped `<scheme>://<account-uuid>/<mailbox-name>`
 * where scheme is one of `imap`, `local`, `ews`, etc. Decode percent-encoded
 * mailbox names like `%5BGmail%5D/All%20Mail`.
 */
export function parseMailboxUrl(url: string): ParsedMailboxUrl | null {
  const schemeMatch = url.match(/^([a-z]+):\/\/([^/]+)\/?(.*)$/);
  if (!schemeMatch) return null;
  const [, scheme, uuid, rest] = schemeMatch;
  if (!scheme || !uuid) return null;
  return {
    scheme,
    uuid,
    mailbox: decodeURIComponent(rest ?? ""),
  };
}

/**
 * Re-encode a decoded mailbox name for use in `mailboxes.url`-style LIKE
 * predicates. Each `/`-separated segment is `encodeURIComponent`-encoded,
 * then rejoined with literal `/` so paths like `[Gmail]/All Mail` produce
 * the same `%5BGmail%5D/All%20Mail` shape Apple stores.
 */
export function encodeMailboxPath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

export interface ListMailboxesRow {
  rowid: number;
  account: string;
  name: string;
  unreadCount: number;
}

export function listMailboxes(db: Database, accountUuid?: string): ListMailboxesRow[] {
  const rows = db
    .query(
      "SELECT ROWID AS rowid, url, unread_count FROM mailboxes WHERE url IS NOT NULL ORDER BY total_count DESC",
    )
    .all() as { rowid: number; url: string; unread_count: number }[];
  const out: ListMailboxesRow[] = [];
  for (const r of rows) {
    const parsed = parseMailboxUrl(r.url);
    if (!parsed) continue;
    if (accountUuid && parsed.uuid !== accountUuid) continue;
    out.push({
      rowid: r.rowid,
      account: parsed.uuid,
      name: parsed.mailbox,
      unreadCount: r.unread_count,
    });
  }
  return out;
}

export interface GetEmailsOpts {
  /** Apple account UUID (after AccountMap resolution). */
  accountUuid?: string;
  /** Mailbox display name (decoded form, e.g. "INBOX" or "[Gmail]/All Mail"). */
  mailbox?: string;
  /** Recency / status filter. */
  filter?: "all" | "unread" | "flagged" | "today" | "last_7_days";
  /** Category filter, ignored when category support is unsupported. */
  category?: MailCategory;
  /** ISO date (YYYY-MM-DD) lower bound, inclusive of midnight UTC. */
  after?: string;
  /** ISO date (YYYY-MM-DD) upper bound, exclusive of midnight UTC. */
  before?: string;
  limit?: number;
}

export interface EnvelopeEmailRow {
  id: number;
  account: string;
  mailbox: string;
  subject: string;
  sender: string;
  dateReceived: number;
  isUnread: boolean;
  isFlagged: boolean;
  category: MailCategory | null;
}

/**
 * Pull EmailSummary-shaped rows directly from Apple's Envelope Index, sorted
 * by date_received DESC. Joins through `subjects` and `addresses` lookup
 * tables, and optionally `message_global_data` for category support.
 */
export function queryEmails(handle: EnvelopeIndexHandle, opts: GetEmailsOpts): EnvelopeEmailRow[] {
  const supportsCategory = handle.categorySupport.kind === "supported";
  const where: string[] = ["m.deleted = 0"];
  const params: (string | number)[] = [];

  if (opts.accountUuid) {
    where.push("mb.url LIKE ?");
    params.push(`%://${opts.accountUuid}/%`);
  }
  if (opts.mailbox) {
    where.push("mb.url LIKE ?");
    params.push(`%/${encodeMailboxPath(opts.mailbox)}`);
  }
  switch (opts.filter) {
    case "unread":
      where.push("m.read = 0");
      break;
    case "flagged":
      where.push("m.flagged = 1");
      break;
    case "today": {
      const midnight = Math.floor(new Date(new Date().toDateString()).getTime() / 1000);
      where.push("m.date_received >= ?");
      params.push(midnight);
      break;
    }
    case "last_7_days": {
      where.push("m.date_received >= ?");
      params.push(Math.floor(Date.now() / 1000) - 7 * 24 * 3600);
      break;
    }
  }
  if (opts.after) {
    where.push("m.date_received >= ?");
    params.push(epochFromDateOnly(opts.after));
  }
  if (opts.before) {
    where.push("m.date_received < ?");
    params.push(epochFromDateOnly(opts.before));
  }
  if (opts.category && supportsCategory) {
    where.push("mgd.model_category = ?");
    where.push("(mgd.category_is_temporary IS NULL OR mgd.category_is_temporary = 0)");
    params.push(CATEGORY_INT_BY_LABEL[opts.category]);
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const categoryJoin = supportsCategory
    ? "LEFT JOIN message_global_data mgd ON mgd.message_id = m.message_id AND (mgd.category_is_temporary IS NULL OR mgd.category_is_temporary = 0)"
    : "";
  const categoryCol = supportsCategory
    ? "mgd.model_category AS category_int"
    : "NULL AS category_int";

  const sql = `
    SELECT
      m.ROWID AS id,
      mb.url AS mailbox_url,
      s.subject AS subject,
      a.address AS sender,
      m.date_received AS date_received,
      m.read AS read,
      m.flagged AS flagged,
      ${categoryCol}
    FROM messages m
    JOIN mailboxes mb ON mb.ROWID = m.mailbox
    LEFT JOIN subjects s ON s.ROWID = m.subject
    LEFT JOIN addresses a ON a.ROWID = m.sender
    ${categoryJoin}
    WHERE ${where.join(" AND ")}
    ORDER BY m.date_received DESC
    LIMIT ${limit}
  `;

  const rows = handle.db.query(sql).all(...params) as {
    id: number;
    mailbox_url: string;
    subject: string | null;
    sender: string | null;
    date_received: number | null;
    read: number;
    flagged: number;
    category_int: number | null;
  }[];

  return rows.map((r) => {
    const parsed = parseMailboxUrl(r.mailbox_url);
    return {
      id: r.id,
      account: parsed?.uuid ?? "",
      mailbox: parsed?.mailbox ?? "",
      subject: r.subject ?? "",
      sender: r.sender ?? "",
      dateReceived: r.date_received ?? 0,
      isUnread: r.read === 0,
      isFlagged: r.flagged === 1,
      category: labelForCategoryInt(r.category_int),
    };
  });
}

export function emailSummaryFromEnvelopeRow(
  r: EnvelopeEmailRow,
  accountDisplayName: string,
): EmailSummary {
  return {
    id: r.id,
    account: accountDisplayName,
    mailbox: r.mailbox,
    subject: r.subject,
    sender: r.sender,
    preview: "",
    dateReceived: r.dateReceived > 0 ? new Date(r.dateReceived * 1000).toISOString() : "",
    isUnread: r.isUnread,
    isFlagged: r.isFlagged,
    hasAttachments: false,
    category: r.category,
  };
}

function epochFromDateOnly(yyyyMmDd: string): number {
  const t = Date.parse(`${yyyyMmDd}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}
