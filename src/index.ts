/**
 * Public library surface for embedding mac-mcp programmatically. Most users
 * interact via the `mac-mcp` CLI; this re-export exists for callers that want
 * to spawn the MCP server inside their own process.
 */

export { ConfigError, loadConfig } from "./config/config.ts";
export type { Config } from "./config/configSchema.ts";
export { ALL_DOMAINS, MAC_MCP_HOME, SERVER_NAME } from "./constants.ts";
export { ensureWritable, ReadOnlyError } from "./server/readOnly.ts";
export { createServer, startStdioServer } from "./server/server.ts";
export type { DomainName, DomainPlugin, ResourceModule, ToolModule } from "./types.ts";
export { getLogLevel, setLogLevel } from "./utils/logger.ts";
