import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Config } from "../config/configSchema.ts";
import { SERVER_NAME } from "../constants.ts";
import { logger } from "../utils/logger.ts";
import { buildRegistry, type Registry } from "./registry.ts";

export interface CreatedServer {
  server: McpServer;
  registry: Registry;
}

export async function createServer(config: Config, version: string): Promise<CreatedServer> {
  const server = new McpServer(
    { name: SERVER_NAME, version },
    { capabilities: { tools: {}, resources: {} } },
  );
  const registry = await buildRegistry(server, config);
  return { server, registry };
}

export async function startStdioServer(config: Config, version: string): Promise<void> {
  const { server, registry } = await createServer(config, version);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`${SERVER_NAME} v${version} listening`, {
    domains: registry.plugins.map((p) => p.name),
    tools: registry.toolNames.length,
    resources: registry.resourceUris.length,
  });
}
