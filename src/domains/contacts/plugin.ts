import type { DomainIndexStatus, DomainPlugin } from "../../types.ts";
import { detectSources } from "./addressBook.ts";
import { TOOL as getTool } from "../../server/tools/contacts/get.ts";
import { TOOL as listTool } from "../../server/tools/contacts/list.ts";
import { TOOL as searchTool } from "../../server/tools/contacts/search.ts";

export function buildContactsPlugin(): DomainPlugin {
  return {
    name: "contacts",
    tools: [listTool, getTool, searchTool],
    getIndexStatus(): Promise<DomainIndexStatus> {
      const sources = detectSources();
      if (sources.length === 0) {
        return Promise.resolve({
          available: false,
          reason: "AddressBook sources not accessible (Full Disk Access required).",
        });
      }
      return Promise.resolve({
        available: true,
        sourceCount: sources.length,
        sources: sources.map((s) => s.uuid),
      });
    },
  };
}
