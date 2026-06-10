import { DEFAULT_JXA_TIMEOUT_MS } from "../constants.ts";
import { safeStringify } from "../utils/json.ts";
import { TimeoutError, withTimeout } from "../utils/timeout.ts";

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
  /**
   * Raw JXA helper scripts (e.g. the MAIL_CORE constant) prepended to
   * `script` before invocation. Passed by content, not by name, so the
   * bundler always includes them. Callers import the core constants
   * from `src/jxa/cores/` directly.
   */
  cores?: string[];
}

/**
 * Run a JXA script via `osascript -l JavaScript`. The combined script is
 * (selected cores ++ user script). Stdout is parsed as JSON; parse failures
 * surface a truncated preview to help debugging without leaking secrets.
 */
export async function runJxa<T = unknown>(script: string, opts: RunOpts = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JXA_TIMEOUT_MS;
  const cores = (opts.cores ?? []).join("\n\n");
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
