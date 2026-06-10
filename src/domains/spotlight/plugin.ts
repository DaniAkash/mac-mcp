import type { DomainIndexStatus, DomainPlugin } from "../../types.ts";
import { TOOL as searchTool } from "../../server/tools/spotlight/search.ts";

export function buildSpotlightPlugin(): DomainPlugin {
  return {
    name: "spotlight",
    tools: [searchTool],
    getIndexStatus(): Promise<DomainIndexStatus> {
      // Spotlight maintains its own index in `mds`; we do not duplicate
      // it. Always report available - the system index is assumed present
      // on every macOS install.
      return Promise.resolve({ available: true, backed_by: "macOS Spotlight (mds)" });
    },
  };
}
