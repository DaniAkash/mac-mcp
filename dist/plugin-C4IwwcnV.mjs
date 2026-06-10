import {
  h as isWithin,
  m as detectMailDir,
  o as logger,
  v as DEFAULT_INDEX_DIR,
} from "./server-7_N-3K5h.mjs";
import {
  i as MAIL_CORE,
  n as createConnection,
  r as createReadOnlyConnection,
  s as runJxa,
} from "./sqlite-Kls5q_80.mjs";
import { basename, join, sep } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { z } from "zod";
import { simpleParser } from "mailparser";
import * as cheerio from "cheerio";
//#region src/jxa/builders/mail.ts
/**
 * JXA script builders for the Mail domain. Every untrusted string is
 * `JSON.stringify`-inlined into the script body, which makes JXA injection
 * impossible by construction. The read-only sweep in
 * tests/unit/readOnly.test.ts rejects any write-capable Apple Events phrase
 * that might sneak in.
 */
function buildListAccountsScript() {
  return `JSON.stringify(MailCore.listAccounts());`;
}
//#endregion
//#region src/domains/mail/index/accountMap.ts
const TTL_MS = 300 * 1e3;
let cache = null;
let inflight = null;
/**
 * Mail.app account list with a 5-minute in-process TTL. The cold path goes
 * out to JXA; the warm path is instant. Single inflight per fetch so
 * concurrent callers share the same osascript spawn.
 */
