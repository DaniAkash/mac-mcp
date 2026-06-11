import type { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { coreDataDateToIso } from "../../utils/coreDataDate.ts";
import { createReadOnlyConnection } from "../../utils/sqlite.ts";
import type {
  ListsResult,
  ReminderFull,
  ReminderList,
  ReminderSummary,
  RemindersResult,
  RemindersSearchResult,
  RemindersStatus,
} from "./reminders.types.ts";

const STORES_DIR = `${homedir()}/Library/Group Containers/group.com.apple.reminders/Container_v1/Stores`;

const REMINDER_ENT = 39;
const LIST_ENTS = [3, 4]; // REMCDList + REMCDSmartList

export interface ReminderStore {
  /** Filename, e.g. "Data-local.sqlite". */
  fileName: string;
  /** Absolute path. */
  dbPath: string;
}

export function detectStores(): ReminderStore[] {
  if (!existsSync(STORES_DIR)) return [];
  let entries: string[];
  try {
    entries = readdirSync(STORES_DIR);
  } catch {
    return [];
  }
  const stores: ReminderStore[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".sqlite")) continue;
    const dbPath = join(STORES_DIR, entry);
    if (existsSync(dbPath)) stores.push({ fileName: entry, dbPath });
  }
  return stores;
}

export function isRemindersAvailable(): boolean {
  return detectStores().length > 0;
}

function open(store: ReminderStore): Database {
  return createReadOnlyConnection(store.dbPath);
}

/** ZIDENTIFIER is BLOB but stores UTF-8 text. Decode safely. */
function decodeIdentifier(value: Uint8Array | string | null): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  try {
    return new TextDecoder().decode(value);
  } catch {
    return "";
  }
}

interface ListRow {
  pk: number;
  identifier_blob: Uint8Array | null;
  name: string | null;
  smart_type: string | null;
  z_ent: number;
}

export function listLists(): ListsResult {
  const stores = detectStores();
  if (stores.length === 0) {
    return {
      lists: [],
      hint: "Reminders stores not accessible. Grant Full Disk Access and retry.",
    };
  }
  const out: ReminderList[] = [];
  for (const store of stores) {
    const db = open(store);
    try {
      const rows = db
        .query(
          `SELECT
             Z_PK AS pk,
             ZIDENTIFIER AS identifier_blob,
             ZNAME AS name,
             ZSMARTLISTTYPE AS smart_type,
             Z_ENT AS z_ent
           FROM ZREMCDBASELIST
           WHERE ZMARKEDFORDELETION = 0
             AND Z_ENT IN (${LIST_ENTS.join(", ")})
           ORDER BY ZNAME`,
        )
        .all() as ListRow[];
      for (const row of rows) {
        const id = decodeIdentifier(row.identifier_blob);
        if (!id || !row.name) continue;
        out.push({
          id,
          name: row.name,
          type: row.z_ent === 4 ? "smart" : "list",
          storeName: store.fileName,
        });
      }
    } finally {
      db.close();
    }
  }
  return { lists: out };
}

interface ReminderRow {
  pk: number;
  identifier_blob: Uint8Array | null;
  title: string | null;
  notes: string | null;
  completed: number | null;
  flagged: number | null;
  priority: number | null;
  all_day: number | null;
  due_date: number | null;
  start_date: number | null;
  completion_date: number | null;
  creation_date: number | null;
  modification_date: number | null;
  list_name: string | null;
  list_id_blob: Uint8Array | null;
}

function rowToSummary(row: ReminderRow): ReminderSummary {
  const summary: ReminderSummary = {
    id: decodeIdentifier(row.identifier_blob),
    title: row.title ?? "",
    completed: (row.completed ?? 0) > 0,
    flagged: (row.flagged ?? 0) > 0,
    priority: row.priority ?? 0,
  };
  if (row.list_name) summary.listName = row.list_name;
  const listId = decodeIdentifier(row.list_id_blob);
  if (listId) summary.listId = listId;
  const due = coreDataDateToIso(row.due_date);
  if (due) summary.dueDate = due;
  const creation = coreDataDateToIso(row.creation_date);
  if (creation) summary.creationDate = creation;
  return summary;
}

function rowToFull(row: ReminderRow): ReminderFull {
  const summary = rowToSummary(row);
  const full: ReminderFull = {
    ...summary,
    allDay: (row.all_day ?? 0) > 0,
  };
  if (row.notes) full.notes = row.notes;
  const start = coreDataDateToIso(row.start_date);
  if (start) full.startDate = start;
  const completion = coreDataDateToIso(row.completion_date);
  if (completion) full.completionDate = completion;
  const modification = coreDataDateToIso(row.modification_date);
  if (modification) full.modificationDate = modification;
  return full;
}

