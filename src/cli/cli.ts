import { defineCommand, runCommand } from "citty";
import { SERVER_NAME } from "../constants.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { indexCommand } from "./commands/indexCmd.ts";
import { initCommand } from "./commands/init.ts";
import { rebuildCommand } from "./commands/rebuild.ts";
import { serveCommand } from "./commands/serve.ts";
import { statusCommand } from "./commands/status.ts";
import { getVersion } from "./version.ts";

export const mainCommand = defineCommand({
  meta: {
    name: SERVER_NAME,
    version: getVersion(),
    description: "Read-only MCP server for native macOS apps.",
  },
  subCommands: {
    serve: serveCommand,
    init: initCommand,
    status: statusCommand,
    index: indexCommand,
    rebuild: rebuildCommand,
    doctor: doctorCommand,
  },
  /** No subcommand: treat as `serve` so `bunx mac-mcp` Just Works as the MCP server. */
  async run(ctx) {
    await runCommand(serveCommand, { rawArgs: ctx.rawArgs });
  },
});
