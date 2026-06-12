/**
 * Live tests against the real Reminders store. Skipped unless MAC_MCP_E2E=1.
 *
 * Dani's Mac happens to have zero reminders, so the data-dependent
 * assertions skip gracefully; the no-data paths still exercise every SQL
 * query shape and tool handler.
 */
import { describe, expect, test } from "bun:test";
import {
  detectStores,
  getReminder,
  isRemindersAvailable,
  listLists,
  listReminders,
  searchReminders,
} from "../../src/domains/reminders/remindersDb.ts";
import { TOOL as getTool } from "../../src/server/tools/reminders/getReminder.ts";
import { TOOL as listListsTool } from "../../src/server/tools/reminders/listLists.ts";
import { TOOL as listRemindersTool } from "../../src/server/tools/reminders/listReminders.ts";
import { TOOL as searchTool } from "../../src/server/tools/reminders/search.ts";
import type {
  ListsResult,
  RemindersResult,
  RemindersSearchResult,
} from "../../src/domains/reminders/reminders.types.ts";

const E2E = process.env.MAC_MCP_E2E === "1";

describe.skipIf(!E2E)("reminders e2e", () => {
  test("at least one Reminders store is present", () => {
    expect(isRemindersAvailable()).toBe(true);
    expect(detectStores().length).toBeGreaterThan(0);
  });

  test("listLists runs and returns an array (possibly with smart lists only)", () => {
    const r = listLists();
    expect(Array.isArray(r.lists)).toBe(true);
    for (const l of r.lists) {
      expect(["list", "smart"]).toContain(l.type);
      expect(l.id.length).toBeGreaterThan(0);
    }
  });

  test("listReminders status=open runs cleanly", () => {
    const r = listReminders({ status: "open", limit: 5 });
    expect(Array.isArray(r.reminders)).toBe(true);
    for (const rem of r.reminders) expect(rem.completed).toBe(false);
  });

  test("listReminders status=completed runs cleanly", () => {
    const r = listReminders({ status: "completed", limit: 5 });
    for (const rem of r.reminders) expect(rem.completed).toBe(true);
  });

  test("searchReminders runs against every store without error", () => {
    const r = searchReminders({ query: "x", limit: 3 });
    expect(Array.isArray(r.results)).toBe(true);
  });

  test("getReminder with bogus id returns null at the function level", () => {
    expect(getReminder("not-a-real-id")).toBe(null);
  });

  test("tool handlers shape-match the underlying functions", async () => {
    const lists = (await listListsTool.handler({})) as ListsResult;
    expect(lists.lists.length).toBe(listLists().lists.length);

    const open = (await listRemindersTool.handler({ status: "open", limit: 3 })) as RemindersResult;
    expect(open.reminders.length).toBe(
      listReminders({ status: "open", limit: 3 }).reminders.length,
    );

    const search = (await searchTool.handler({ query: "x", limit: 3 })) as RemindersSearchResult;
    expect(search.results.length).toBe(searchReminders({ query: "x", limit: 3 }).results.length);

    const err = (await getTool.handler({ reminderId: "bogus" })) as { error?: string };
    expect(err.error).toBeDefined();
  });
});
