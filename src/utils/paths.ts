import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const MAIL_ROOT = `${homedir()}/Library/Mail`;

export interface MailDir {
  version: number;
  path: string;
}

/**
 * Find the highest-versioned Mail.app storage directory, e.g. V10, V11.
 * Returns null if Mail.app has never run or Full Disk Access is missing.
 */
export function detectMailDir(): MailDir | null {
  if (!existsSync(MAIL_ROOT)) return null;
  let entries: string[];
  try {
    entries = readdirSync(MAIL_ROOT);
  } catch {
    return null;
  }
  const versions: MailDir[] = [];
  for (const entry of entries) {
    const match = entry.match(/^V(\d+)$/);
    if (!match) continue;
    const version = Number(match[1]);
    if (!Number.isFinite(version)) continue;
    versions.push({ version, path: `${MAIL_ROOT}/${entry}` });
  }
  if (versions.length === 0) return null;
  versions.sort((a, b) => b.version - a.version);
  return versions[0] ?? null;
}

/**
 * Reject paths that escape the expected root. The check is applied to the
 * resolved (symlink-followed) form of both sides so a malicious symlink
 * cannot let a watcher pull an attacker-controlled path through.
 */
export function isWithin(candidate: string, root: string): boolean {
  const r1 = resolve(candidate);
  const r2 = resolve(root);
  if (r1 === r2) return true;
  return r1.startsWith(`${r2}/`);
}

export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return `${homedir()}${path.slice(1)}`;
  return path;
}
