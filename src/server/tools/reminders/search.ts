import { z } from "zod";
import { searchReminders } from "../../../domains/reminders/remindersDb.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  query: z.string().min(1).describe("Substring matched against reminder title and notes."),
  status: z
    .enum(["open", "completed", "all"])
    .optional()
    .describe("Filter by completion status. Default 'all'."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max hits to return. Default 25, hard cap 100."),
};

export const TOOL: ToolModule = {
  name: "reminders_search",
  description:
    "Substring search across reminder title and notes, merged from every Reminders store.",
  inputShape,
  domain: "reminders",
  handler: (input) => {
    const args = z.object(inputShape).parse(input);
    return Promise.resolve(
      searchReminders({ query: args.query, status: args.status, limit: args.limit }),
    );
  },
};
