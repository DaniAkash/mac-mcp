import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, test } from "bun:test";
import { loadConfig } from "../../src/config/config.ts";
import { buildRegistry, _resetDomainLoadersForTests } from "../../src/server/registry.ts";

test("empty registry: no tools, only the index://status resource", async () => {
  _resetDomainLoadersForTests();
  const config = loadConfig({ skipFile: true, skipEnv: true });
  const server = new McpServer(
    { name: "mac-mcp-test", version: "0.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  const registry = await buildRegistry(server, config);
  expect(registry.toolNames).toEqual([]);
  expect(registry.resourceUris).toEqual(["index://status"]);
  expect(registry.plugins).toEqual([]);
});

test("empty registry: status resource body is empty JSON object", async () => {
  _resetDomainLoadersForTests();
  const { readIndexStatus } = await import("../../src/server/resources/indexStatus.ts");
  const snapshot = await readIndexStatus([]);
  expect(snapshot).toEqual({});
});
