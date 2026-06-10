/**
 * Guard for any future write tool. v0.1 never calls this because no write
 * tools exist; the function is kept so a future write-prefixed tool can
 * import and call it as its first line. Two test sweeps (`AST` + JXA-template
 * regex) enforce the invariant from the outside.
 */
export class ReadOnlyError extends Error {
  constructor() {
    super("mac-mcp is read-only. Write operations are disabled by design.");
    this.name = "ReadOnlyError";
  }
}

export function ensureWritable(): void {
  throw new ReadOnlyError();
}

/** The list of name prefixes that mark a tool as performing a write. */
const WRITE_TOOL_PREFIXES = [
  "send_",
  "delete_",
  "move_",
  "mark_",
  "create_",
  "update_",
  "save_",
  "set_",
];

export function isWriteToolName(name: string): boolean {
  for (const p of WRITE_TOOL_PREFIXES) {
    if (name.startsWith(p)) return true;
    // Also catch domain-prefixed variants like "mail_send_..."
    if (name.includes(`_${p}`)) return true;
  }
  return false;
}
