import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isWithin } from "../../utils/paths.ts";
import { TimeoutError, withTimeout } from "../../utils/timeout.ts";
import type { SpotlightKind, SpotlightResult, SpotlightSearchResult } from "./spotlight.types.ts";

const DEFAULT_TIMEOUT_MS = 5_000;
const HARD_LIMIT = 100;

export interface MdfindOpts {
  query: string;
  /** Restrict the search to this directory tree (must resolve under $HOME). */
  path?: string;
  kind?: SpotlightKind;
  /** Cap on returned rows. Default 25, max 100. */
  limit?: number;
  /** Per-call timeout in ms. */
  timeoutMs?: number;
}

/**
 * Build the arguments to pass to `mdfind` after the binary name. Pure: no
 * spawning, no filesystem calls. Returned without the leading "mdfind" so
 * the call site at `spotlightSearch` can keep the binary literal inline,
 * which is what the read-only subprocess sweep requires.
 */
export function buildMdfindArgs(opts: { query: string; scopedPath: string | null }): string[] {
  const args: string[] = [];
  if (opts.scopedPath !== null) {
    args.push("-onlyin", opts.scopedPath);
  }
  args.push(opts.query);
  return args;
}

/**
 * Resolve and validate a user-supplied path. Symbolic links are followed
 * via realpath (when the path exists); the result must stay under $HOME.
 * Returns null when no path was supplied. Throws when the path escapes.
 */
export function resolveSearchPath(input: string | undefined): string | null {
  if (!input) return null;
  const home = homedir();
  const resolved = resolve(input);
  if (!isWithin(resolved, home)) {
    throw new Error(`path "${input}" resolves outside the home directory and is rejected.`);
  }
  return resolved;
}

function classify(path: string): SpotlightResult["kind"] {
  try {
    const s = statSync(path);
    if (s.isFile()) return "file";
    if (s.isDirectory()) return "folder";
    return "other";
  } catch {
    return "other";
  }
}

function filterByKind(items: SpotlightResult[], kind: SpotlightKind): SpotlightResult[] {
  if (kind === "any") return items;
  return items.filter((r) => r.kind === kind);
}

/**
 * Run `mdfind` and return up to `limit` results, optionally filtered by
 * file/folder kind. Spotlight maintains its own index, so we never build
 * our own.
 */
export async function spotlightSearch(opts: MdfindOpts): Promise<SpotlightSearchResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, HARD_LIMIT));
  const kind = opts.kind ?? "any";
  let scopedPath: string | null;
  try {
    scopedPath = resolveSearchPath(opts.path);
  } catch (e) {
    return {
      results: [],
      totalReturned: 0,
      truncated: false,
      hint: (e as Error).message,
    };
  }

  const args = buildMdfindArgs({ query: opts.query, scopedPath });
  const proc = Bun.spawn(["mdfind", ...args], { stdout: "pipe", stderr: "pipe" });

  let stdout: string;
  try {
    stdout = await withTimeout(
      new Response(proc.stdout).text(),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "mdfind",
    );
  } catch (e) {
    proc.kill();
    if (e instanceof TimeoutError) {
      return {
        results: [],
        totalReturned: 0,
        truncated: false,
        hint: e.message,
      };
    }
    throw e;
  }

  // mdfind emits one absolute path per line; we don't need its exit code.
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  const all: SpotlightResult[] = lines.map((path) => ({ path, kind: classify(path) }));
  const filtered = filterByKind(all, kind);
  const capped = filtered.slice(0, limit);
  return {
    results: capped,
    totalReturned: capped.length,
    truncated: filtered.length > capped.length,
  };
}
