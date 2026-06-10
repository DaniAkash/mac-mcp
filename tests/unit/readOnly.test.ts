import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Directories whose source files are forbidden from spawning anything other
 * than osascript (or, in future, the EventKit Swift helper). Tools and domain
 * modules must never invoke a write-capable shell, AppleScript, or alternate
 * binary.
 */
const SANDBOXED_DIRS = ["src/server/tools", "src/domains"];

const ALLOWED_BINARIES = new Set([
  "osascript",
  // Spotlight's command-line interface; pure read against the system index.
  "mdfind",
  // Placeholder for the Swift helper bundled in a future PR.
  "./helpers/eventkit/dist/eventkit-helper",
]);

/**
 * Phrases that must not appear in JXA cores or builders. These are the
 * surface area of Apple Events that mutate state. If a future commit
 * introduces any of these the regex sweep fails.
 */
const FORBIDDEN_JXA_PHRASES = [
  "set readStatus",
  "set flaggedStatus",
  "move to",
  "delete()",
  "delete ",
  "send()",
  "send ",
  "make new outgoing message",
  "make new note",
  "make new event",
  "make new reminder",
  "make new person",
  "save:",
  "saveTo",
];

type Hit = { kind: "spawn" | "child_process"; file: string; line: number; snippet: string };

function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const s = statSync(path);
    if (s.isDirectory()) {
      out.push(...walkTs(path));
    } else if (s.isFile() && /\.(ts|tsx|mjs|js)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

function findSubprocessHits(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/\bBun\.spawn(Sync)?\b/.test(line)) {
      hits.push({ kind: "spawn", file, line: i + 1, snippet: line.trim() });
      continue;
    }
    // Any reference to child_process inside the sandboxed dirs is banned
    // regardless of how it is used. There is no legitimate reason for a tool
    // or domain to reach for Node's child_process API; everything goes
    // through osascript via Bun.spawn.
    if (/\bchild_process\b/.test(line)) {
      hits.push({ kind: "child_process", file, line: i + 1, snippet: line.trim() });
    }
  }
  return hits;
}

function extractSpawnBinary(snippet: string): string | null {
  // Match Bun.spawn(["foo", ...]) or Bun.spawn("foo", ...)
  const arr = snippet.match(/Bun\.spawn(?:Sync)?\s*\(\s*\[\s*["']([^"']+)["']/);
  if (arr?.[1]) return arr[1];
  const str = snippet.match(/Bun\.spawn(?:Sync)?\s*\(\s*["']([^"']+)["']/);
  if (str?.[1]) return str[1];
  return null;
}

test("subprocess sweep: tools and domains spawn only approved binaries", () => {
  const hits: Hit[] = [];
  for (const dir of SANDBOXED_DIRS) {
    const abs = join(REPO_ROOT, dir);
    for (const file of walkTs(abs)) {
      hits.push(...findSubprocessHits(file, readFileSync(file, "utf8")));
    }
  }
  for (const hit of hits) {
    if (hit.kind === "child_process") {
      throw new Error(
        `${hit.file}:${hit.line} references child_process; tools and domains must use osascript via Bun.spawn instead.\n  ${hit.snippet}`,
      );
    }
    const bin = extractSpawnBinary(hit.snippet);
    if (bin === null) {
      throw new Error(
        `${hit.file}:${hit.line} subprocess spawn shape not recognised; the sweep needs to be taught about it: ${hit.snippet}`,
      );
    }
    expect(
      ALLOWED_BINARIES.has(bin),
      `${hit.file}:${hit.line} spawns "${bin}" (allowed: ${[...ALLOWED_BINARIES].join(", ")})`,
    ).toBe(true);
  }
});

test("regex sweep: JXA cores and builders contain no write-capable phrases", () => {
  const targets = [
    ...walkTs(join(REPO_ROOT, "src/jxa/cores")),
    ...walkTs(join(REPO_ROOT, "src/jxa/builders")),
  ];
  for (const file of targets) {
    const text = readFileSync(file, "utf8");
    for (const phrase of FORBIDDEN_JXA_PHRASES) {
      expect(text.includes(phrase), `${file} contains forbidden phrase: ${phrase}`).toBe(false);
    }
  }
});
