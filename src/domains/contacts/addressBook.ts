import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createReadOnlyConnection } from "../../utils/sqlite.ts";
import {
  composeDisplayName,
  coreDataDateToIso,
  dedupContacts,
  normalisePhone,
  pivotPipeEncoded,
  unwrapLabel,
} from "./normalise.ts";
import type {
  ContactFull,
  ContactSource,
  ContactsListResult,
  ContactsSearchResult,
  ContactSummary,
  EmailEntry,
  PhoneEntry,
  PostalAddressEntry,
  UrlEntry,
} from "./contacts.types.ts";

const SOURCES_DIR = `${homedir()}/Library/Application Support/AddressBook/Sources`;

/** Z_ENT values for ABCDContact and ABCDSubscribedContact. See the audit. */
const CONTACT_ENT_VALUES = [22, 23];

/** ASCII record separator - safe pipe delimiter for SQLite GROUP_CONCAT. */
const RS = "\x1E";

const SUMMARY_COLUMNS = `
  r.Z_PK AS pk,
  r.ZUNIQUEID AS unique_id,
  r.ZFIRSTNAME AS first_name,
  r.ZLASTNAME AS last_name,
  r.ZMIDDLENAME AS middle_name,
  r.ZNICKNAME AS nickname,
  r.ZORGANIZATION AS organization,
  r.ZJOBTITLE AS job_title,
  r.ZME AS me_flag,
  r.ZMODIFICATIONDATE AS modification_date
`;

// SQLite GROUP_CONCAT preserves input row order, so we wrap each aggregate
// in a subquery that pre-orders by ZISPRIMARY DESC, ZORDERINGINDEX. Without
// this the "first" email/phone (used as primaryEmail / primaryPhone) is
// non-deterministic across runs, which makes the (displayName, primaryEmail)
// dedup key flaky and produces intermittent duplicates in contacts_list.
const SUMMARY_AGGREGATES = `
  (
    SELECT GROUP_CONCAT(addr, '${RS}') FROM (
      SELECT e.ZADDRESS AS addr
      FROM ZABCDEMAILADDRESS e
      WHERE e.ZOWNER = r.Z_PK
      ORDER BY e.ZISPRIMARY DESC, e.ZORDERINGINDEX
    )
  ) AS emails_pipe,
  (
    SELECT GROUP_CONCAT(num, '${RS}') FROM (
      SELECT p.ZFULLNUMBER AS num
      FROM ZABCDPHONENUMBER p
      WHERE p.ZOWNER = r.Z_PK
      ORDER BY p.ZISPRIMARY DESC, p.ZORDERINGINDEX
    )
  ) AS phones_pipe
`;

const CONTACT_WHERE = `r.Z_ENT IN (${CONTACT_ENT_VALUES.join(", ")})`;

interface SummaryRow {
  pk: number;
  unique_id: string | null;
  first_name: string | null;
  last_name: string | null;
  middle_name: string | null;
  nickname: string | null;
  organization: string | null;
  job_title: string | null;
  me_flag: number | null;
  modification_date: number | null;
  emails_pipe: string | null;
  phones_pipe: string | null;
}

/**
 * Discover all per-source AddressBook databases under
 * ~/Library/Application Support/AddressBook/Sources. Returns an empty array
 * when the directory does not exist or FDA has not been granted.
 */
export function detectSources(): ContactSource[] {
  if (!existsSync(SOURCES_DIR)) return [];
  let entries: string[];
  try {
    entries = readdirSync(SOURCES_DIR);
  } catch {
    return [];
  }
  const sources: ContactSource[] = [];
  for (const uuid of entries) {
    const dbPath = join(SOURCES_DIR, uuid, "AddressBook-v22.abcddb");
    if (existsSync(dbPath)) sources.push({ uuid, dbPath });
  }
  return sources;
}

