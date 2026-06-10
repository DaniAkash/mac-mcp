import type { Database } from "bun:sqlite";

export interface DlqEntry {
  emlx_path: string;
  account: string;
  mailbox: string;
  error_type: string;
  error_message: string;
  first_seen: string;
  last_seen: string;
  attempt_count: number;
}

export function recordFailure(
  db: Database,
  args: {
    emlxPath: string;
    account: string;
    mailbox: string;
    errorType: string;
    errorMessage: string;
  },
): void {
  db.query(
    `INSERT INTO failed_index_jobs(emlx_path, account, mailbox, error_type, error_message)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(emlx_path) DO UPDATE SET
       error_type = excluded.error_type,
       error_message = excluded.error_message,
       last_seen = datetime('now'),
       attempt_count = attempt_count + 1`,
  ).run(args.emlxPath, args.account, args.mailbox, args.errorType, args.errorMessage);
}

export function clearFailure(db: Database, emlxPath: string): void {
  db.query("DELETE FROM failed_index_jobs WHERE emlx_path = ?").run(emlxPath);
}

export function countFailures(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS n FROM failed_index_jobs").get() as { n: number } | null;
  return row?.n ?? 0;
}

export function listFailures(db: Database, limit = 50): DlqEntry[] {
  return db
    .query(
      "SELECT emlx_path, account, mailbox, error_type, error_message, first_seen, last_seen, attempt_count FROM failed_index_jobs ORDER BY last_seen DESC LIMIT ?",
    )
    .all(limit) as DlqEntry[];
}
