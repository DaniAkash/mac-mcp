import { coreDataDateToIso } from "../../utils/coreDataDate.ts";
import type { ContactFull, ContactSummary } from "./contacts.types.ts";

export { coreDataDateToIso };

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
 * good enough for personal-use lookups:
 *
 * - When AddressBook parsed the number (countryCode + areaCode +
 *   localNumber are all set), returns strict E.164 (`+CCDDDDDDDD`, plus
 *   `;ext=N` when an extension is set).
 * - Otherwise, strips whitespace and `- ( ) .` from the display value and
 *   returns whatever survives. Non-digit characters can come through here:
 *   vanity numbers like `1-800-MY-APPLE` intentionally land as
 *   `1800MYAPPLE` so the value remains recognisable to the user.
 * - Returns the empty string only when the input is null or empty.
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
 * Pivot a GROUP_CONCAT'd string back into a list of values. Items are
 * separated by ASCII RS (0x1E) - that is the separator we chose for the
 * SQL aggregate so commas and other "normal" punctuation in real data
 * never collide with the delimiter.
 */
export function pivotPipeEncoded(value: string | null): string[] {
  if (!value) return [];
  return value.split("\x1E").filter((s) => s.length > 0);
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