async function getAccounts(opts = {}) {
  const now = Date.now();
  if (!opts.force && cache && now - cache.fetchedAt < TTL_MS) return cache.accounts;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const normalised = ((await runJxa(buildListAccountsScript(), { cores: [MAIL_CORE] })) ?? [])
        .filter((a) => Boolean(a) && typeof a.id === "string" && typeof a.name === "string")
        .map((a) => ({
          name: a.name,
          id: a.id,
        }));
      cache = {
        accounts: normalised,
        fetchedAt: now,
      };
      return normalised;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
/**
 * Resolve a user-supplied display name (or empty string for "all") into an
 * account UUID. Returns null for "all accounts", or undefined when no match.
 */
async function resolveAccountUuid(displayName) {
  if (!displayName) return null;
  const accounts = await getAccounts();
  for (const a of accounts) if (a.name === displayName) return a.id;
  const lower = displayName.toLowerCase();
  for (const a of accounts) if (a.name.toLowerCase() === lower) return a.id;
}
async function displayNameForUuid(uuid) {
  const accounts = await getAccounts();
  for (const a of accounts) if (a.id === uuid) return a.name;
  return uuid;
}
//#endregion
//#region src/domains/mail/index/categories.ts
const CATEGORY_LABEL_BY_INT = {
  0: "primary",
  1: "transactions",
  2: "updates",
  3: "promotions",
};
const CATEGORY_INT_BY_LABEL = {
  primary: 0,
  transactions: 1,
  updates: 2,
  promotions: 3,
};
/**
 * Probe the live Envelope Index for Apple Mail's categorisation support.
 * Cached per process; safe to call repeatedly. Three cheap queries; no
 * heavy joins. See the categories audit for the column layout this checks.
 */
function probeCategorySupport(db) {
  if (
    db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='message_global_data'")
      .all().length === 0
  )
    return {
      kind: "unsupported",
      reason: "message_global_data table not present",
    };
  if (
    !db
      .query("PRAGMA table_info(message_global_data)")
      .all()
      .some((c) => c.name === "model_category")
  )
    return {
      kind: "unsupported",
      reason: "message_global_data.model_category column not present",
    };
  const sample = db
    .query(
      "SELECT category_model_version FROM message_global_data WHERE model_category IS NOT NULL LIMIT 1",
    )
    .get();
  if (!sample)
    return {
      kind: "unsupported",
      reason: "no categorised messages yet",
    };
  return {
    kind: "supported",
    categoryModelVersion: sample.category_model_version,
  };
}
function labelForCategoryInt(v) {
  if (v === null || v === void 0) return null;
  return CATEGORY_LABEL_BY_INT[v] ?? null;
}
//#endregion
//#region src/domains/mail/index/envelopeDirect.ts
function openEnvelopeIndex() {
  const mailDir = detectMailDir();
  if (!mailDir) return null;
  const path = `${mailDir.path}/MailData/Envelope Index`;
  let db;
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
/**
 * Mail's `mailboxes.url` is shaped `<scheme>://<account-uuid>/<mailbox-name>`
 * where scheme is one of `imap`, `local`, `ews`, etc. Decode percent-encoded
 * mailbox names like `%5BGmail%5D/All%20Mail`.
 */
function parseMailboxUrl(url) {
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
function encodeMailboxPath(name) {
  return name.split("/").map(encodeURIComponent).join("/");
}
function listMailboxes(db, accountUuid) {
  const rows = db
    .query(
      "SELECT ROWID AS rowid, url, unread_count FROM mailboxes WHERE url IS NOT NULL ORDER BY total_count DESC",
    )
    .all();
  const out = [];
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
/**
 * Pull EmailSummary-shaped rows directly from Apple's Envelope Index, sorted
 * by date_received DESC. Joins through `subjects` and `addresses` lookup
 * tables, and optionally `message_global_data` for category support.
 */
function queryEmails(handle, opts) {
  const supportsCategory = handle.categorySupport.kind === "supported";
  const where = ["m.deleted = 0"];
  const params = [];
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
      const midnight = Math.floor(
        new Date(/* @__PURE__ */ new Date().toDateString()).getTime() / 1e3,
      );
      where.push("m.date_received >= ?");
      params.push(midnight);
      break;
    }
    case "last_7_days":
      where.push("m.date_received >= ?");
      params.push(Math.floor(Date.now() / 1e3) - 168 * 3600);
      break;
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
  const sql = `
    SELECT
      m.ROWID AS id,
      mb.url AS mailbox_url,
      s.subject AS subject,
      a.address AS sender,
      m.date_received AS date_received,
      m.read AS read,
      m.flagged AS flagged,
      ${supportsCategory ? "mgd.model_category AS category_int" : "NULL AS category_int"}
    FROM messages m
    JOIN mailboxes mb ON mb.ROWID = m.mailbox
    LEFT JOIN subjects s ON s.ROWID = m.subject
    LEFT JOIN addresses a ON a.ROWID = m.sender
    ${supportsCategory ? "LEFT JOIN message_global_data mgd ON mgd.message_id = m.message_id AND (mgd.category_is_temporary IS NULL OR mgd.category_is_temporary = 0)" : ""}
    WHERE ${where.join(" AND ")}
    ORDER BY m.date_received DESC
    LIMIT ${limit}
  `;
  return handle.db
    .query(sql)
    .all(...params)
    .map((r) => {
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
function emailSummaryFromEnvelopeRow(r, accountDisplayName) {
  return {
    id: r.id,
    account: accountDisplayName,
    mailbox: r.mailbox,
    subject: r.subject,
    sender: r.sender,
    preview: "",
    dateReceived:
      r.dateReceived > 0 ? /* @__PURE__ */ new Date(r.dateReceived * 1e3).toISOString() : "",
    isUnread: r.isUnread,
    isFlagged: r.isFlagged,
    hasAttachments: false,
    category: r.category,
  };
}
function epochFromDateOnly(yyyyMmDd) {
  const t = Date.parse(`${yyyyMmDd}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor(t / 1e3) : 0;
}
//#endregion
//#region src/utils/htmlStripper.ts
/**
 * Convert an HTML string to plaintext using a real parser. Never uses regex;
 * regex-based stripping has well-known XSS-style bypasses (`<<script>>` etc).
 */
function stripHtml(html) {
  if (html.length === 0) return "";
  const $ = cheerio.load(html);
  $("script, style, noscript, head, title, link, meta").remove();
  return collapseWhitespace$1($("body").text() || $.root().text());
}
function collapseWhitespace$1(s) {
  return s.replace(/\s+/g, " ").trim();
}
//#endregion
//#region src/utils/plistFooter.ts
/**
 * Minimal .emlx plist footer extractor. Only reads the integer `flags` field
 * since that is all v0.1 needs. The full XML plist is small but parsing the
 * complete document would pull a heavy dependency for one integer.
 *
 * Bit layout (Mail.app, observed on V10):
 *   0x01 = read
 *   0x02 = deleted
 *   0x04 = answered
 *   0x10 = flagged
 *
 * Returns 0 if the footer is missing or malformed; callers treat 0 as
 * "unread, unflagged, not deleted". This is the safer default since
 * mis-reporting "read" hides items from the unread group, which is worse than
 * the opposite.
 */
function readFlagsFromPlist(plistBytes) {
  if (plistBytes.byteLength === 0) return 0;
  let xml;
  try {
    xml = new TextDecoder("utf-8", { fatal: false }).decode(plistBytes);
  } catch {
    return 0;
  }
  const match = xml.match(/<key>flags<\/key>\s*<integer>(-?\d+)<\/integer>/);
  if (!match?.[1]) return 0;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : 0;
}
function decodeFlags(flags) {
  return {
    read: (flags & 1) !== 0,
    deleted: (flags & 2) !== 0,
    answered: (flags & 4) !== 0,
    flagged: (flags & 16) !== 0,
  };
}
//#endregion
//#region src/domains/mail/index/emlxParser.ts
const MAX_EMLX_SIZE = 25 * 1024 * 1024;
var EmlxParseError = class extends Error {
  type;
  constructor(message, type) {
    super(message);
    this.type = type;
    this.name = "EmlxParseError";
  }
};
/**
 * Parse an .emlx file at the given path. Returns null on file size cap;
 * throws EmlxParseError on any other failure so the caller can route it to
 * the DLQ.
 */
async function parseEmlx(path, opts = {}) {
  const cap = opts.maxSizeBytes ?? MAX_EMLX_SIZE;
  let size;
  try {
    size = (await stat(path)).size;
  } catch (e) {
    throw new EmlxParseError(`stat failed: ${e.message}`, "stat_failed");
  }
  if (size > cap) return null;
  let bytes;
  try {
    bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  } catch (e) {
    throw new EmlxParseError(`read failed: ${e.message}`, "read_failed");
  }
  const newlineIdx = bytes.indexOf(10);
  if (newlineIdx === -1) throw new EmlxParseError("missing byte-count header newline", "no_header");
  const headerStr = new TextDecoder("utf-8").decode(bytes.subarray(0, newlineIdx)).trim();
  const byteCount = Number.parseInt(headerStr, 10);
  if (!Number.isFinite(byteCount) || byteCount < 0)
    throw new EmlxParseError(`invalid byte-count header "${headerStr}"`, "bad_header");
  const mimeStart = newlineIdx + 1;
  const mimeEnd = Math.min(mimeStart + byteCount, bytes.byteLength);
  const mimeBytes = bytes.subarray(mimeStart, mimeEnd);
  const plistBytes = bytes.subarray(mimeEnd);
  let parsed;
  try {
    parsed = await simpleParser(Buffer.from(mimeBytes));
  } catch (e) {
    throw new EmlxParseError(`MIME parse failed: ${e.message}`, "mime_failed");
  }
  const flags = decodeFlags(readFlagsFromPlist(plistBytes));
  const body = extractBody(parsed);
  const recipients = extractRecipients(parsed);
  const { account, mailbox } = inferAccountAndMailbox(path);
  return {
    id: inferId(path),
    emlxPath: path,
    account,
    mailbox,
    subject: parsed.subject ?? "",
    sender: parsed.from?.text ?? "",
    recipients,
    replyTo: parsed.replyTo?.text ?? "",
    messageIdHeader: parsed.messageId ?? "",
    dateSent: parsed.date?.toISOString() ?? "",
    dateReceived: pickDateReceived(parsed),
    body,
    rawHeaders: parsed.headerLines.map((h) => h.line).join("\n"),
    attachmentCount: parsed.attachments?.length ?? 0,
    isUnread: !flags.read,
    isFlagged: flags.flagged,
    isDeleted: flags.deleted,
  };
}
function extractBody(parsed) {
  if (typeof parsed.text === "string" && parsed.text.length > 0)
    return collapseWhitespace(parsed.text);
  if (typeof parsed.html === "string" && parsed.html.length > 0) return stripHtml(parsed.html);
  if (parsed.html === false && typeof parsed.textAsHtml === "string")
    return stripHtml(parsed.textAsHtml);
  return "";
}
function collapseWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}
function extractRecipients(parsed) {
  return {
    to: addressArray(parsed.to),
    cc: addressArray(parsed.cc),
    bcc: addressArray(parsed.bcc),
  };
}
function addressArray(value) {
  if (value === void 0 || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((v) => addressArray(v));
  if (typeof value === "object" && value !== null && "text" in value) {
    const text = value.text;
    if (typeof text === "string")
      return text
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
  }
  return [];
}
function pickDateReceived(parsed) {
  const received = parsed.headers.get("received");
  if (typeof received === "string") {
    const lastSemi = received.lastIndexOf(";");
    if (lastSemi !== -1) {
      const dateStr = received.slice(lastSemi + 1).trim();
      const d = new Date(dateStr);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  if (parsed.date) return parsed.date.toISOString();
  return "";
}
function inferId(path) {
  const file = basename(path);
  const stripped = file.replace(/\.partial\.emlx$/, "").replace(/\.emlx$/, "");
  const n = Number.parseInt(stripped, 10);
  if (!Number.isFinite(n))
    throw new EmlxParseError(`cannot infer integer id from filename "${file}"`, "bad_filename");
  return n;
}
/**
 * Walk forward from the V<N> directory to find the account UUID and the
 * mailbox name. The mailbox name joins every `.mbox`-ending path segment, so
 * a nested folder like `Work.mbox/Projects.mbox/Q1.mbox` reads as
 * "Work/Projects/Q1".
 */
function inferAccountAndMailbox(path) {
  const parts = path.split(sep);
  let mailIndex = -1;
  for (let i = 0; i < parts.length; i++)
    if (/^V\d+$/.test(parts[i] ?? "")) {
      mailIndex = i;
      break;
    }
  if (mailIndex === -1 || mailIndex + 1 >= parts.length)
    return {
      account: "",
      mailbox: "",
    };
  const accountRaw = parts[mailIndex + 1] ?? "";
  const account = accountRaw.split(".")[0] ?? accountRaw;
  const mailboxParts = [];
  for (let i = mailIndex + 2; i < parts.length; i++) {
    const p = parts[i] ?? "";
    if (p.endsWith(".mbox")) mailboxParts.push(p.slice(0, -5));
    else if (mailboxParts.length > 0) break;
  }
  return {
    account,
    mailbox: mailboxParts.join("/"),
  };
}
//#endregion
//#region src/domains/mail/index/dlq.ts
function recordFailure(db, args) {
  db.query(`INSERT INTO failed_index_jobs(emlx_path, account, mailbox, error_type, error_message)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(emlx_path) DO UPDATE SET
       error_type = excluded.error_type,
       error_message = excluded.error_message,
       last_seen = datetime('now'),
       attempt_count = attempt_count + 1`).run(
    args.emlxPath,
    args.account,
    args.mailbox,
    args.errorType,
    args.errorMessage,
  );
}
function countFailures(db) {
  return db.query("SELECT COUNT(*) AS n FROM failed_index_jobs").get()?.n ?? 0;
}
//#endregion
//#region src/domains/mail/index/schema.sql.ts
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS emails (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  account TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  subject TEXT,
  sender TEXT,
  content TEXT,
  date_received TEXT,
  date_sent TEXT,
  emlx_path TEXT,
  category TEXT,
  is_unread INTEGER NOT NULL DEFAULT 1,
  is_flagged INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER DEFAULT 0,
  indexed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(account, mailbox, message_id)
);

CREATE INDEX IF NOT EXISTS idx_emails_account_mailbox ON emails(account, mailbox);
CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date_received DESC);
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
CREATE INDEX IF NOT EXISTS idx_emails_path ON emails(emlx_path);
CREATE INDEX IF NOT EXISTS idx_emails_category ON emails(category);
CREATE INDEX IF NOT EXISTS idx_emails_unread_date ON emails(is_unread, date_received DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
  subject, sender, content,
  content='emails',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS emails_ai AFTER INSERT ON emails BEGIN
  INSERT INTO emails_fts(rowid, subject, sender, content)
    VALUES (new.rowid, new.subject, new.sender, new.content);
END;
CREATE TRIGGER IF NOT EXISTS emails_ad AFTER DELETE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, sender, content)
    VALUES('delete', old.rowid, old.subject, old.sender, old.content);
END;
CREATE TRIGGER IF NOT EXISTS emails_au AFTER UPDATE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, sender, content)
    VALUES('delete', old.rowid, old.subject, old.sender, old.content);
  INSERT INTO emails_fts(rowid, subject, sender, content)
    VALUES (new.rowid, new.subject, new.sender, new.content);
END;

CREATE TABLE IF NOT EXISTS sync_state (
  account TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  last_sync TEXT,
  message_count INTEGER DEFAULT 0,
  PRIMARY KEY(account, mailbox)
);

CREATE TABLE IF NOT EXISTS failed_index_jobs (
  emlx_path TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  first_seen TEXT DEFAULT (datetime('now')),
  last_seen TEXT DEFAULT (datetime('now')),
  attempt_count INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_failed_jobs_mailbox ON failed_index_jobs(account, mailbox);

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_version VALUES (1);
`;
//#endregion
//#region src/domains/mail/index/diskScanner.ts
/**
 * Walk the Mail storage tree yielding .emlx files in batches. Skips
 * .partial.emlx files (they only carry attachments, the main payload is in
 * the corresponding .emlx). Validates every path stays within the Mail dir
 * to defend against symlink escapes.
 */
async function* scanEmlxFiles(opts) {
  const mailDir = detectMailDir();
  if (!mailDir) return;
  const batchSize = opts?.batchSize ?? 1e3;
  let batch = [];
  const stack = [mailDir.path];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    if (!isWithin(dir, mailDir.path)) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      const full = join(dir, name);
      if (!isWithin(full, mailDir.path)) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!name.endsWith(".emlx")) continue;
      if (name.endsWith(".partial.emlx")) continue;
      const { account, mailbox } = inferAccountAndMailbox(full);
      if (!account || !mailbox) continue;
      const stripped = name.replace(/\.emlx$/, "");
      const messageId = Number.parseInt(stripped, 10);
      if (!Number.isFinite(messageId)) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = (await Bun.file(full).stat()).mtime.getTime();
      } catch {
        mtimeMs = 0;
      }
      batch.push({
        emlxPath: full,
        account,
        mailbox,
        messageId,
        mtimeMs,
      });
      if (batch.length >= batchSize) {
        yield batch;
        batch = [];
      }
    }
  }
  if (batch.length > 0) yield batch;
}
//#endregion
//#region src/domains/mail/index/sync.ts
/**
 * Full disk-to-DB state reconciliation. Walks every .emlx file under the
 * Mail storage tree, computes NEW / DELETED / MOVED diffs against the local
 * index, and applies each diff.
 *
 * Strategy:
 * 1. Stream disk entries into a TEMP table in batches of 1000.
 * 2. Compute the three diffs via pure SQL LEFT JOINs.
 * 3. Parse + insert NEW entries, delete obsolete rows, update moved paths.
 */
async function fullSync(db, opts = {}) {
  const start = Date.now();
  const exclude = new Set(opts.excludeMailboxes ?? []);
  const cap = opts.maxEmailsPerMailbox ?? 0;
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS disk_inventory_temp (
      account TEXT NOT NULL,
      mailbox TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      emlx_path TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      PRIMARY KEY(account, mailbox, message_id)
    ) WITHOUT ROWID;
    DELETE FROM disk_inventory_temp;
  `);
  const insertTemp = db.prepare(
    "INSERT OR REPLACE INTO disk_inventory_temp(account, mailbox, message_id, emlx_path, mtime_ms) VALUES (?, ?, ?, ?, ?)",
  );
  let scanned = 0;
  for await (const batch of scanEmlxFiles({ batchSize: 1e3 })) {
    const filtered = batch.filter((e) => !exclude.has(e.mailbox));
    db.transaction((rows) => {
      for (const r of rows)
        insertTemp.run(r.account, r.mailbox, r.messageId, r.emlxPath, r.mtimeMs);
    })(filtered);
    scanned += filtered.length;
  }
  const moveStmt = db.prepare(
    "UPDATE emails SET emlx_path = ? WHERE account = ? AND mailbox = ? AND message_id = ?",
  );
  const movedRows = db
    .query(`SELECT t.account, t.mailbox, t.message_id, t.emlx_path AS new_path
       FROM disk_inventory_temp t
       JOIN emails e ON e.account = t.account AND e.mailbox = t.mailbox AND e.message_id = t.message_id
       WHERE e.emlx_path != t.emlx_path`)
    .all();
  db.transaction((rows) => {
    for (const r of rows) moveStmt.run(r.new_path, r.account, r.mailbox, r.message_id);
  })(movedRows);
  const deleted = db.run(`DELETE FROM emails WHERE rowid IN (
       SELECT e.rowid FROM emails e
       LEFT JOIN disk_inventory_temp t
         ON t.account = e.account AND t.mailbox = e.mailbox AND t.message_id = e.message_id
       WHERE t.message_id IS NULL
     )`).changes;
  const newRows = db
    .query(`
    SELECT t.account, t.mailbox, t.message_id, t.emlx_path, t.mtime_ms
    FROM disk_inventory_temp t
    LEFT JOIN emails e
      ON e.account = t.account AND e.mailbox = t.mailbox AND e.message_id = t.message_id
    WHERE e.message_id IS NULL
    ORDER BY t.account, t.mailbox, t.mtime_ms DESC
  `)
    .all();
  const insertEmail =
    db.prepare(`INSERT INTO emails (message_id, account, mailbox, subject, sender, content, date_received, date_sent, emlx_path, category, is_unread, is_flagged, attachment_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account, mailbox, message_id) DO NOTHING`);
  let inserted = 0;
  let failed = 0;
  let lastKey = null;
  let inGroupCount = 0;
  for (const r of newRows) {
    const key = `${r.account}//${r.mailbox}`;
    if (key !== lastKey) {
      lastKey = key;
      inGroupCount = 0;
    }
    if (cap > 0 && inGroupCount >= cap) continue;
    inGroupCount++;
    try {
      const parsed = await parseEmlx(r.emlx_path);
      if (!parsed) {
        recordFailure(db, {
          emlxPath: r.emlx_path,
          account: r.account,
          mailbox: r.mailbox,
          errorType: "size_cap",
          errorMessage: "exceeds 25MB cap",
        });
        failed++;
        continue;
      }
      insertEmail.run(
        parsed.id,
        parsed.account,
        parsed.mailbox,
        parsed.subject,
        parsed.sender,
        parsed.body,
        parsed.dateReceived,
        parsed.dateSent,
        parsed.emlxPath,
        null,
        parsed.isUnread ? 1 : 0,
        parsed.isFlagged ? 1 : 0,
        parsed.attachmentCount,
      );
      inserted++;
    } catch (e) {
      const err = e;
      recordFailure(db, {
        emlxPath: r.emlx_path,
        account: r.account,
        mailbox: r.mailbox,
        errorType: err instanceof EmlxParseError ? err.type : "unknown",
        errorMessage: err.message,
      });
      failed++;
    }
  }
  db.run(`INSERT INTO sync_state (account, mailbox, last_sync, message_count)
       VALUES ('__global', '__global', datetime('now'), 0)
       ON CONFLICT(account, mailbox) DO UPDATE SET last_sync = excluded.last_sync`);
  const stats = {
    scanned,
    inserted,
    deleted: typeof deleted === "number" ? deleted : 0,
    moved: movedRows.length,
    failed,
    durationMs: Date.now() - start,
  };
  logger.info("mail sync complete", { ...stats });
  return stats;
}
//#endregion
//#region src/domains/mail/index/manager.ts
let instance = null;
function getMailIndex(config) {
  if (!instance && !config)
    throw new Error("MailIndexManager not initialised; call initMailIndex(config) first");
  if (!instance && config) instance = new MailIndexManager(config);
  return instance;
}
var MailIndexManager = class {
  db;
  config;
  syncTimer = null;
  syncing = false;
  constructor(config) {
    this.config = config;
    const dbPath = join(config.indexDir, "mail.db");
    this.db = createConnection(dbPath);
    this.db.exec(SCHEMA_V1);
    logger.info("mail index opened", { path: dbPath });
  }
  getDb() {
    return this.db;
  }
  isSyncing() {
    return this.syncing;
  }
  async syncNow() {
    if (this.syncing) {
      logger.warn("mail sync already in progress, skipping");
      return {
        scanned: 0,
        inserted: 0,
        deleted: 0,
        moved: 0,
        failed: 0,
        durationMs: 0,
      };
    }
    this.syncing = true;
    try {
      const opts = {
        maxEmailsPerMailbox: this.config.maxEmailsPerMailbox,
        excludeMailboxes: this.config.excludeMailboxes,
      };
      return await fullSync(this.db, opts);
    } finally {
      this.syncing = false;
    }
  }
  startBackgroundSync() {
    if (this.syncTimer) return;
    this.syncNow().catch((e) => {
      logger.error("initial sync failed", { error: e.message });
    });
    this.syncTimer = setInterval(() => {
      this.syncNow().catch((e) => {
        logger.error("periodic sync failed", { error: e.message });
      });
    }, this.config.syncIntervalSeconds * 1e3);
  }
  stopBackgroundSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }
  getStatus() {
    const emailRow = this.db.query("SELECT COUNT(*) AS n FROM emails").get();
    const mailboxRow = this.db.query("SELECT COUNT(DISTINCT mailbox) AS n FROM emails").get();
    const syncRow = this.db.query("SELECT MAX(last_sync) AS last_sync FROM sync_state").get();
    const failedJobsCount = countFailures(this.db);
    let stalenessHours = null;
    if (syncRow?.last_sync) {
      const iso = `${syncRow.last_sync.replace(" ", "T")}Z`;
      const last = Date.parse(iso);
      if (Number.isFinite(last)) stalenessHours = (Date.now() - last) / 36e5;
    }
    return {
      available: true,
      path: this.dbPath(),
      emailCount: emailRow?.n ?? 0,
      mailboxCount: mailboxRow?.n ?? 0,
      lastSync: syncRow?.last_sync ?? null,
      stalenessHours,
      failedJobsCount,
      syncInProgress: this.syncing,
    };
  }
  close() {
    this.stopBackgroundSync();
    this.db.close();
  }
  dbPath() {
    return join(this.config.indexDir, "mail.db");
  }
};
//#endregion
//#region src/server/tools/mail/getEmail.ts
const inputShape$3 = {
  messageId: z
    .number()
    .int()
    .describe("Mail.app's per-mailbox integer id (from a list tool result)."),
  account: z.string().optional(),
  mailbox: z.string().optional(),
  includeRawHeaders: z.boolean().optional(),
};
const TOOL$4 = {
  name: "mail_get_email",
  description:
    "Fetch a full email by Mail.app integer id, with body, headers, and recipient list. Reads from disk via the local index when available; falls back to live Mail.app for messages not yet indexed.",
  inputShape: inputShape$3,
  domain: "mail",
  handler: async (input) => {
    const args = z.object(inputShape$3).parse(input);
    const handle = openEnvelopeIndex();
    if (!handle) return { error: "Mail data not accessible. Grant Full Disk Access and re-run." };
    try {
      const accountUuid = args.account ? await resolveAccountUuid(args.account) : null;
      if (args.account && accountUuid === void 0)
        return { error: `No account matched display name "${args.account}".` };
      const where = ["m.ROWID = ?"];
      const params = [args.messageId];
      if (accountUuid) {
        where.push("mb.url LIKE ?");
        params.push(`%://${accountUuid}/%`);
      }
      if (args.mailbox) {
        where.push("mb.url LIKE ?");
        params.push(`%/${encodeMailboxPath(args.mailbox)}`);
      }
      const categorySupported = handle.categorySupport.kind === "supported";
      const categoryJoin = categorySupported
        ? "LEFT JOIN message_global_data mgd ON mgd.message_id = m.message_id AND (mgd.category_is_temporary IS NULL OR mgd.category_is_temporary = 0)"
        : "";
      const categoryCol = categorySupported
        ? "mgd.model_category AS category_int"
        : "NULL AS category_int";
      const row = handle.db
        .query(`SELECT
            mb.url AS mailbox_url,
            m.message_id AS message_id,
            s.subject AS subject,
            a.address AS sender,
            m.date_sent AS date_sent,
            m.date_received AS date_received,
            m.read AS read,
            m.flagged AS flagged,
            ${categoryCol},
            (SELECT NULL) AS emlx_path
          FROM messages m
          JOIN mailboxes mb ON mb.ROWID = m.mailbox
          LEFT JOIN subjects s ON s.ROWID = m.subject
          LEFT JOIN addresses a ON a.ROWID = m.sender
          ${categoryJoin}
          WHERE ${where.join(" AND ")}
          LIMIT 1`)
        .get(...params);
      if (!row)
        return { error: `No message with id ${args.messageId} found in the Envelope Index.` };
      const mailboxParsed = parseMailboxUrl(row.mailbox_url);
      const accountDisplay = mailboxParsed
        ? await displayNameForUuid(mailboxParsed.uuid)
        : (args.account ?? "");
      let emlxPath = null;
      if (mailboxParsed)
        try {
          emlxPath =
            getMailIndex()
              .getDb()
              .query(
                "SELECT emlx_path FROM emails WHERE message_id = ? AND account = ? AND mailbox = ? LIMIT 1",
              )
              .get(args.messageId, mailboxParsed.uuid, mailboxParsed.mailbox)?.emlx_path ?? null;
        } catch {}
      if (emlxPath)
        try {
          const parsed = await parseEmlx(emlxPath);
          if (parsed) {
            const out = {
              id: args.messageId,
              account: accountDisplay,
              mailbox: parsed.mailbox,
              subject: parsed.subject,
              sender: parsed.sender,
              recipients: parsed.recipients,
              replyTo: parsed.replyTo,
              messageIdHeader: parsed.messageIdHeader,
              dateSent: parsed.dateSent,
              dateReceived: parsed.dateReceived,
              isUnread: parsed.isUnread,
              isFlagged: parsed.isFlagged,
              category: labelForCategoryInt(row.category_int),
              body: parsed.body,
              attachmentCount: parsed.attachmentCount,
            };
            if (args.includeRawHeaders) out.rawHeaders = parsed.rawHeaders;
            return out;
          }
        } catch {}
      const category = labelForCategoryInt(row.category_int);
      return {
        id: args.messageId,
        account: accountDisplay,
        mailbox: mailboxParsed?.mailbox ?? "",
        subject: row.subject ?? "",
        sender: row.sender ?? "",
        recipients: {
          to: [],
          cc: [],
          bcc: [],
        },
        replyTo: "",
        messageIdHeader: "",
        dateSent: row.date_sent ? /* @__PURE__ */ new Date(row.date_sent * 1e3).toISOString() : "",
        dateReceived: row.date_received
          ? /* @__PURE__ */ new Date(row.date_received * 1e3).toISOString()
          : "",
        isUnread: row.read === 0,
        isFlagged: row.flagged === 1,
        category,
        body: "",
        attachmentCount: 0,
      };
    } finally {
      handle.close();
    }
  },
};
//#endregion
//#region src/server/tools/mail/getEmails.ts
const inputShape$2 = {
  account: z.string().optional().describe("Account display name. Omit for all accounts."),
  mailbox: z.string().optional().describe("Mailbox name, e.g. 'INBOX'. Omit for all mailboxes."),
  category: z
    .enum(["primary", "transactions", "updates", "promotions", "all"])
    .optional()
    .describe("Apple Mail category filter. Requires macOS 15+ with Mail's categoriser enabled."),
  filter: z
    .enum(["all", "unread", "flagged", "today", "last_7_days"])
    .optional()
    .describe("Status / recency filter."),
  group_by: z
    .enum(["none", "unread", "category", "account"])
    .optional()
    .describe("Group the results. Default 'none' returns a flat list."),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("YYYY-MM-DD upper bound (exclusive)."),
  after: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("YYYY-MM-DD lower bound (inclusive)."),
  limit: z.number().int().min(1).max(200).optional().describe("Max emails per group. Default 50."),
};
const TOOL$3 = {
  name: "mail_get_emails",
  description:
    "List emails sorted by date received (most recent first). Supports filtering by account, mailbox, status, Apple Mail category, and date range, plus optional grouping by unread state, category, or account.",
  inputShape: inputShape$2,
  domain: "mail",
  handler: async (input) => {
    const args = z.object(inputShape$2).parse(input);
    const groupBy = args.group_by ?? "none";
    const limit = args.limit ?? 50;
    const handle = openEnvelopeIndex();
    if (!handle)
      return {
        ordering: "date_received_desc",
        emails: [],
        hint: "Mail data not accessible. Grant Full Disk Access and re-run.",
      };
    try {
      const accountUuid = args.account ? await resolveAccountUuid(args.account) : null;
      if (args.account && accountUuid === void 0)
        return {
          ordering: "date_received_desc",
          emails: [],
          hint: `No account matched display name "${args.account}".`,
        };
      const categorySupported = handle.categorySupport.kind === "supported";
      if (args.category && !categorySupported && args.category !== "all")
        return {
          ordering: "date_received_desc",
          emails: [],
          hint: "Apple Mail categories not available on this macOS version.",
        };
      const effectiveCategory = args.category && args.category !== "all" ? args.category : void 0;
      const queryLimit = groupBy === "none" ? limit : limit * 4;
      const rows = queryEmails(handle, {
        accountUuid: accountUuid ?? void 0,
        mailbox: args.mailbox,
        filter: args.filter,
        category: effectiveCategory,
        after: args.after,
        before: args.before,
        limit: queryLimit,
      });
      const summaries = await Promise.all(
        rows.map(async (r) => emailSummaryFromEnvelopeRow(r, await displayNameForUuid(r.account))),
      );
      const hint = !categorySupported
        ? "Apple Mail categories not available on this macOS version; category fields will be null."
        : void 0;
      switch (groupBy) {
        case "none":
          return {
            ordering: "date_received_desc",
            emails: summaries.slice(0, limit),
            hint,
          };
        case "unread":
          return {
            ordering: "date_received_desc",
            groups: {
              unread: summaries.filter((e) => e.isUnread).slice(0, limit),
              read: summaries.filter((e) => !e.isUnread).slice(0, limit),
            },
            hint,
          };
        case "category": {
          const groups = {
            primary: [],
            transactions: [],
            updates: [],
            promotions: [],
            uncategorised: [],
          };
          for (const e of summaries) {
            const arr = groups[e.category ?? "uncategorised"] ?? groups.uncategorised;
            if (arr && arr.length < limit) arr.push(e);
          }
          if (!categorySupported)
            return {
              ordering: "date_received_desc",
              groups: { uncategorised: groups.uncategorised },
              hint,
            };
          return {
            ordering: "date_received_desc",
            groups,
            hint,
          };
        }
        case "account": {
          const groups = {};
          for (const e of summaries) {
            const arr = (groups[e.account] ??= []);
            if (arr.length < limit) arr.push(e);
          }
          return {
            ordering: "date_received_desc",
            groups,
            hint,
          };
        }
        default:
          return {
            ordering: "date_received_desc",
            emails: summaries.slice(0, limit),
            hint,
          };
      }
    } finally {
      handle.close();
    }
  },
};
//#endregion
//#region src/server/tools/mail/listAccounts.ts
const TOOL$2 = {
  name: "mail_list_accounts",
  description:
    "List all configured Apple Mail accounts with their display names and internal UUIDs.",
  inputShape: {},
  domain: "mail",
  handler: async () => {
    return { accounts: await getAccounts() };
  },
};
//#endregion
//#region src/server/tools/mail/listMailboxes.ts
const inputShape$1 = {
  account: z.string().optional().describe("Account display name. Omit for all accounts."),
};
const TOOL$1 = {
  name: "mail_list_mailboxes",
  description:
    "List mailboxes (folders) across one or all Apple Mail accounts. Returns each mailbox's account, name, and current unread count.",
  inputShape: inputShape$1,
  domain: "mail",
  handler: async (input) => {
    const { account } = z.object(inputShape$1).parse(input);
    const handle = openEnvelopeIndex();
    if (!handle)
      return {
        mailboxes: [],
        hint: "Mail data not accessible. Grant Full Disk Access and re-run.",
      };
    try {
      const accountUuid = account ? await resolveAccountUuid(account) : null;
      if (account && accountUuid === void 0)
        return {
          mailboxes: [],
          hint: `No account matched display name "${account}".`,
        };
      const rows = listMailboxes(handle.db, accountUuid ?? void 0);
      const mailboxes = [];
      for (const r of rows)
        mailboxes.push({
          account: await displayNameForUuid(r.account),
          name: r.name,
          unreadCount: r.unreadCount,
        });
      return { mailboxes };
    } finally {
      handle.close();
    }
  },
};
//#endregion
//#region src/domains/mail/index/search.ts
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
function sanitiseFtsQuery(raw) {
  if (raw.length === 0) return "";
  const balanced = (raw.match(/"/g) ?? []).length % 2 === 0 ? raw : raw.replace(/"/g, "");
  const out = [];
  const re = /"[^"]+"|\S+/g;
  let m;
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
function searchEmails(db, opts) {
  const sanitised = sanitiseFtsQuery(opts.query);
  if (sanitised.length === 0) return [];
  let ftsQuery;
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
  const where = ["emails_fts MATCH ?"];
  const params = [ftsQuery];
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
      ${opts.highlight ? "snippet(emails_fts, 2, '**', '**', '...', 32)" : "snippet(emails_fts, 2, '', '', '...', 32)"} AS snippet,
      bm25(emails_fts, 1.0, 0.5, 2.0) AS bm25
    FROM emails e
    JOIN emails_fts ON emails_fts.rowid = e.rowid
    WHERE ${where.join(" AND ")}
    ORDER BY bm25 ASC, e.date_received DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);
  let rows;
  try {
    rows = db.query(sql).all(...params);
  } catch (e) {
    const msg = e.message;
    if (!/syntax error/i.test(msg)) throw e;
    const safe = sanitised
      .split(/\s+/)
      .map((t) => (FTS_OPERATORS.has(t) ? t : `"${t.replace(/"/g, "")}"`))
      .join(" ");
    params[0] = scopedQuery(opts.scope, safe);
    rows = db.query(sql).all(...params);
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
    category: r.category ?? null,
    snippet: r.snippet,
    bm25Score: r.bm25,
  }));
}
function scopedQuery(scope, q) {
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
//#endregion
//#region src/server/tools/mail/search.ts
const inputShape = {
  query: z
    .string()
    .min(1)
    .describe("FTS5 search query. Supports phrases, AND/OR/NOT, and trailing * prefix."),
  scope: z.enum(["all", "subject", "sender", "body"]).optional(),
  account: z.string().optional(),
  mailbox: z.string().optional(),
  category: z.enum(["primary", "transactions", "updates", "promotions", "all"]).optional(),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  after: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  highlight: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
};
const TOOL = {
  name: "mail_search",
  description:
    "Full-text search across indexed email subject, sender, and body. Sorted by BM25 relevance, then date received. Optional scope, account, mailbox, category, and date range filters.",
  inputShape,
  domain: "mail",
  handler: async (input) => {
    const args = z.object(inputShape).parse(input);
    let index;
    try {
      index = getMailIndex();
    } catch {
      return {
        results: [],
        hint: "Mail index not initialised yet.",
      };
    }
    const accountUuid = args.account ? await resolveAccountUuid(args.account) : null;
    if (args.account && accountUuid === void 0)
      return {
        results: [],
        hint: `No account matched display name "${args.account}".`,
      };
    const effectiveCategory = args.category && args.category !== "all" ? args.category : void 0;
    const rawResults = searchEmails(index.getDb(), {
      query: args.query,
      scope: args.scope,
      account: accountUuid ?? void 0,
      mailbox: args.mailbox,
      category: effectiveCategory,
      before: args.before,
      after: args.after,
      highlight: args.highlight,
      limit: args.limit,
      offset: args.offset,
    });
    const results = await Promise.all(
      rawResults.map(async (r) => ({
        ...r,
        account: await displayNameForUuid(r.account),
      })),
    );
    return {
      ordering: "bm25_then_date_received_desc",
      results,
      totalMatching: results.length,
    };
  },
};
//#endregion
//#region src/domains/mail/plugin.ts
let initialised = false;
function buildMailPlugin(config) {
  if (!initialised) {
    const indexDir = config.index.path || DEFAULT_INDEX_DIR;
    getMailIndex({
      indexDir,
      maxEmailsPerMailbox: config.mail.max_emails_per_mailbox,
      excludeMailboxes: config.mail.exclude_mailboxes,
      syncIntervalSeconds: config.mail.sync_interval_seconds,
    }).startBackgroundSync();
    initialised = true;
    logger.info("mail plugin initialised", { indexDir });
  }
  return {
    name: "mail",
    tools: [TOOL$2, TOOL$1, TOOL$3, TOOL$4, TOOL],
    async getIndexStatus() {
      try {
        return getMailIndex().getStatus();
      } catch (e) {
        return {
          available: false,
          reason: e.message,
        };
      }
    },
  };
}
//#endregion
export { buildMailPlugin };
