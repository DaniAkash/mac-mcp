import type { DomainIndexStatus, DomainPlugin } from "../../types.ts";
import { TOOL as getTool } from "../../server/tools/reminders/getReminder.ts";
import { TOOL as listListsTool } from "../../server/tools/reminders/listLists.ts";
import { TOOL as listRemindersTool } from "../../server/tools/reminders/listReminders.ts";
import { TOOL as searchTool } from "../../server/tools/reminders/search.ts";
import { detectStores } from "./remindersDb.ts";

export function buildRemindersPlugin(): DomainPlugin {
  return {
    name: "reminders",
    tools: [listListsTool, listRemindersTool, getTool, searchTool],
    getIndexStatus(): Promise<DomainIndexStatus> {
      const stores = detectStores();
      if (stores.length === 0) {
        return Promise.resolve({
          available: false,
          reason: "Reminders stores not accessible (Full Disk Access required).",
        });
      }
      return Promise.resolve({
        available: true,
        storeCount: stores.length,
        stores: stores.map((s) => s.fileName),
      });
    },
  };
}
