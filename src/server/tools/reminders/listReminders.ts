import { z } from "zod";
import { listReminders } from "../../../domains/reminders/remindersDb.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  list: z
    .string()
    .optional()
    .describe("Reminders list id (from reminders_list_lists). Omit for all lists merged."),
  status: z
    .enum(["open", "completed", "all"])
    .optional()
    .describe("Filter by completion status. Default 'open'."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Max reminders to return. Default 50, hard cap 200."),
};

export const TOOL: ToolModule = {
  name: "reminders_list_reminders",
  description:
    "List reminders sorted by due date ascending, with nulls last. Optional list-id filter and open/completed/all status filter (default 'open').",
  inputShape,
  domain: "reminders",
  handler: (input) => {
    const args = z.object(inputShape).parse(input);
    return Promise.resolve(
      listReminders({ list: args.list, status: args.status, limit: args.limit }),
    );
  },
};
