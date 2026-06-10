import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_JXA_TIMEOUT_MS } from "../constants.ts";
import { safeStringify } from "../utils/json.ts";
import { TimeoutError, withTimeout } from "../utils/timeout.ts";

const CORES_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "cores");

export class JxaError extends Error {
  constructor(
    message: string,
    public readonly preview?: string,
  ) {
    super(message);
    this.name = "JxaError";
  }
}

export class JxaTimeoutError extends JxaError {
  constructor(ms: number) {
    super(`osascript timed out after ${ms}ms`);
    this.name = "JxaTimeoutError";
  }
}

export interface RunOpts {
  /** Per-call timeout in ms. Default 120s. */
  timeoutMs?: number;
  /** Names of per-domain cores to inject (e.g. ["mail"] loads cores/mailCore.js). */
  cores?: string[];
}

/**
 * Run a JXA script via `osascript -l JavaScript`. The combined script is
 * (selected cores ++ user script). Stdout is parsed as JSON; parse failures
 * surface a truncated preview to help debugging without leaking secrets.
 */
export async function runJxa<T = unknown>(script: string, opts: RunOpts = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JXA_TIMEOUT_MS;
  const cores = (opts.cores ?? []).map(loadCore).join("\n\n");
  const full = cores ? `${cores}\n\n${script}` : script;

  const proc = Bun.spawn(["osascript", "-l", "JavaScript", "-e", full], {
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    await withTimeout(proc.exited, timeoutMs, "osascript");
  } catch (e) {
    proc.kill();
    if (e instanceof TimeoutError) throw new JxaTimeoutError(timeoutMs);
    throw e;
  }

  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new JxaError(`osascript exited ${proc.exitCode}: ${stderr.slice(0, 500)}`, stderr);
  }

  const stdout = (await new Response(proc.stdout).text()).trim();
  if (stdout.length === 0) return undefined as T;
  try {
    return JSON.parse(stdout) as T;
  } catch (e) {
    throw new JxaError(
      `failed to parse osascript output as JSON: ${(e as Error).message}`,
      safeStringify(stdout, 500),
    );
  }
}

const coreCache = new Map<string, string>();

function loadCore(name: string): string {
  const cached = coreCache.get(name);
  if (cached !== undefined) return cached;
  const path = join(CORES_DIR, `${name}Core.js`);
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (e) {
    throw new JxaError(`cannot load JXA core "${name}" at ${path}: ${(e as Error).message}`);
  }
  coreCache.set(name, body);
  return body;
}

/**
 * Test helper: list the names of cores currently bundled. Used by the
 * read-only moat to enumerate scripts to sweep.
 */
export function listCores(): string[] {
  try {
    return readdirSync(CORES_DIR)
      .filter((f) => f.endsWith("Core.js"))
      .map((f) => f.replace(/Core\.js$/, ""));
  } catch {
    return [];
  }
}
