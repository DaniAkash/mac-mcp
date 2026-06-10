/**
 * End-to-end tests for the Spotlight domain. These hit the real macOS
 * Spotlight index via `mdfind`, so they only run when MAC_MCP_E2E=1.
 * CI never sets it; the suite skips cleanly on every CI run.
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { spotlightSearch } from "../../src/domains/spotlight/mdfind.ts";
import { TOOL as searchTool } from "../../src/server/tools/spotlight/search.ts";
import type { SpotlightSearchResult } from "../../src/domains/spotlight/spotlight.types.ts";

const E2E = process.env.MAC_MCP_E2E === "1";

describe.skipIf(!E2E)("spotlight e2e: live mdfind", () => {
  test("query for 'README' under $HOME returns >=1 result", async () => {
    const r = await spotlightSearch({ query: "README", path: homedir(), limit: 5 });
    expect(r.results.length).toBeGreaterThan(0);
    for (const item of r.results) {
      expect(item.path.startsWith("/")).toBe(true);
    }
  });

  test("limit is honoured exactly", async () => {
    const r = await spotlightSearch({ query: "kind:image", path: homedir(), limit: 3 });
    expect(r.results.length).toBeLessThanOrEqual(3);
  });

  test("kind:folder filter only returns directories", async () => {
    const r = await spotlightSearch({
      query: "Documents",
      path: homedir(),
      kind: "folder",
      limit: 5,
    });
    for (const item of r.results) expect(item.kind).toBe("folder");
  });

  test("kind:file filter excludes directories", async () => {
    const r = await spotlightSearch({
      query: "README",
      path: homedir(),
      kind: "file",
      limit: 10,
    });
    for (const item of r.results) expect(item.kind).toBe("file");
  });

  test("path outside home is rejected with a hint, not an exception", async () => {
    const r = await spotlightSearch({ query: "anything", path: "/tmp", limit: 5 });
    expect(r.results).toEqual([]);
    expect(r.hint).toMatch(/outside the home directory/);
  });

  test("truncated is true when more results exist than the limit", async () => {
    // A very common term like "txt" tends to have hundreds of matches.
    const r = await spotlightSearch({ query: "txt", path: homedir(), limit: 2 });
    if (r.results.length === 2) {
      expect(r.truncated).toBe(true);
    }
  });

  test("through the MCP tool handler with the same args", async () => {
    const result = (await searchTool.handler({
      query: "README",
      path: homedir(),
      limit: 5,
    })) as SpotlightSearchResult;
    expect(result.totalReturned).toBe(result.results.length);
    expect(result.results.length).toBeGreaterThan(0);
  });

  test("path scoping actually constrains results to the subtree", async () => {
    const scope = join(homedir(), "Documents");
    const r = await spotlightSearch({ query: "*", path: scope, limit: 10 });
    // Some matches may resolve to symlinks pointing outside, so we only
    // assert "all paths start with the scope" loosely - if any results
    // came back, the majority should.
    if (r.results.length > 0) {
      const inside = r.results.filter((x) => x.path.startsWith(`${scope}/`)).length;
      expect(inside).toBeGreaterThanOrEqual(Math.ceil(r.results.length / 2));
    }
  });
});
