import type { DomainIndexStatus, DomainPlugin } from "../../types.ts";
import { TOOL as getEventTool } from "../../server/tools/calendar/getEvent.ts";
import { TOOL as listCalendarsTool } from "../../server/tools/calendar/listCalendars.ts";
import { TOOL as listEventsTool } from "../../server/tools/calendar/listEvents.ts";
import { TOOL as searchTool } from "../../server/tools/calendar/search.ts";
import { isCalendarAvailable } from "./calendarDb.ts";

export function buildCalendarPlugin(): DomainPlugin {
  return {
    name: "calendar",
    tools: [listCalendarsTool, listEventsTool, getEventTool, searchTool],
    getIndexStatus(): Promise<DomainIndexStatus> {
      if (!isCalendarAvailable()) {
        return Promise.resolve({
          available: false,
          reason: "Calendar store not accessible (Full Disk Access required).",
        });
      }
      return Promise.resolve({ available: true, source: "Apple Calendar group container" });
    },
  };
}
