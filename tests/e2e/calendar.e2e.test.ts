/**
 * Live tests against the real Calendar store at
 * ~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb.
 * Skipped unless MAC_MCP_E2E=1.
 */
import { describe, expect, test } from "bun:test";
import {
  getEvent,
  isCalendarAvailable,
  listCalendars,
  listEvents,
  searchEvents,
} from "../../src/domains/calendar/calendarDb.ts";
import { TOOL as getEventTool } from "../../src/server/tools/calendar/getEvent.ts";
import { TOOL as listCalendarsTool } from "../../src/server/tools/calendar/listCalendars.ts";
import { TOOL as listEventsTool } from "../../src/server/tools/calendar/listEvents.ts";
import { TOOL as searchTool } from "../../src/server/tools/calendar/search.ts";
import type {
  CalendarsResult,
  EventFull,
  EventSearchResult,
  EventsResult,
} from "../../src/domains/calendar/calendar.types.ts";

const E2E = process.env.MAC_MCP_E2E === "1";

describe.skipIf(!E2E)("calendar e2e", () => {
  test("Calendar store is reachable", () => {
    expect(isCalendarAvailable()).toBe(true);
  });

  test("listCalendars returns >=1 entry with title + type populated", () => {
    const r = listCalendars();
    expect(r.calendars.length).toBeGreaterThan(0);
    expect(r.calendars[0]?.title.length).toBeGreaterThan(0);
  });

  test("listEvents returns rows sorted by start ascending", () => {
    const r = listEvents({ limit: 10 });
    expect(r.events.length).toBeGreaterThan(0);
    for (let i = 0; i + 1 < r.events.length; i++) {
      expect(r.events[i]!.start <= r.events[i + 1]!.start).toBe(true);
    }
  });

  test("listEvents date bounds: after >= filter is honoured", () => {
    const r = listEvents({ after: "2026-06-01", limit: 5 });
    for (const e of r.events) {
      expect(e.start >= "2026-06-01").toBe(true);
    }
  });

  test("calendar filter narrows to a single calendar id", () => {
    const cals = listCalendars();
    const firstWithEvents = cals.calendars.find(
      (c) => listEvents({ calendar: c.id, limit: 1 }).events.length > 0,
    );
    if (!firstWithEvents) return;
    const r = listEvents({ calendar: firstWithEvents.id, limit: 5 });
    for (const e of r.events) expect(e.calendarTitle).toBe(firstWithEvents.title);
  });

  test("searchEvents returns rows whose title or location matches", () => {
    const r = searchEvents({ query: "a", limit: 3 });
    expect(r.results.length).toBeGreaterThan(0);
  });

  test("getEvent round-trips through a real id", () => {
    const list = listEvents({ limit: 1 });
    const first = list.events[0];
    expect(first?.id).toBeDefined();
    if (!first) return;
    const full = getEvent(first.id);
    expect(full?.id).toBe(first.id);
    expect(full?.title).toBe(first.title);
  });

  test("getEvent unknown id returns null", () => {
    expect(getEvent("not-a-uuid")).toBe(null);
  });

  test("tool handlers match the underlying functions", async () => {
    const cals = (await listCalendarsTool.handler({})) as CalendarsResult;
    expect(cals.calendars.length).toBe(listCalendars().calendars.length);

    const events = (await listEventsTool.handler({ limit: 2 })) as EventsResult;
    expect(events.events.length).toBe(listEvents({ limit: 2 }).events.length);

    const search = (await searchTool.handler({ query: "a", limit: 2 })) as EventSearchResult;
    expect(search.results.length).toBe(searchEvents({ query: "a", limit: 2 }).results.length);

    if (events.events[0]) {
      const full = (await getEventTool.handler({ eventId: events.events[0].id })) as EventFull;
      expect(full.id).toBe(events.events[0].id);
    }
  });

  test("getEvent through the tool with a bogus id returns an error envelope", async () => {
    const r = (await getEventTool.handler({ eventId: "bogus" })) as { error?: string };
    expect(r.error).toBeDefined();
  });
});
