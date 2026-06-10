export const SCHEMA_V1 = `
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
