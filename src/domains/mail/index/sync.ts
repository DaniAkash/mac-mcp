import type { Database } from "bun:sqlite";
import { logger } from "../../../utils/logger.ts";
import { scanEmlxFiles } from "./diskScanner.ts";
import { recordFailure } from "./dlq.ts";
import { EmlxParseError, parseEmlx } from "./emlxParser.ts";

export interface SyncStats {
  scanned: number;
  inserted: number;
  deleted: number;
  moved: number;
  failed: number;
  durationMs: number;
}

export interface SyncOpts {
  /** Per-mailbox cap; 0 means uncapped. */
  maxEmailsPerMailbox?: number;
  /** Mailbox names to skip entirely. */
  excludeMailboxes?: string[];
}

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
export async function fullSync(db: Database, opts: SyncOpts = {}): Promise<SyncStats> {
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
  for await (const batch of scanEmlxFiles({ batchSize: 1000 })) {
    const filtered = batch.filter((e) => !exclude.has(e.mailbox));
    const tx = db.transaction((rows: typeof filtered) => {
      for (const r of rows) {
        insertTemp.run(r.account, r.mailbox, r.messageId, r.emlxPath, r.mtimeMs);
      }
    });
    tx(filtered);
    scanned += filtered.length;
  }

  const moveStmt = db.prepare(
    "UPDATE emails SET emlx_path = ? WHERE account = ? AND mailbox = ? AND message_id = ?",
  );
  const movedRows = db
    .query(
      `SELECT t.account, t.mailbox, t.message_id, t.emlx_path AS new_path
       FROM disk_inventory_temp t
       JOIN emails e ON e.account = t.account AND e.mailbox = t.mailbox AND e.message_id = t.message_id
       WHERE e.emlx_path != t.emlx_path`,
    )
    .all() as {
    account: string;
    mailbox: string;
    message_id: number;
    new_path: string;
  }[];
  const txMove = db.transaction((rows: typeof movedRows) => {
    for (const r of rows) moveStmt.run(r.new_path, r.account, r.mailbox, r.message_id);
  });
  txMove(movedRows);

  const deleted = db.run(
    `DELETE FROM emails WHERE rowid IN (
       SELECT e.rowid FROM emails e
       LEFT JOIN disk_inventory_temp t
         ON t.account = e.account AND t.mailbox = e.mailbox AND t.message_id = e.message_id
       WHERE t.message_id IS NULL
     )`,
  ).changes;

  const newRowsQ = `
    SELECT t.account, t.mailbox, t.message_id, t.emlx_path, t.mtime_ms
    FROM disk_inventory_temp t
    LEFT JOIN emails e
      ON e.account = t.account AND e.mailbox = t.mailbox AND e.message_id = t.message_id
    WHERE e.message_id IS NULL
    ORDER BY t.account, t.mailbox, t.mtime_ms DESC
  `;
  const newRows = db.query(newRowsQ).all() as {
    account: string;
    mailbox: string;
    message_id: number;
    emlx_path: string;
    mtime_ms: number;
  }[];

  const insertEmail = db.prepare(
    `INSERT INTO emails (message_id, account, mailbox, subject, sender, content, date_received, date_sent, emlx_path, category, is_unread, is_flagged, attachment_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account, mailbox, message_id) DO NOTHING`,
  );

  let inserted = 0;
  let failed = 0;
  let lastKey: string | null = null;
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
      const err = e as EmlxParseError | Error;
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

  db.run("UPDATE sync_state SET last_sync = datetime('now')");

  const stats: SyncStats = {
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