function rowToSummary(row: SummaryRow, source: string): ContactSummary {
  const emails = pivotPipeEncoded(row.emails_pipe);
  const phones = pivotPipeEncoded(row.phones_pipe).map((full) =>
    normalisePhone({
      full,
      countryCode: null,
      areaCode: null,
      localNumber: null,
      extension: null,
    }),
  );
  const displayName = composeDisplayName({
    firstName: row.first_name,
    lastName: row.last_name,
    middleName: row.middle_name,
    nickname: row.nickname,
    organization: row.organization,
  });
  const summary: ContactSummary = {
    id: row.unique_id ?? `pk:${row.pk}`,
    displayName,
    sources: [source],
    isMe: (row.me_flag ?? 0) > 0,
  };
  if (row.organization) summary.organization = row.organization;
  if (row.job_title) summary.jobTitle = row.job_title;
  if (emails[0]) summary.primaryEmail = emails[0];
  if (phones[0] && phones[0].length > 0) summary.primaryPhone = phones[0];
  const modDate = coreDataDateToIso(row.modification_date);
  if (modDate) summary.modificationDate = modDate;
  return summary;
}

function querySummariesForSource(
  source: ContactSource,
  opts: { limit: number; offset: number },
): ContactSummary[] {
  const db = createReadOnlyConnection(source.dbPath);
  try {
    const rows = db
      .query(
        `SELECT ${SUMMARY_COLUMNS}, ${SUMMARY_AGGREGATES}
         FROM ZABCDRECORD r
         WHERE ${CONTACT_WHERE}
         ORDER BY COALESCE(r.ZSORTINGLASTNAME, r.ZLASTNAME, r.ZSORTINGFIRSTNAME, r.ZFIRSTNAME, r.ZORGANIZATION)
         LIMIT ? OFFSET ?`,
      )
      .all(opts.limit, opts.offset) as SummaryRow[];
    return rows.map((r) => rowToSummary(r, source.uuid));
  } finally {
    db.close();
  }
}

interface SearchOpts {
  query: string;
  field: "name" | "email" | "phone" | "all";
  limit: number;
}

function searchSummariesForSource(source: ContactSource, opts: SearchOpts): ContactSummary[] {
  const db = createReadOnlyConnection(source.dbPath);
  try {
    const like = `%${opts.query}%`;
    const lowered = opts.query.toLowerCase();
    const likeLower = `%${lowered}%`;
    const preds: string[] = [];
    const params: (string | number)[] = [];
    const namePred =
      "(COALESCE(r.ZFIRSTNAME, '') LIKE ? OR COALESCE(r.ZLASTNAME, '') LIKE ? OR COALESCE(r.ZNICKNAME, '') LIKE ? OR COALESCE(r.ZORGANIZATION, '') LIKE ?)";
    const emailPred =
      "EXISTS (SELECT 1 FROM ZABCDEMAILADDRESS e WHERE e.ZOWNER = r.Z_PK AND COALESCE(e.ZADDRESSNORMALIZED, LOWER(e.ZADDRESS)) LIKE ?)";
    const phonePred =
      // The strip chain must mirror what the TS query-side normaliser does
      // (digits-only). ZFULLNUMBER stores user-typed strings that often
      // include parens, dots, and other punctuation; without those in the
      // chain, queries like `5551234567` miss a contact stored as
      // `(555) 123-4567`.
      "EXISTS (SELECT 1 FROM ZABCDPHONENUMBER p WHERE p.ZOWNER = r.Z_PK AND (REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(p.ZFULLNUMBER, ' ', ''), '-', ''), '+', ''), '(', ''), ')', ''), '.', '') LIKE ? OR p.ZLASTFOURDIGITS LIKE ?))";

    if (opts.field === "name" || opts.field === "all") {
      preds.push(namePred);
      params.push(like, like, like, like);
    }
    if (opts.field === "email" || opts.field === "all") {
      preds.push(emailPred);
      params.push(likeLower);
    }
    if (opts.field === "phone" || opts.field === "all") {
      preds.push(phonePred);
      const stripped = opts.query.replace(/\D+/g, "");
      params.push(`%${stripped || opts.query}%`, `%${stripped || opts.query}%`);
    }
    if (preds.length === 0) return [];
    const sql = `
      SELECT ${SUMMARY_COLUMNS}, ${SUMMARY_AGGREGATES}
      FROM ZABCDRECORD r
      WHERE ${CONTACT_WHERE}
        AND (${preds.join(" OR ")})
      ORDER BY COALESCE(r.ZSORTINGLASTNAME, r.ZLASTNAME, r.ZSORTINGFIRSTNAME, r.ZFIRSTNAME, r.ZORGANIZATION)
      LIMIT ?
    `;
    const rows = db.query(sql).all(...params, opts.limit) as SummaryRow[];
    return rows.map((r) => rowToSummary(r, source.uuid));
  } finally {
    db.close();
  }
}

