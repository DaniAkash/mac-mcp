import type { Database } from "bun:sqlite";
import type { MailCategory, SearchResult } from "../mail.types.ts";

export interface SearchOpts {
  query: string;
  scope?: "all" | "subject" | "sender" | "body";
  account?: string;
  mailbox?: string;
  category?: MailCategory;
  before?: string;
  after?: string;
  highlight?: boolean;
  limit?: number;
  offset?: number;
}

const FTS_OPERATORS = new Set(["AND", "OR", "NOT"]);
const BARE_TOKEN_SPECIAL = /[:\-()'^]/;

/**
 * Sanitise an FTS5 query while preserving intentional syntax:
 * - balanced "double-quoted phrases"
 * - trailing * for prefix search
 * - operators AND / OR / NOT
 * - bare tokens with dangerous characters get wrapped in quotes
 * - unbalanced quotes are dropped
 */
export function sanitiseFtsQuery(raw: string): string {
  if (raw.length === 0) return "";

  const quoteCount = (raw.match(/"/g) ?? []).length;
  const balanced = quoteCount % 2 === 0 ? raw : raw.replace(/"/g, "");

  const out: string[] = [];
  const re = /"[^"]+"|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(balanced)) !== null) {
    const tok = m[0];
    if (tok.startsWith('"') && tok.endsWith('"')) {
      out.push(tok);
      continue;
    }
    if (FTS_OPERATORS.has(tok.toUpperCase())) {
      out.push(tok.toUpperCase());
      continue;
    }
    if (tok.endsWith("*")) {
      const stem = tok.slice(0, -1);
      if (stem.length > 0 && !BARE_TOKEN_SPECIAL.test(stem)) {
        out.push(tok);
        continue;
      }
    }
    if (BARE_TOKEN_SPECIAL.test(tok)) {
      out.push(`"${tok.replace(/"/g, "")}"`);
      continue;
    }
    out.push(tok);
  }
  return out.join(" ").trim();
}

interface FtsRow {
  rowid: number;
  message_id: number;
  account: string;
  mailbox: string;
  subject: string;
  sender: string;
  date_received: string;
  emlx_path: string;
  category: string | null;
  is_unread: number;
  is_flagged: number;
  attachment_count: number;
  snippet: string;
  bm25: number;
}

export function searchEmails(db: Database, opts: SearchOpts): SearchResult[] {
  const sanitised = sanitiseFtsQuery(opts.query);
  if (sanitised.length === 0) return [];

  let ftsQuery: string;
  switch (opts.scope ?? "all") {
    case "subject":
      ftsQuery = `subject:(${sanitised})`;
      break;
    case "sender":
      ftsQuery = `sender:(${sanitised})`;
      break;
    case "body":
      ftsQuery = `content:(${sanitised})`;
      break;
    default:
      ftsQuery = sanitised;
  }

  const where: string[] = ["emails_fts MATCH ?"];
  const params: (string | number)[] = [ftsQuery];

  if (opts.account) {
    where.push("e.account = ?");
    params.push(opts.account);
  }
  if (opts.mailbox) {
    where.push("e.mailbox = ?");
    params.push(opts.mailbox);
  }
  if (opts.category) {
    where.push("e.category = ?");
    params.push(opts.category);
  }
  if (opts.after) {
    where.push("e.date_received >= ?");
    params.push(opts.after);
  }
  if (opts.before) {
    where.push("e.date_received < ?");
    params.push(opts.before);
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 30, 100));
  const offset = Math.max(0, opts.offset ?? 0);
  const snippetFn = opts.highlight
    ? "snippet(emails_fts, 2, '**', '**', '...', 32)"
    : "snippet(emails_fts, 2, '', '', '...', 32)";

  const sql = `
    SELECT
      e.rowid AS rowid,
      e.message_id AS message_id,
      e.account AS account,
      e.mailbox AS mailbox,
      e.subject AS subject,
      e.sender AS sender,
      e.date_received AS date_received,
      e.emlx_path AS emlx_path,
      e.category AS category,
      e.is_unread AS is_unread,
      e.is_flagged AS is_flagged,
      e.attachment_count AS attachment_count,
      ${snippetFn} AS snippet,
      bm25(emails_fts, 1.0, 0.5, 2.0) AS bm25
    FROM emails e
    JOIN emails_fts ON emails_fts.rowid = e.rowid
    WHERE ${where.join(" AND ")}
    ORDER BY bm25 ASC, e.date_received DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  let rows: FtsRow[];
  try {
    rows = db.query(sql).all(...params) as FtsRow[];
  } catch (e) {
    // Retry once with aggressive per-term quoting on syntax error
    const msg = (e as Error).message;
    if (!/syntax error/i.test(msg)) throw e;
    const safe = sanitised
      .split(/\s+/)
      .map((t) => (FTS_OPERATORS.has(t) ? t : `"${t.replace(/"/g, "")}"`))
      .join(" ");
    params[0] = scopedQuery(opts.scope, safe);
    rows = db.query(sql).all(...params) as FtsRow[];
  }

  return rows.map((r) => ({
    id: r.message_id,
    account: r.account,
    mailbox: r.mailbox,
    subject: r.subject,
    sender: r.sender,
    preview: r.snippet,
    dateReceived: r.date_received,
    isUnread: r.is_unread === 1,
    isFlagged: r.is_flagged === 1,
    hasAttachments: r.attachment_count > 0,
    category: (r.category as MailCategory | null) ?? null,
    snippet: r.snippet,
    bm25Score: r.bm25,
  }));
}

function scopedQuery(scope: SearchOpts["scope"], q: string): string {
  switch (scope) {
    case "subject":
      return `subject:(${q})`;
    case "sender":
      return `sender:(${q})`;
    case "body":
      return `content:(${q})`;
    default:
      return q;
  }
}
