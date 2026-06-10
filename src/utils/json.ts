const DEFAULT_MAX_LEN = 500;

/**
 * JSON.stringify with a length cap and unprintable-binary safety. Useful for
 * log lines that quote external program output (osascript stderr, parser
 * payloads, etc.) where the full text could be enormous.
 */
export function safeStringify(value: unknown, maxLen = DEFAULT_MAX_LEN): string {
  let s: string;
  try {
    s = JSON.stringify(value, replacer);
  } catch (e) {
    s = `[unserialisable: ${(e as Error).message}]`;
  }
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}...[truncated ${s.length - maxLen}b]`;
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}