export interface ListOpts {
  source?: string;
  limit?: number;
  offset?: number;
}

export function listContacts(opts: ListOpts = {}): ContactsListResult {
  const sources = detectSources();
  if (sources.length === 0) {
    return {
      contacts: [],
      totalReturned: 0,
      truncated: false,
      hint: "Contacts data not accessible. Grant Full Disk Access and retry.",
    };
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const offset = Math.max(0, opts.offset ?? 0);
  const filteredSources = opts.source ? sources.filter((s) => s.uuid === opts.source) : sources;
  if (opts.source && filteredSources.length === 0) {
    return {
      contacts: [],
      totalReturned: 0,
      truncated: false,
      hint: `No source matched UUID "${opts.source}".`,
    };
  }
  // Pull `limit + offset` from each source then merge + dedup, since the
  // per-source ordering is independent of the merged ordering.
  const perSourceLimit = limit + offset;
  const all: ContactSummary[] = [];
  for (const src of filteredSources) {
    all.push(...querySummariesForSource(src, { limit: perSourceLimit, offset: 0 }));
  }
  const deduped = dedupContacts(all).sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
  );
  const sliced = deduped.slice(offset, offset + limit);
  return {
    contacts: sliced,
    totalReturned: sliced.length,
    truncated: deduped.length > offset + sliced.length,
  };
}

export interface SearchInput {
  query: string;
  field?: "name" | "email" | "phone" | "all";
  limit?: number;
}

export function searchContacts(input: SearchInput): ContactsSearchResult {
  const sources = detectSources();
  if (sources.length === 0) {
    return {
      results: [],
      totalReturned: 0,
      truncated: false,
      hint: "Contacts data not accessible. Grant Full Disk Access and retry.",
    };
  }
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const all: ContactSummary[] = [];
  for (const src of sources) {
    all.push(
      ...searchSummariesForSource(src, {
        query: input.query,
        field: input.field ?? "all",
        limit,
      }),
    );
  }
  const deduped = dedupContacts(all);
  const sliced = deduped.slice(0, limit);
  return {
    results: sliced,
    totalReturned: sliced.length,
    truncated: deduped.length > sliced.length,
  };
}

