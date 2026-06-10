import type { Database } from "bun:sqlite";
import type { MailCategory } from "../mail.types.ts";

export const CATEGORY_LABEL_BY_INT: Readonly<Record<number, MailCategory>> = {
  0: "primary",
  1: "transactions",
  2: "updates",
  3: "promotions",
};

export const CATEGORY_INT_BY_LABEL: Readonly<Record<MailCategory, number>> = {
  primary: 0,
  transactions: 1,
  updates: 2,
  promotions: 3,
};

export type CategorySupport =
  | { kind: "supported"; categoryModelVersion: number }
  | { kind: "unsupported"; reason: string };

/**
 * Probe the live Envelope Index for Apple Mail's categorisation support.
 * Cached per process; safe to call repeatedly. Three cheap queries; no
 * heavy joins. See the categories audit for the column layout this checks.
 */
export function probeCategorySupport(db: Database): CategorySupport {
  const tableRows = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='message_global_data'")
    .all() as { name: string }[];
  if (tableRows.length === 0) {
    return { kind: "unsupported", reason: "message_global_data table not present" };
  }
  const cols = db.query("PRAGMA table_info(message_global_data)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "model_category")) {
    return { kind: "unsupported", reason: "message_global_data.model_category column not present" };
  }
  const sample = db
    .query(
      "SELECT category_model_version FROM message_global_data WHERE model_category IS NOT NULL LIMIT 1",
    )
    .get() as { category_model_version: number } | null;
  if (!sample) {
    return { kind: "unsupported", reason: "no categorised messages yet" };
  }
  return { kind: "supported", categoryModelVersion: sample.category_model_version };
}

export function labelForCategoryInt(v: number | null | undefined): MailCategory | null {
  if (v === null || v === undefined) return null;
  return CATEGORY_LABEL_BY_INT[v] ?? null;
}
