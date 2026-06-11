import { z } from "zod";
import { listEvents } from "../../../domains/calendar/calendarDb.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  calendar: z
    .string()
    .optional()
    .describe("Calendar UUID (from calendar_list_calendars). Omit for all calendars merged."),
  after: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("YYYY-MM-DD lower bound (inclusive) on event start_date."),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("YYYY-MM-DD upper bound (exclusive) on event start_date."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Max events to return. Default 50, hard cap 200."),
};

export const TOOL: ToolModule = {
  name: "calendar_list_events",
  description:
    "List events sorted by start time. Optional calendar UUID filter and YYYY-MM-DD date bounds. Returns summary records; use calendar_get_event for the full body.",
  inputShape,
  domain: "calendar",
  handler: (input) => {
    const args = z.object(inputShape).parse(input);
    return Promise.resolve(
      listEvents({
        calendar: args.calendar,
        after: args.after,
        before: args.before,
        limit: args.limit,
      }),
    );
  },
};
