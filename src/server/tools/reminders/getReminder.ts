import { z } from "zod";
import { getReminder } from "../../../domains/reminders/remindersDb.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  reminderId: z
    .string()
    .min(1)
    .describe("Reminder identifier (from a reminders_list_reminders or reminders_search result)."),
};

export const TOOL: ToolModule = {
  name: "reminders_get_reminder",
  description:
    "Fetch a full reminder by identifier, including notes, start/due/completion dates, and the all-day flag. When no store contains the id, returns an error envelope { error: string }.",
  inputShape,
  domain: "reminders",
  handler: (input) => {
    const args = z.object(inputShape).parse(input);
    const reminder = getReminder(args.reminderId);
    if (!reminder) {
      return Promise.resolve({ error: `No reminder found with id "${args.reminderId}".` });
    }
    return Promise.resolve(reminder);
  },
};
