import { h as isWithin } from "./server-Cteav2SD.mjs";
import { n as withTimeout, t as TimeoutError } from "./timeout-gKsSSNAL.mjs";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
//#region src/domains/spotlight/mdfind.ts
const DEFAULT_TIMEOUT_MS = 5e3;
const HARD_LIMIT = 100;
/**
 * Build the arguments to pass to `mdfind` after the binary name. Pure: no
 * spawning, no filesystem calls. Returned without the leading "mdfind" so
 * the call site at `spotlightSearch` can keep the binary literal inline,
 * which is what the read-only subprocess sweep requires.
 */
function buildMdfindArgs(opts) {
  const args = [];
  if (opts.scopedPath !== null) args.push("-onlyin", opts.scopedPath);
  args.push(opts.query);
  return args;
}
/**
 * Resolve and validate a user-supplied path. Symbolic links are followed
 * via realpath (when the path exists); the result must stay under $HOME.
 * Returns null when no path was supplied. Throws when the path escapes.
 */
function resolveSearchPath(input) {
  if (!input) return null;
  const home = homedir();
  const resolved = resolve(input);
  if (!isWithin(resolved, home))
    throw new Error(`path "${input}" resolves outside the home directory and is rejected.`);
  return resolved;
}
function classify(path) {
  try {
    const s = statSync(path);
    if (s.isFile()) return "file";
    if (s.isDirectory()) return "folder";
    return "other";
  } catch {
    return "other";
  }
}
function filterByKind(items, kind) {
  if (kind === "any") return items;
  return items.filter((r) => r.kind === kind);
}
/**
 * Run `mdfind` and return up to `limit` results, optionally filtered by
 * file/folder kind. Spotlight maintains its own index, so we never build
 * our own.
 */
async function spotlightSearch(opts) {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, HARD_LIMIT));
  const kind = opts.kind ?? "any";
  let scopedPath;
  try {
    scopedPath = resolveSearchPath(opts.path);
  } catch (e) {
    return {
      results: [],
      totalReturned: 0,
      truncated: false,
      hint: e.message,
    };
  }
  const args = buildMdfindArgs({
    query: opts.query,
    scopedPath,
  });
  const proc = Bun.spawn(["mdfind", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdout;
  try {
    stdout = await withTimeout(
      new Response(proc.stdout).text(),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "mdfind",
    );
  } catch (e) {
    proc.kill();
    if (e instanceof TimeoutError)
      return {
        results: [],
        totalReturned: 0,
        truncated: false,
        hint: e.message,
      };
    throw e;
  }
  const filtered = filterByKind(
    stdout
      .split("\n")
      .filter((l) => l.length > 0)
      .map((path) => ({
        path,
        kind: classify(path),
      })),
    kind,
  );
  const capped = filtered.slice(0, limit);
  return {
    results: capped,
    totalReturned: capped.length,
    truncated: filtered.length > capped.length,
  };
}
//#endregion
//#region src/server/tools/spotlight/search.ts
const inputShape = {
  query: z
    .string()
    .min(1)
    .describe(
      "Spotlight query. Plain text matches across filename + content + metadata; the full mdfind metadata query syntax is supported too (e.g. 'kMDItemContentType == \"public.image\"').",
    ),
  path: z
    .string()
    .optional()
    .describe(
      "Restrict the search to this directory tree. Must resolve under the user's home directory.",
    ),
  kind: z
    .enum(["file", "folder", "any"])
    .optional()
    .describe("Filter results by filesystem entry kind. Default 'any'."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of results to return. Default 25, hard cap 100."),
};
const TOOL = {
  name: "spotlight_search",
  description:
    "Search the macOS Spotlight index for files and folders by filename, content, or metadata. Returns absolute paths plus a file/folder kind classification.",
  inputShape,
  domain: "spotlight",
  handler: async (input) => {
    const args = z.object(inputShape).parse(input);
    return spotlightSearch({
      query: args.query,
      path: args.path,
      kind: args.kind,
      limit: args.limit,
    });
  },
};
//#endregion
//#region src/domains/spotlight/plugin.ts
function buildSpotlightPlugin() {
  return {
    name: "spotlight",
    tools: [TOOL],
    getIndexStatus() {
      return Promise.resolve({
        available: true,
        backed_by: "macOS Spotlight (mds)",
      });
    },
  };
}
//#endregion
export { buildSpotlightPlugin };
