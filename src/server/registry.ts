import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config/configSchema.ts";
import type { DomainLoader, DomainName, DomainPlugin } from "../types.ts";
import { logger } from "../utils/logger.ts";
import { safeStringify } from "../utils/json.ts";
import { INDEX_STATUS_URI, readIndexStatus } from "./resources/indexStatus.ts";
import { isWriteToolName } from "./readOnly.ts";

/**
 * Static map of domain → loader. Each domain PR adds its entry; in PR 1 the
 * map is empty so an empty registry is the steady-state.
 */
const DOMAIN_LOADERS: Partial<Record<DomainName, DomainLoader>> = {};

export interface Registry {
  plugins: DomainPlugin[];
  toolNames: string[];
  resourceUris: string[];
}

export async function buildRegistry(server: McpServer, config: Config): Promise<Registry> {
  const plugins: DomainPlugin[] = [];

  for (const domain of config.domains.enabled) {
    const loader = DOMAIN_LOADERS[domain];
    if (!loader) {
      logger.debug(`domain "${domain}" enabled in config but no plugin loaded yet`, { domain });
      continue;
    }
    try {
      const plugin = await loader();
      plugins.push(plugin);
    } catch (e) {
      logger.error(`failed to load domain "${domain}"`, {
        domain,
        error: (e as Error).message,
      });
    }
  }

  const toolNames: string[] = [];
  for (const plugin of plugins) {
    for (const tool of plugin.tools) {
      if (isWriteToolName(tool.name)) {
        // Belt-and-braces: the AST/regex sweep tests already prevent write
        // tools at build time. If one somehow ships, refuse to expose it.
        logger.error(`refusing to register write-prefixed tool ${tool.name}`);
        continue;
      }
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputShape,
        },
        async (args: Record<string, unknown>) => {
          const result = await tool.handler(args);
          return {
            content: [
              {
                type: "text",
                text: typeof result === "string" ? result : safeStringify(result, 1_000_000),
              },
            ],
          };
        },
      );
      toolNames.push(tool.name);
    }
  }

  const resourceUris: string[] = [];

  server.registerResource(
    "index-status",
    INDEX_STATUS_URI,
    {
      description: "Per-domain index health snapshot",
      mimeType: "application/json",
    },
    async () => {
      const data = await readIndexStatus(plugins);
      return {
        contents: [
          {
            uri: INDEX_STATUS_URI,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );
  resourceUris.push(INDEX_STATUS_URI);

  for (const plugin of plugins) {
    for (const resource of plugin.resources ?? []) {
      server.registerResource(
        resource.name,
        resource.uri,
        {
          description: resource.description,
          mimeType: resource.mimeType,
        },
        async () => {
          const data = await resource.read();
          return {
            contents: [
              {
                uri: resource.uri,
                mimeType: resource.mimeType,
                text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
              },
            ],
          };
        },
      );
      resourceUris.push(resource.uri);
    }
  }

  return { plugins, toolNames, resourceUris };
}

/** Test helper: register a domain loader at runtime (do NOT use in production code). */
export function _registerDomainLoaderForTests(name: DomainName, loader: DomainLoader): void {
  DOMAIN_LOADERS[name] = loader;
}

/** Test helper: clear all loaders. */
export function _resetDomainLoadersForTests(): void {
  for (const k of Object.keys(DOMAIN_LOADERS)) {
    delete DOMAIN_LOADERS[k as DomainName];
  }
}
