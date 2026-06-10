import { existsSync, readdirSync, realpathSync } from "node:fs";
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
 * Best-effort symlink-aware resolve. When the path exists, this calls
 * realpathSync so symlinks are followed. When the path does not exist (e.g.
 * test fixtures, or callers checking a path before creating it), it falls
 * back to plain `resolve()` which still handles `..` traversal normalisation.
 */
function safeRealpath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Reject paths that escape the expected root. Both sides are passed through
 * realpathSync when they exist so a symlink that points outside the root
 * cannot smuggle an attacker-controlled path through. For non-existent
 * paths (test fixtures, paths about to be created) we fall back to
 * `resolve()` which still normalises `..` traversal.
 */
export function isWithin(candidate: string, root: string): boolean {
  const r1 = safeRealpath(candidate);
  const r2 = safeRealpath(root);
  if (r1 === r2) return true;
  return r1.startsWith(`${r2}/`);
}

export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return `${homedir()}${path.slice(1)}`;
  return path;
}
