import { defineCommand } from "citty";
import { loadConfig } from "../../config/config.ts";
import { readIndexStatus } from "../../server/resources/indexStatus.ts";

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Print per-domain index health as JSON.",
  },
  async run() {
    const config = loadConfig();
    // In PR 1 no domain plugins exist yet, so the snapshot lists configured
    // domains only with no detail. PR 2 wires real Mail stats through.
    const snapshot = await readIndexStatus([]);
    const out = {
      configuredDomains: config.domains.enabled,
      indexes: snapshot,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  },
});
