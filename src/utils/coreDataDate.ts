/**
 * Apple's Core Data uses a 2001-01-01 UTC epoch for timestamps (offset from
 * Unix epoch by exactly 978,307,200 seconds). Contacts, Calendar, and
 * Reminders all store dates this way; Mail V10's Envelope Index switched
 * to Unix epoch, which is why this helper does NOT live in the Mail domain.
 */
const CORE_DATA_EPOCH_OFFSET_S = 978_307_200;

/** Core Data timestamp -> ISO 8601 string, or undefined for null/invalid. */
export function coreDataDateToIso(value: number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  const epochMs = (value + CORE_DATA_EPOCH_OFFSET_S) * 1000;
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

/** YYYY-MM-DD -> Core Data epoch seconds (midnight UTC). */
export function dateOnlyToCoreData(yyyyMmDd: string): number | null {
  const t = Date.parse(`${yyyyMmDd}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.floor(t / 1000) - CORE_DATA_EPOCH_OFFSET_S;
}
