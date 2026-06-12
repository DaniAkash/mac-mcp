import { listCalendars } from "../../../domains/calendar/calendarDb.ts";
import type { ToolModule } from "../../../types.ts";

export const TOOL: ToolModule = {
  name: "calendar_list_calendars",
  description:
    "List every calendar configured in Apple Calendar with its UUID, title, type (Local, CalDAV, Birthdays, Subscribed, etc.) and color.",
  inputShape: {},
  domain: "calendar",
  handler: () => Promise.resolve(listCalendars()),
};
