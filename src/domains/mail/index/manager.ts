import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { logger } from "../../../utils/logger.ts";
import { createConnection } from "../../../utils/sqlite.ts";
import { countFailures } from "./dlq.ts";
import { SCHEMA_V1 } from "./schema.sql.ts";
import { fullSync, type SyncOpts, type SyncStats } from "./sync.ts";

export interface MailIndexConfig {
  indexDir: string;
  maxEmailsPerMailbox: number;
  excludeMailboxes: string[];
  syncIntervalSeconds: number;
}

export interface IndexStatusSnapshot {
  available: true;
  path: string;
  emailCount: number;
  mailboxCount: number;
  lastSync: string | null;
  stalenessHours: number | null;
  failedJobsCount: number;
  syncInProgress: boolean;
}

let instance: MailIndexManager | null = null;

export function getMailIndex(config?: MailIndexConfig): MailIndexManager {
  if (!instance && !config) {
    throw new Error("MailIndexManager not initialised; call initMailIndex(config) first");
  }
  if (!instance && config) {
    instance = new MailIndexManager(config);
  }
  return instance as MailIndexManager;
}

export function _resetMailIndexForTests(): void {
  if (instance) instance.close();
  instance = null;
}

class MailIndexManager {
  private readonly db: Database;
  private readonly config: MailIndexConfig;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;

  constructor(config: MailIndexConfig) {
    this.config = config;
    const dbPath = join(config.indexDir, "mail.db");
    this.db = createConnection(dbPath);
    this.db.exec(SCHEMA_V1);
    logger.info("mail index opened", { path: dbPath });
  }

  getDb(): Database {
    return this.db;
  }

  isSyncing(): boolean {
    return this.syncing;
  }

  async syncNow(): Promise<SyncStats> {
    if (this.syncing) {
      logger.warn("mail sync already in progress, skipping");
      return { scanned: 0, inserted: 0, deleted: 0, moved: 0, failed: 0, durationMs: 0 };
    }
    this.syncing = true;
    try {
      const opts: SyncOpts = {
        maxEmailsPerMailbox: this.config.maxEmailsPerMailbox,
        excludeMailboxes: this.config.excludeMailboxes,
      };
      return await fullSync(this.db, opts);
    } finally {
      this.syncing = false;
    }
  }

  startBackgroundSync(): void {
    if (this.syncTimer) return;
    void this.syncNow().catch((e) => {
      logger.error("initial sync failed", { error: (e as Error).message });
    });
    this.syncTimer = setInterval(() => {
      void this.syncNow().catch((e) => {
        logger.error("periodic sync failed", { error: (e as Error).message });
      });
    }, this.config.syncIntervalSeconds * 1000);
  }

  stopBackgroundSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  getStatus(): IndexStatusSnapshot {
    const emailRow = this.db.query("SELECT COUNT(*) AS n FROM emails").get() as {
      n: number;
    } | null;
    const mailboxRow = this.db.query("SELECT COUNT(DISTINCT mailbox) AS n FROM emails").get() as {
      n: number;
    } | null;
    const syncRow = this.db.query("SELECT MAX(last_sync) AS last_sync FROM sync_state").get() as {
      last_sync: string | null;
    } | null;
    const failedJobsCount = countFailures(this.db);
    let stalenessHours: number | null = null;
    if (syncRow?.last_sync) {
      // SQLite's datetime('now') emits "YYYY-MM-DD HH:MM:SS" (space, not T).
      // Convert to strict ISO 8601 before Date.parse so behaviour does not
      // depend on engine-specific tolerance.
      const iso = `${syncRow.last_sync.replace(" ", "T")}Z`;
      const last = Date.parse(iso);
      if (Number.isFinite(last)) {
        stalenessHours = (Date.now() - last) / 3_600_000;
      }
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

  close(): void {
    this.stopBackgroundSync();
    this.db.close();
  }

  private dbPath(): string {
    return join(this.config.indexDir, "mail.db");
  }
}

export type { MailIndexManager };
