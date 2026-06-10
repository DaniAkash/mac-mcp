import { defineCommand } from "citty";

export const rebuildCommand = defineCommand({
  meta: {
    name: "rebuild",
    description: "Delete and rebuild a domain index. (No-op in v0.1.)",
  },
  args: {
    domain: {
      type: "string",
      description: "Domain to rebuild.",
      required: true,
    },
  },
  run() {
    process.stderr.write("no domain indexes are wired up yet; this command is a placeholder.\n");
  },
});