export function getContact(id: string): ContactFull | null {
  const sources = detectSources();
  for (const source of sources) {
    const db = createReadOnlyConnection(source.dbPath);
    try {
      const row = db
        .query(
          `SELECT
             ${SUMMARY_COLUMNS},
             r.ZDEPARTMENT AS department,
             r.ZTITLE AS title,
             r.ZSUFFIX AS suffix,
             r.ZBIRTHDAY AS ZBIRTHDAY,
             r.ZCREATIONDATE AS ZCREATIONDATE,
             (SELECT n.ZTEXT FROM ZABCDNOTE n WHERE n.ZCONTACT = r.Z_PK LIMIT 1) AS note
           FROM ZABCDRECORD r
           WHERE ${CONTACT_WHERE} AND r.ZUNIQUEID = ?
           LIMIT 1`,
        )
        .get(id) as
        | (SummaryRow & {
            department: string | null;
            title: string | null;
            suffix: string | null;
            ZBIRTHDAY: number | null;
            ZCREATIONDATE: number | null;
            note: string | null;
          })
        | null;
      if (!row) continue;

      const emails = db
        .query(
          "SELECT ZADDRESS AS address, ZLABEL AS label, ZISPRIMARY AS is_primary FROM ZABCDEMAILADDRESS WHERE ZOWNER = ? ORDER BY ZISPRIMARY DESC, ZORDERINGINDEX",
        )
        .all(row.pk) as { address: string | null; label: string | null; is_primary: number }[];
      const phones = db
        .query(
          "SELECT ZFULLNUMBER AS full, ZCOUNTRYCODE AS cc, ZAREACODE AS area, ZLOCALNUMBER AS local, ZEXTENSION AS ext, ZLABEL AS label, ZISPRIMARY AS is_primary FROM ZABCDPHONENUMBER WHERE ZOWNER = ? ORDER BY ZISPRIMARY DESC, ZORDERINGINDEX",
        )
        .all(row.pk) as {
        full: string | null;
        cc: string | null;
        area: string | null;
        local: string | null;
        ext: string | null;
        label: string | null;
        is_primary: number;
      }[];
      const addresses = db
        .query(
          "SELECT ZSTREET AS street, ZCITY AS city, ZSTATE AS state, ZZIPCODE AS zip, ZCOUNTRYNAME AS country, ZLABEL AS label FROM ZABCDPOSTALADDRESS WHERE ZOWNER = ?",
        )
        .all(row.pk) as {
        street: string | null;
        city: string | null;
        state: string | null;
        zip: string | null;
        country: string | null;
        label: string | null;
      }[];
      const urls = db
        .query("SELECT ZURL AS url, ZLABEL AS label FROM ZABCDURLADDRESS WHERE ZOWNER = ?")
        .all(row.pk) as { url: string | null; label: string | null }[];

      const summary = rowToSummary(row, source.uuid);
      const full: ContactFull = {
        ...summary,
        emails: emails
          .filter((e): e is { address: string; label: string | null; is_primary: number } =>
            Boolean(e.address),
          )
          .map((e): EmailEntry => {
            const entry: EmailEntry = { address: e.address };
            const label = unwrapLabel(e.label);
            if (label !== undefined) entry.label = label;
            return entry;
          }),
        phones: phones.map((p): PhoneEntry => {
          const entry: PhoneEntry = {
            normalized: normalisePhone({
              full: p.full,
              countryCode: p.cc,
              areaCode: p.area,
              localNumber: p.local,
              extension: p.ext,
            }),
            raw: p.full ?? "",
          };
          const label = unwrapLabel(p.label);
          if (label !== undefined) entry.label = label;
          return entry;
        }),
        addresses: addresses.map((a): PostalAddressEntry => {
          const entry: PostalAddressEntry = {};
          if (a.street) entry.street = a.street;
          if (a.city) entry.city = a.city;
          if (a.state) entry.state = a.state;
          if (a.zip) entry.zip = a.zip;
          if (a.country) entry.country = a.country;
          const label = unwrapLabel(a.label);
          if (label !== undefined) entry.label = label;
          return entry;
        }),
        urls: urls
          .filter((u): u is { url: string; label: string | null } => Boolean(u.url))
          .map((u): UrlEntry => {
            const entry: UrlEntry = { url: u.url };
            const label = unwrapLabel(u.label);
            if (label !== undefined) entry.label = label;
            return entry;
          }),
      };
      if (row.first_name) full.firstName = row.first_name;
      if (row.last_name) full.lastName = row.last_name;
      if (row.middle_name) full.middleName = row.middle_name;
      if (row.nickname) full.nickname = row.nickname;
      if (row.title) full.title = row.title;
      if (row.suffix) full.suffix = row.suffix;
      if (row.department) full.department = row.department;
      if (row.note) full.note = row.note;
      const birthday = coreDataDateToIso(row.ZBIRTHDAY);
      if (birthday) full.birthday = birthday;
      const creation = coreDataDateToIso(row.ZCREATIONDATE);
      if (creation) full.creationDate = creation;
      // The full SELECT does not include the aggregate pipes used by
      // rowToSummary, so primary{Email,Phone} are undefined on the inherited
      // ContactSummary fields. Backfill from the per-row queries (which are
      // already ordered by ZISPRIMARY DESC) so contacts_get and
      // contacts_list expose the same shape.
      if (!full.primaryEmail && full.emails[0]) full.primaryEmail = full.emails[0].address;
      if (!full.primaryPhone && full.phones[0]?.normalized.length) {
        full.primaryPhone = full.phones[0].normalized;
      }
      return full;
    } finally {
      db.close();
    }
  }
  return null;
}
