import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { coreDataDateToIso, dateOnlyToCoreData } from "../../utils/coreDataDate.ts";
import { createReadOnlyConnection } from "../../utils/sqlite.ts";
import type {
  CalendarEntry,
  CalendarsResult,
  EventFull,
  EventSearchResult,
  EventSummary,
  EventsResult,
} from "./calendar.types.ts";

const CALENDAR_DB_PATH = `${homedir()}/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb`;

/** Entity type 2 = Event (other values may be legacy/Reminder; we expose events only). */
const EVENT_ENTITY_TYPE = 2;

function open(): Database | null {
  if (!existsSync(CALENDAR_DB_PATH)) return null;
  try {
    return createReadOnlyConnection(CALENDAR_DB_PATH);
  } catch {
    return null;
  }
}

const SUMMARY_SELECT = `
  ci.UUID AS uuid,
  ci.summary AS summary,
  ci.description AS description,
  ci.start_date AS start_date,
  ci.end_date AS end_date,
  ci.all_day AS all_day,
  ci.url AS url,
  ci.last_modified AS last_modified,
  cal.UUID AS calendar_uuid,
  cal.title AS calendar_title,
  cal.type AS calendar_type,
  loc.title AS location_title
`;

const SUMMARY_FROM = `
  FROM CalendarItem ci
  JOIN Calendar cal ON cal.ROWID = ci.calendar_id
  LEFT JOIN Location loc ON loc.ROWID = ci.location_id
  WHERE ci.entity_type = ${EVENT_ENTITY_TYPE}
    AND ci.hidden = 0
`;

interface SummaryRow {
  uuid: string | null;
  summary: string | null;
  description: string | null;
  start_date: number | null;
  end_date: number | null;
  all_day: number | null;
  url: string | null;
  last_modified: number | null;
  calendar_uuid: string | null;
  calendar_title: string | null;
  calendar_type: string | null;
  location_title: string | null;
}

function rowToEventSummary(row: SummaryRow): EventSummary {
  const start = coreDataDateToIso(row.start_date) ?? "";
  const end = coreDataDateToIso(row.end_date) ?? "";
  const summary: EventSummary = {
    id: row.uuid ?? "",
    title: row.summary ?? "",
    calendarTitle: row.calendar_title ?? "",
    calendarType: row.calendar_type ?? "",
    start,
    end,
    allDay: (row.all_day ?? 0) > 0,
  };
  if (row.location_title) summary.location = row.location_title;
  if (row.url) summary.url = row.url;
  return summary;
}

export function listCalendars(): CalendarsResult {
  const db = open();
  if (!db) {
    return {
      calendars: [],
      hint: "Calendar store not accessible. Grant Full Disk Access and retry.",
    };
  }
  try {
    const rows = db
      .query("SELECT UUID AS uuid, title, color, type FROM Calendar ORDER BY display_order, title")
      .all() as {
      uuid: string | null;
      title: string | null;
      color: string | null;
      type: string | null;
    }[];
    const calendars: CalendarEntry[] = rows.map((r) => {
      const entry: CalendarEntry = {
        id: r.uuid ?? "",
        title: r.title ?? "",
        type: r.type ?? "",
      };
      if (r.color) entry.color = r.color;
      return entry;
    });
    return { calendars };
  } finally {
    db.close();
  }
}

export interface ListEventsOpts {
  calendar?: string;
  after?: string;
  before?: string;
  limit?: number;
}

export function listEvents(opts: ListEventsOpts = {}): EventsResult {
  const db = open();
  if (!db) {
    return {
      events: [],
      totalReturned: 0,
      truncated: false,
      hint: "Calendar store not accessible. Grant Full Disk Access and retry.",
    };
  }
  try {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.calendar) {
      where.push("cal.UUID = ?");
      params.push(opts.calendar);
    }
    if (opts.after) {
      const cd = dateOnlyToCoreData(opts.after);
      if (cd !== null) {
        where.push("ci.start_date >= ?");
        params.push(cd);
      }
    }
    if (opts.before) {
      const cd = dateOnlyToCoreData(opts.before);
      if (cd !== null) {
        where.push("ci.start_date < ?");
        params.push(cd);
      }
    }
    const extraWhere = where.length > 0 ? ` AND ${where.join(" AND ")}` : "";
    const sql = `
      SELECT ${SUMMARY_SELECT}
      ${SUMMARY_FROM}${extraWhere}
      ORDER BY ci.start_date
      LIMIT ?
    `;
    params.push(limit + 1);
    const rows = db.query(sql).all(...params) as SummaryRow[];
    const truncated = rows.length > limit;
    const capped = rows.slice(0, limit);
    return {
      events: capped.map(rowToEventSummary),
      totalReturned: capped.length,
      truncated,
    };
  } finally {
    db.close();
  }
}

export function getEvent(eventId: string): EventFull | null {
  const db = open();
  if (!db) return null;
  try {
    const row = db
      .query(
        `SELECT ${SUMMARY_SELECT}, ci.calendar_id AS calendar_id ${SUMMARY_FROM} AND ci.UUID = ? LIMIT 1`,
      )
      .get(eventId) as (SummaryRow & { calendar_id: number | null }) | null;
    if (!row) return null;
    const summary = rowToEventSummary(row);
    const full: EventFull = {
      ...summary,
      calendarId: row.calendar_uuid ?? String(row.calendar_id ?? ""),
    };
    if (row.description) full.description = row.description;
    const lastMod = coreDataDateToIso(row.last_modified);
    if (lastMod) full.lastModified = lastMod;
    return full;
  } finally {
    db.close();
  }
}

export interface SearchEventsOpts {
  query: string;
  after?: string;
  before?: string;
  limit?: number;
}

export function searchEvents(opts: SearchEventsOpts): EventSearchResult {
  const db = open();
  if (!db) {
    return {
      results: [],
      totalReturned: 0,
      truncated: false,
      hint: "Calendar store not accessible. Grant Full Disk Access and retry.",
    };
  }
  try {
    const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
    const like = `%${opts.query}%`;
    const where: string[] = [
      "(COALESCE(ci.summary, '') LIKE ? OR COALESCE(ci.description, '') LIKE ? OR COALESCE(loc.title, '') LIKE ?)",
    ];
    const params: (string | number)[] = [like, like, like];
    if (opts.after) {
      const cd = dateOnlyToCoreData(opts.after);
      if (cd !== null) {
        where.push("ci.start_date >= ?");
        params.push(cd);
      }
    }
    if (opts.before) {
      const cd = dateOnlyToCoreData(opts.before);
      if (cd !== null) {
        where.push("ci.start_date < ?");
        params.push(cd);
      }
    }
    const extraWhere = ` AND ${where.join(" AND ")}`;
    const sql = `
      SELECT ${SUMMARY_SELECT}
      ${SUMMARY_FROM}${extraWhere}
      ORDER BY ci.start_date
      LIMIT ?
    `;
    params.push(limit + 1);
    const rows = db.query(sql).all(...params) as SummaryRow[];
    const truncated = rows.length > limit;
    const capped = rows.slice(0, limit);
    return {
      results: capped.map(rowToEventSummary),
      totalReturned: capped.length,
      truncated,
    };
  } finally {
    db.close();
  }
}

export function isCalendarAvailable(): boolean {
  return existsSync(CALENDAR_DB_PATH);
}
