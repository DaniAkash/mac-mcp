import { listLists } from "../../../domains/reminders/remindersDb.ts";
import type { ToolModule } from "../../../types.ts";

export const TOOL: ToolModule = {
  name: "reminders_list_lists",
  description:
    "List every Reminders list across every account (one SQLite store per account). Includes both regular lists and Smart Lists; the `type` field distinguishes them.",
  inputShape: {},
  domain: "reminders",
  handler: () => Promise.resolve(listLists()),
};
