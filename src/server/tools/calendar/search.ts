import { z } from "zod";
import { searchEvents } from "../../../domains/calendar/calendarDb.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  query: z
    .string()
    .min(1)
    .describe("Substring matched against event title (summary), description, and location."),
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
    .max(100)
    .optional()
    .describe("Max hits to return. Default 25, hard cap 100."),
};

export const TOOL: ToolModule = {
  name: "calendar_search",
  description:
    "Substring search across event title, description, and location. Optional YYYY-MM-DD date bounds. Sorted by start time.",
  inputShape,
  domain: "calendar",
  handler: (input) => {
    const args = z.object(inputShape).parse(input);
    return Promise.resolve(
      searchEvents({
        query: args.query,
        after: args.after,
        before: args.before,
        limit: args.limit,
      }),
    );
  },
};
