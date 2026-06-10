import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { detectMailDir, isWithin } from "../../../utils/paths.ts";
import { inferAccountAndMailbox } from "./emlxParser.ts";

export interface DiskEntry {
  emlxPath: string;
  account: string;
  mailbox: string;
  messageId: number;
  mtimeMs: number;
}

/**
 * Walk the Mail storage tree yielding .emlx files in batches. Skips
 * .partial.emlx files (they only carry attachments, the main payload is in
 * the corresponding .emlx). Validates every path stays within the Mail dir
 * to defend against symlink escapes.
 */
export async function* scanEmlxFiles(opts?: { batchSize?: number }): AsyncGenerator<DiskEntry[]> {
  const mailDir = detectMailDir();
  if (!mailDir) return;
  const batchSize = opts?.batchSize ?? 1000;

  let batch: DiskEntry[] = [];
  const stack: string[] = [mailDir.path];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    if (!isWithin(dir, mailDir.path)) continue;
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as unknown as Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      const full = join(dir, name);
      if (!isWithin(full, mailDir.path)) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!name.endsWith(".emlx")) continue;
      if (name.endsWith(".partial.emlx")) continue;
      const { account, mailbox } = inferAccountAndMailbox(full);
      if (!account || !mailbox) continue;
      const stripped = name.replace(/\.emlx$/, "");
      const messageId = Number.parseInt(stripped, 10);
      if (!Number.isFinite(messageId)) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = (await Bun.file(full).stat()).mtime.getTime();
      } catch {
        mtimeMs = 0;
      }
      batch.push({ emlxPath: full, account, mailbox, messageId, mtimeMs });
      if (batch.length >= batchSize) {
        yield batch;
        batch = [];
      }
    }
  }
  if (batch.length > 0) yield batch;
}
