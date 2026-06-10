/**
 * Minimal .emlx plist footer extractor. Only reads the integer `flags` field
 * since that is all v0.1 needs. The full XML plist is small but parsing the
 * complete document would pull a heavy dependency for one integer.
 *
 * Bit layout (Mail.app, observed on V10):
 *   0x01 = read
 *   0x02 = deleted
 *   0x04 = answered
 *   0x10 = flagged
 *
 * Returns 0 if the footer is missing or malformed; callers treat 0 as
 * "unread, unflagged, not deleted". This is the safer default since
 * mis-reporting "read" hides items from the unread group, which is worse than
 * the opposite.
 */
export function readFlagsFromPlist(plistBytes: Uint8Array): number {
  if (plistBytes.byteLength === 0) return 0;
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: false }).decode(plistBytes);
  } catch {
    return 0;
  }
  const match = xml.match(/<key>flags<\/key>\s*<integer>(-?\d+)<\/integer>/);
  if (!match?.[1]) return 0;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : 0;
}

export interface EmlxFlags {
  read: boolean;
  flagged: boolean;
  deleted: boolean;
  answered: boolean;
}

export function decodeFlags(flags: number): EmlxFlags {
  return {
    read: (flags & 0x01) !== 0,
    deleted: (flags & 0x02) !== 0,
    answered: (flags & 0x04) !== 0,
    flagged: (flags & 0x10) !== 0,
  };
}
