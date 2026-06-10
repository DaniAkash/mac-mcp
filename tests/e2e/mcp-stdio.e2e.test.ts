/**
 * End-to-end test that spawns the actual `mac-mcp serve` binary, connects an
 * MCP client over stdio, and exercises tool discovery + tool calls. Verifies
 * the JSON-RPC framing, server bootstrap, and tool registration end-to-end.
 *
 * Requires Full Disk Access and a configured Mail account, so it runs only
 * when MAC_MCP_E2E=1 is set. See tests/e2e/mail-tools.e2e.test.ts for the
 * direct-handler counterpart.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const E2E = process.env.MAC_MCP_E2E === "1";

let client: Client | null = null;
let transport: StdioClientTransport | null = null;
let macMcpHome: string;

describe.skipIf(!E2E)("mcp stdio e2e: spawned server round-trip", () => {
  beforeAll(async () => {
    macMcpHome = mkdtempSync(join(tmpdir(), "mac-mcp-e2e-"));
    transport = new StdioClientTransport({
      command: "bun",
      args: ["src/bin.ts", "serve"],
      env: {
        ...(process.env as Record<string, string>),
        MAC_MCP_HOME: macMcpHome,
        // Push the auto-sync interval way out so we do not slam the user's
        // Envelope Index during a quick test run.
        MAC_MCP_MAIL_SYNC_INTERVAL_SECONDS: "86400",
        MAC_MCP_LOG_LEVEL: "error",
      },
    });
    client = new Client({ name: "mac-mcp-e2e", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);
  });
  afterAll(async () => {
    try {
      await client?.close();
    } catch {}
    try {
      await transport?.close();
    } catch {}
    rmSync(macMcpHome, { recursive: true, force: true });
  });

  test("list_tools returns the five mail tools", async () => {
    const { tools } = await client!.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("mail_list_accounts");
    expect(names).toContain("mail_list_mailboxes");
    expect(names).toContain("mail_get_emails");
    expect(names).toContain("mail_get_email");
    expect(names).toContain("mail_search");
  });

  test("list_resources includes index://status", async () => {
    const { resources } = await client!.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("index://status");
  });

  test("call mail_list_accounts: returns at least one account", async () => {
    const result = (await client!.callTool({
      name: "mail_list_accounts",
      arguments: {},
    })) as { content: { type: string; text: string }[] };
    const block = result.content[0];
    expect(block?.type).toBe("text");
    const parsed = JSON.parse(block!.text) as {
      accounts: { name: string; id: string }[];
    };
    expect(parsed.accounts.length).toBeGreaterThan(0);
  });

  test("call mail_get_emails with group_by=unread: returns the unread / read buckets", async () => {
    const result = (await client!.callTool({
      name: "mail_get_emails",
      arguments: { group_by: "unread", limit: 3 },
    })) as { content: { type: string; text: string }[] };
    const parsed = JSON.parse(result.content[0]!.text) as {
      ordering: string;
      groups: { unread: unknown[]; read: unknown[] };
    };
    expect(parsed.ordering).toBe("date_received_desc");
    expect(parsed.groups.unread).toBeDefined();
    expect(parsed.groups.read).toBeDefined();
  });

  test("read_resource index://status: returns a JSON payload with mail key", async () => {
    const result = (await client!.readResource({ uri: "index://status" })) as {
      contents: { mimeType: string; text: string }[];
    };
    const block = result.contents[0];
    expect(block?.mimeType).toBe("application/json");
    const parsed = JSON.parse(block!.text) as Record<string, unknown>;
    expect(parsed.mail).toBeDefined();
  });
});
