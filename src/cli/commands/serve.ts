import { defineCommand } from "citty";
import { loadConfig } from "../../config/config.ts";
import { startStdioServer } from "../../server/server.ts";
import { setLogLevel } from "../../utils/logger.ts";
import { getVersion } from "../version.ts";

export const serveCommand = defineCommand({
  meta: {
    name: "serve",
    description: "Start the MCP server over stdio.",
  },
  args: {
    verbose: {
      type: "boolean",
      description: "Set log level to debug.",
      default: false,
    },
  },
  async run({ args }) {
    if (args.verbose) setLogLevel("debug");
    const config = loadConfig();
    await startStdioServer(config, getVersion());
    // Keep process alive. McpServer holds the stdio transport.
    await new Promise(() => {});
  },
});
