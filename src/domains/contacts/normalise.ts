import type { ContactFull, ContactSummary } from "./contacts.types.ts";

const CORE_DATA_EPOCH_OFFSET_S = 978_307_200;

/**
 * Strip Apple's localised-label wrapper `_$!<Label>!$_` so consumers see a
 * plain string. Anything not matching the pattern (user-typed labels,
 * weird data) passes through verbatim. Empty strings become undefined.
 */
export function unwrapLabel(label: string | null | undefined): string | undefined {
  if (label === null || label === undefined) return undefined;
  const trimmed = label.trim();
  if (trimmed.length === 0) return undefined;
  const m = trimmed.match(/^_\$!<(.+)>!\$_$/);
  return m?.[1] ?? trimmed;
}

/**
 * Best-effort phone normalisation without pulling libphonenumber. Output is
 * good enough for personal-use lookups: prefer the parsed parts when
 * present, otherwise strip whitespace and punctuation from the display
 * value. Returns the empty string when no digits survive.
 */
export function normalisePhone(args: {
  full: string | null;
  countryCode: string | null;
  areaCode: string | null;
  localNumber: string | null;
  extension: string | null;
}): string {
  const digits = (s: string | null) => (s ?? "").replace(/\D+/g, "");
  if (args.countryCode && args.areaCode && args.localNumber) {
    const base = `+${digits(args.countryCode)}${digits(args.areaCode)}${digits(args.localNumber)}`;
    return args.extension ? `${base};ext=${digits(args.extension)}` : base;
  }
  const raw = (args.full ?? "").trim();
  if (raw.length === 0) return "";
  const cleaned = raw.replace(/[\s\-().]/g, "");
  return cleaned;
}

/** Core Data timestamp -> ISO 8601 string, or undefined when null/invalid. */
export function coreDataDateToIso(value: number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  const epochMs = (value + CORE_DATA_EPOCH_OFFSET_S) * 1000;
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export function composeDisplayName(args: {
  firstName: string | null;
  lastName: string | null;
  middleName: string | null;
  nickname: string | null;
  organization: string | null;
}): string {
  const parts = [args.firstName, args.middleName, args.lastName].filter((p): p is string =>
    Boolean(p),
  );
  if (parts.length > 0) return parts.join(" ");
  if (args.nickname) return args.nickname;
  if (args.organization) return args.organization;
  return "(no name)";
}

/**
 * Pivot a pipe-encoded GROUP_CONCAT string back into entries. Each item is
 * separated by `` (the record separator we picked for SQL), and each
 * item carries `value|label`.
 */
export function pivotPipeEncoded(value: string | null): { value: string; label?: string }[] {
  if (!value) return [];
  return value
    .split("\x1E")
    .filter((s) => s.length > 0)
    .map((item) => ({ value: item }));
}

function completenessScore(c: ContactFull): number {
  let score = 0;
  if (c.firstName) score++;
  if (c.lastName) score++;
  if (c.middleName) score++;
  if (c.nickname) score++;
  if (c.organization) score++;
  if (c.jobTitle) score++;
  if (c.title) score++;
  if (c.suffix) score++;
  if (c.department) score++;
  if (c.note) score++;
  if (c.birthday) score++;
  score += c.emails.length;
  score += c.phones.length;
  score += c.addresses.length;
  score += c.urls.length;
  return score;
}

function softKey(c: ContactSummary): string {
  return [c.displayName.toLowerCase(), c.primaryEmail?.toLowerCase() ?? ""].join("|");
}

/**
 * Merge contacts from multiple sources. Same person across two sources is
 * detected via (displayName, primaryEmail). The kept record is whichever
 * has the higher completeness score; the dropped record's source is folded
 * into `sources` on the kept one.
 */
export function dedupContacts<T extends ContactSummary | ContactFull>(input: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const c of input) {
    const key = softKey(c);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, c);
      continue;
    }
    const scoreA = "emails" in c ? completenessScore(c as ContactFull) : 0;
    const scoreB = "emails" in existing ? completenessScore(existing as ContactFull) : 0;
    const winner = scoreA >= scoreB ? c : existing;
    const loser = scoreA >= scoreB ? existing : c;
    const merged: T = {
      ...winner,
      sources: [...new Set([...winner.sources, ...loser.sources])],
      isMe: winner.isMe || loser.isMe,
    };
    byKey.set(key, merged);
  }
  return [...byKey.values()];
}
