import { defineCommand } from "citty";

export const indexCommand = defineCommand({
  meta: {
    name: "index",
    description: "Bulk-build domain indexes. No-op in v0.1; implemented in the mail domain PR.",
  },
  args: {
    domain: {
      type: "string",
      description: "Comma-separated list of domains to index. Defaults to all enabled.",
    },
  },
  run() {
    process.stderr.write("no domain indexes are wired up yet; this command is a placeholder.\n");
  },
});
