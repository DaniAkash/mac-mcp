import { Database } from "bun:sqlite";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { glob } from "node:fs/promises";
import { homedir } from "node:os";
import { detectMailDir } from "./paths.ts";

export interface PermCheck {
  name: string;
  passed: boolean;
  detail?: string;
  fix?: string;
}

/**
 * Probe Full Disk Access by attempting to read-open a system-protected SQLite.
 * Mail's `Envelope Index` is the canonical FDA litmus test on modern macOS.
 */
export async function checkFullDiskAccess(): Promise<PermCheck> {
  const mailDir = detectMailDir();
  if (!mailDir) {
    return {
      name: "Full Disk Access",
      passed: false,
      detail: "Mail data directory not found (Mail.app may not have run).",
      fix: "Open Mail.app once to initialise its storage, then re-run.",
    };
  }
  const candidates = await Array.fromAsync(glob(`${mailDir.path}/MailData/Envelope Index*`));
  const target = candidates.find((p) => p.endsWith("Envelope Index"));
  if (!target || !existsSync(target)) {
    return {
      name: "Full Disk Access",
      passed: false,
      detail: "Envelope Index not present yet.",
      fix: "Open Mail.app and let it finish indexing, then re-run.",
    };
  }
  try {
    const db = new Database(`file:${target}?mode=ro&immutable=1`, { create: false });
    db.query("SELECT 1").get();
    db.close();
    return { name: "Full Disk Access", passed: true };
  } catch (e) {
    return {
      name: "Full Disk Access",
      passed: false,
      detail: (e as Error).message,
      fix: "System Settings > Privacy & Security > Full Disk Access. add your terminal or MCP client.",
    };
  }
}

export function checkMacOsVersion(): PermCheck {
  const proc = Bun.spawnSync(["sw_vers", "-productVersion"]);
  const out = proc.stdout.toString().trim();
  if (!out) {
    return { name: "macOS version", passed: false, detail: "could not read sw_vers" };
  }
  const major = Number(out.split(".")[0]);
  const passed = Number.isFinite(major) && major >= 14;
  return {
    name: "macOS version",
    passed,
    detail: `${out} (Mail categories require 15+)`,
    fix: passed ? undefined : "macOS 14 or newer is required.",
  };
}

export function checkHomeDirWritable(): PermCheck {
  const home = homedir();
  if (!existsSync(home)) {
    return { name: "Home directory writable", passed: false, detail: `${home} not found` };
  }
  try {
    accessSync(home, fsConstants.W_OK);
    return { name: "Home directory writable", passed: true };
  } catch {
    return {
      name: "Home directory writable",
      passed: false,
      detail: `${home} exists but is not writable`,
      fix: "Check filesystem permissions on the home directory.",
    };
  }
}