const REMINDER_SELECT = `
  r.Z_PK AS pk,
  r.ZIDENTIFIER AS identifier_blob,
  r.ZTITLE AS title,
  r.ZNOTES AS notes,
  r.ZCOMPLETED AS completed,
  r.ZFLAGGED AS flagged,
  r.ZPRIORITY AS priority,
  r.ZALLDAY AS all_day,
  r.ZDUEDATE AS due_date,
  r.ZSTARTDATE AS start_date,
  r.ZCOMPLETIONDATE AS completion_date,
  r.ZCREATIONDATE AS creation_date,
  r.ZLASTMODIFIEDDATE AS modification_date,
  l.ZNAME AS list_name,
  l.ZIDENTIFIER AS list_id_blob
`;

const REMINDER_FROM = `
  FROM ZREMCDREMINDER r
  LEFT JOIN ZREMCDBASELIST l ON l.Z_PK = r.ZLIST
  WHERE r.ZMARKEDFORDELETION = 0
    AND r.Z_ENT = ${REMINDER_ENT}
`;

function statusClause(status: RemindersStatus): string {
  if (status === "open") return " AND (r.ZCOMPLETED = 0 OR r.ZCOMPLETED IS NULL)";
  if (status === "completed") return " AND r.ZCOMPLETED > 0";
  return "";
}

export interface ListRemindersOpts {
  list?: string;
  status?: RemindersStatus;
  limit?: number;
}

export function listReminders(opts: ListRemindersOpts = {}): RemindersResult {
  const stores = detectStores();
  if (stores.length === 0) {
    return {
      reminders: [],
      totalReturned: 0,
      truncated: false,
      hint: "Reminders stores not accessible. Grant Full Disk Access and retry.",
    };
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const status: RemindersStatus = opts.status ?? "open";
  const all: ReminderSummary[] = [];
  for (const store of stores) {
    const db = open(store);
    try {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (opts.list) {
        where.push("l.ZIDENTIFIER = ?");
        params.push(opts.list);
      }
      const extraWhere = where.length > 0 ? ` AND ${where.join(" AND ")}` : "";
      const sql = `
        SELECT ${REMINDER_SELECT}
        ${REMINDER_FROM}${statusClause(status)}${extraWhere}
        ORDER BY r.ZDUEDATE, r.ZCREATIONDATE DESC
        LIMIT ?
      `;
      params.push(limit + 1);
      const rows = db.query(sql).all(...params) as ReminderRow[];
      all.push(...rows.map(rowToSummary));
    } finally {
      db.close();
    }
  }
  // Re-sort the merged set then cap.
  all.sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
  const truncated = all.length > limit;
  const capped = all.slice(0, limit);
  return { reminders: capped, totalReturned: capped.length, truncated };
}

export function getReminder(id: string): ReminderFull | null {
  const stores = detectStores();
  for (const store of stores) {
    const db = open(store);
    try {
      const row = db
        .query(
          `SELECT ${REMINDER_SELECT}
           ${REMINDER_FROM}
             AND r.ZIDENTIFIER = ?
           LIMIT 1`,
        )
        .get(id) as ReminderRow | null;
      if (row) return rowToFull(row);
    } finally {
      db.close();
    }
  }
  return null;
}

export interface SearchOpts {
  query: string;
  status?: RemindersStatus;
  limit?: number;
}

export function searchReminders(opts: SearchOpts): RemindersSearchResult {
  const stores = detectStores();
  if (stores.length === 0) {
    return {
      results: [],
      totalReturned: 0,
      truncated: false,
      hint: "Reminders stores not accessible. Grant Full Disk Access and retry.",
    };
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
  const status: RemindersStatus = opts.status ?? "all";
  const like = `%${opts.query}%`;
  const all: ReminderSummary[] = [];
  for (const store of stores) {
    const db = open(store);
    try {
      const sql = `
        SELECT ${REMINDER_SELECT}
        ${REMINDER_FROM}${statusClause(status)}
          AND (COALESCE(r.ZTITLE, '') LIKE ? OR COALESCE(r.ZNOTES, '') LIKE ?)
        ORDER BY r.ZDUEDATE, r.ZCREATIONDATE DESC
        LIMIT ?
      `;
      const rows = db.query(sql).all(like, like, limit + 1) as ReminderRow[];
      all.push(...rows.map(rowToSummary));
    } finally {
      db.close();
    }
  }
  const truncated = all.length > limit;
  const capped = all.slice(0, limit);
  return { results: capped, totalReturned: capped.length, truncated };
}
