import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

/**
 * Directories whose source files are forbidden from spawning anything other
 * than osascript (or, in future, the EventKit Swift helper). Tools and domain
 * modules must never invoke a write-capable shell, AppleScript, or alternate
 * binary.
 */
const SANDBOXED_DIRS = ["src/server/tools", "src/domains"];

const ALLOWED_BINARIES = new Set([
  "osascript",
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

interface SpawnHit {
  file: string;
  line: number;
  snippet: string;
}

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

function findSpawnCalls(text: string): { line: number; snippet: string }[] {
  const hits: { line: number; snippet: string }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/\bBun\.spawn(Sync)?\b/.test(line) || /child_process/.test(line)) {
      hits.push({ line: i + 1, snippet: line.trim() });
    }
  }
  return hits;
}

function extractFirstArg(snippet: string): string | null {
  // Match Bun.spawn(["foo", ...]) or Bun.spawn("foo", ...)
  const arr = snippet.match(/Bun\.spawn(?:Sync)?\s*\(\s*\[\s*["']([^"']+)["']/);
  if (arr?.[1]) return arr[1];
  const str = snippet.match(/Bun\.spawn(?:Sync)?\s*\(\s*["']([^"']+)["']/);
  if (str?.[1]) return str[1];
  return null;
}

test("AST sweep: tools and domains spawn only approved binaries", () => {
  const hits: SpawnHit[] = [];
  for (const dir of SANDBOXED_DIRS) {
    const abs = join(REPO_ROOT, dir);
    for (const file of walkTs(abs)) {
      const text = readFileSync(file, "utf8");
      for (const hit of findSpawnCalls(text)) {
        hits.push({ file, ...hit });
      }
    }
  }
  for (const hit of hits) {
    const bin = extractFirstArg(hit.snippet);
    if (bin === null) {
      throw new Error(`${hit.file}:${hit.line}. spawn call shape not recognised: ${hit.snippet}`);
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
