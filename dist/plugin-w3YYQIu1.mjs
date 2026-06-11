import { r as createReadOnlyConnection } from "./sqlite-BafV4e8X.mjs";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
//#region src/domains/contacts/normalise.ts
const CORE_DATA_EPOCH_OFFSET_S = 978307200;
/**
 * Strip Apple's localised-label wrapper `_$!<Label>!$_` so consumers see a
 * plain string. Anything not matching the pattern (user-typed labels,
 * weird data) passes through verbatim. Empty strings become undefined.
 */
function unwrapLabel(label) {
  if (label === null || label === void 0) return void 0;
  const trimmed = label.trim();
  if (trimmed.length === 0) return void 0;
  return trimmed.match(/^_\$!<(.+)>!\$_$/)?.[1] ?? trimmed;
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
function normalisePhone(args) {
  const digits = (s) => (s ?? "").replace(/\D+/g, "");
  if (args.countryCode && args.areaCode && args.localNumber) {
    const base = `+${digits(args.countryCode)}${digits(args.areaCode)}${digits(args.localNumber)}`;
    return args.extension ? `${base};ext=${digits(args.extension)}` : base;
  }
  const raw = (args.full ?? "").trim();
  if (raw.length === 0) return "";
  return raw.replace(/[\s\-().]/g, "");
}
/** Core Data timestamp -> ISO 8601 string, or undefined when null/invalid. */
function coreDataDateToIso(value) {
  if (value === null || value === void 0) return void 0;
  if (!Number.isFinite(value)) return void 0;
  const epochMs = (value + CORE_DATA_EPOCH_OFFSET_S) * 1e3;
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return void 0;
  return d.toISOString();
}
function composeDisplayName(args) {
  const parts = [args.firstName, args.middleName, args.lastName].filter((p) => Boolean(p));
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
function pivotPipeEncoded(value) {
  if (!value) return [];
  return value.split("").filter((s) => s.length > 0);
}
function completenessScore(c) {
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
function softKey(c) {
  return [c.displayName.toLowerCase(), c.primaryEmail?.toLowerCase() ?? ""].join("|");
}
/**
 * Merge contacts from multiple sources. Same person across two sources is
 * detected via (displayName, primaryEmail). The kept record is whichever
 * has the higher completeness score; the dropped record's source is folded
 * into `sources` on the kept one.
 */
function dedupContacts(input) {
  const byKey = /* @__PURE__ */ new Map();
  for (const c of input) {
    const key = softKey(c);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, c);
      continue;
    }
    const scoreA = "emails" in c ? completenessScore(c) : 0;
    const scoreB = "emails" in existing ? completenessScore(existing) : 0;
    const winner = scoreA >= scoreB ? c : existing;
    const loser = scoreA >= scoreB ? existing : c;
    const merged = {
      ...winner,
      sources: [...new Set([...winner.sources, ...loser.sources])],
      isMe: winner.isMe || loser.isMe,
    };
    byKey.set(key, merged);
  }
  return [...byKey.values()];
}
//#endregion
//#region src/domains/contacts/addressBook.ts
const SOURCES_DIR = `${homedir()}/Library/Application Support/AddressBook/Sources`;
/** Z_ENT values for ABCDContact and ABCDSubscribedContact. See the audit. */
const CONTACT_ENT_VALUES = [22, 23];
/** ASCII record separator - safe pipe delimiter for SQLite GROUP_CONCAT. */
const RS = "";
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
/**
 * Discover all per-source AddressBook databases under
 * ~/Library/Application Support/AddressBook/Sources. Returns an empty array
 * when the directory does not exist or FDA has not been granted.
 */
function detectSources() {
  if (!existsSync(SOURCES_DIR)) return [];
  let entries;
  try {
    entries = readdirSync(SOURCES_DIR);
  } catch {
    return [];
  }
  const sources = [];
  for (const uuid of entries) {
    const dbPath = join(SOURCES_DIR, uuid, "AddressBook-v22.abcddb");
    if (existsSync(dbPath))
      sources.push({
        uuid,
        dbPath,
      });
  }
  return sources;
}
function rowToSummary(row, source) {
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
  const summary = {
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
function querySummariesForSource(source, opts) {
  const db = createReadOnlyConnection(source.dbPath);
  try {
    return db
      .query(`SELECT ${SUMMARY_COLUMNS}, ${SUMMARY_AGGREGATES}
         FROM ZABCDRECORD r
         WHERE ${CONTACT_WHERE}
         ORDER BY COALESCE(r.ZSORTINGLASTNAME, r.ZLASTNAME, r.ZSORTINGFIRSTNAME, r.ZFIRSTNAME, r.ZORGANIZATION)
         LIMIT ? OFFSET ?`)
      .all(opts.limit, opts.offset)
      .map((r) => rowToSummary(r, source.uuid));
  } finally {
    db.close();
  }
}
function searchSummariesForSource(source, opts) {
  const db = createReadOnlyConnection(source.dbPath);
  try {
    const like = `%${opts.query}%`;
    const likeLower = `%${opts.query.toLowerCase()}%`;
    const preds = [];
    const params = [];
    const namePred =
      "(COALESCE(r.ZFIRSTNAME, '') LIKE ? OR COALESCE(r.ZLASTNAME, '') LIKE ? OR COALESCE(r.ZNICKNAME, '') LIKE ? OR COALESCE(r.ZORGANIZATION, '') LIKE ?)";
    const emailPred =
      "EXISTS (SELECT 1 FROM ZABCDEMAILADDRESS e WHERE e.ZOWNER = r.Z_PK AND COALESCE(e.ZADDRESSNORMALIZED, LOWER(e.ZADDRESS)) LIKE ?)";
    const phonePred =
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
    return db
      .query(sql)
      .all(...params, opts.limit)
      .map((r) => rowToSummary(r, source.uuid));
  } finally {
    db.close();
  }
}
function listContacts(opts = {}) {
  const sources = detectSources();
  if (sources.length === 0)
    return {
      contacts: [],
      totalReturned: 0,
      truncated: false,
      hint: "Contacts data not accessible. Grant Full Disk Access and retry.",
    };
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const offset = Math.max(0, opts.offset ?? 0);
  const filteredSources = opts.source ? sources.filter((s) => s.uuid === opts.source) : sources;
  if (opts.source && filteredSources.length === 0)
    return {
      contacts: [],
      totalReturned: 0,
      truncated: false,
      hint: `No source matched UUID "${opts.source}".`,
    };
  const perSourceLimit = limit + offset;
  const all = [];
  for (const src of filteredSources)
    all.push(
      ...querySummariesForSource(src, {
        limit: perSourceLimit,
        offset: 0,
      }),
    );
  const deduped = dedupContacts(all).sort((a, b) =>
    a.displayName.localeCompare(b.displayName, void 0, { sensitivity: "base" }),
  );
  const sliced = deduped.slice(offset, offset + limit);
  return {
    contacts: sliced,
    totalReturned: sliced.length,
    truncated: deduped.length > offset + sliced.length,
  };
}
function searchContacts(input) {
  const sources = detectSources();
  if (sources.length === 0)
    return {
      results: [],
      totalReturned: 0,
      truncated: false,
      hint: "Contacts data not accessible. Grant Full Disk Access and retry.",
    };
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const all = [];
  for (const src of sources)
    all.push(
      ...searchSummariesForSource(src, {
        query: input.query,
        field: input.field ?? "all",
        limit,
      }),
    );
  const deduped = dedupContacts(all);
  const sliced = deduped.slice(0, limit);
  return {
    results: sliced,
    totalReturned: sliced.length,
    truncated: deduped.length > sliced.length,
  };
}
function getContact(id) {
  const sources = detectSources();
  for (const source of sources) {
    const db = createReadOnlyConnection(source.dbPath);
    try {
      const row = db
        .query(`SELECT
             ${SUMMARY_COLUMNS},
             r.ZDEPARTMENT AS department,
             r.ZTITLE AS title,
             r.ZSUFFIX AS suffix,
             r.ZBIRTHDAY AS ZBIRTHDAY,
             r.ZCREATIONDATE AS ZCREATIONDATE,
             (SELECT n.ZTEXT FROM ZABCDNOTE n WHERE n.ZCONTACT = r.Z_PK LIMIT 1) AS note
           FROM ZABCDRECORD r
           WHERE ${CONTACT_WHERE} AND r.ZUNIQUEID = ?
           LIMIT 1`)
        .get(id);
      if (!row) continue;
      const emails = db
        .query(
          "SELECT ZADDRESS AS address, ZLABEL AS label, ZISPRIMARY AS is_primary FROM ZABCDEMAILADDRESS WHERE ZOWNER = ? ORDER BY ZISPRIMARY DESC, ZORDERINGINDEX",
        )
        .all(row.pk);
      const phones = db
        .query(
          "SELECT ZFULLNUMBER AS full, ZCOUNTRYCODE AS cc, ZAREACODE AS area, ZLOCALNUMBER AS local, ZEXTENSION AS ext, ZLABEL AS label, ZISPRIMARY AS is_primary FROM ZABCDPHONENUMBER WHERE ZOWNER = ? ORDER BY ZISPRIMARY DESC, ZORDERINGINDEX",
        )
        .all(row.pk);
      const addresses = db
        .query(
          "SELECT ZSTREET AS street, ZCITY AS city, ZSTATE AS state, ZZIPCODE AS zip, ZCOUNTRYNAME AS country, ZLABEL AS label FROM ZABCDPOSTALADDRESS WHERE ZOWNER = ?",
        )
        .all(row.pk);
      const urls = db
        .query("SELECT ZURL AS url, ZLABEL AS label FROM ZABCDURLADDRESS WHERE ZOWNER = ?")
        .all(row.pk);
      const full = {
        ...rowToSummary(row, source.uuid),
        emails: emails
          .filter((e) => Boolean(e.address))
          .map((e) => {
            const entry = { address: e.address };
            const label = unwrapLabel(e.label);
            if (label !== void 0) entry.label = label;
            return entry;
          }),
        phones: phones.map((p) => {
          const entry = {
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
          if (label !== void 0) entry.label = label;
          return entry;
        }),
        addresses: addresses.map((a) => {
          const entry = {};
          if (a.street) entry.street = a.street;
          if (a.city) entry.city = a.city;
          if (a.state) entry.state = a.state;
          if (a.zip) entry.zip = a.zip;
          if (a.country) entry.country = a.country;
          const label = unwrapLabel(a.label);
          if (label !== void 0) entry.label = label;
          return entry;
        }),
        urls: urls
          .filter((u) => Boolean(u.url))
          .map((u) => {
            const entry = { url: u.url };
            const label = unwrapLabel(u.label);
            if (label !== void 0) entry.label = label;
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
      if (!full.primaryEmail && full.emails[0]) full.primaryEmail = full.emails[0].address;
      if (!full.primaryPhone && full.phones[0]?.normalized.length)
        full.primaryPhone = full.phones[0].normalized;
      return full;
    } finally {
      db.close();
    }
  }
  return null;
}
//#endregion
//#region src/server/tools/contacts/get.ts
const inputShape$2 = {
  contactId: z
    .string()
    .min(1)
    .describe(
      "Apple's stable ZUNIQUEID for the contact, e.g. '...:ABPerson'. Obtained from a contacts_list or contacts_search result.",
    ),
};
const TOOL$2 = {
  name: "contacts_get",
  description:
    "Fetch a full contact record by Apple ZUNIQUEID, including every email, phone, postal address, URL, and the note text. When no source contains the id, returns an error envelope { error: string } instead of throwing.",
  inputShape: inputShape$2,
  domain: "contacts",
  handler: async (input) => {
    const args = z.object(inputShape$2).parse(input);
    const contact = getContact(args.contactId);
    if (!contact)
      return Promise.resolve({ error: `No contact found with id "${args.contactId}".` });
    return Promise.resolve(contact);
  },
};
//#endregion
//#region src/server/tools/contacts/list.ts
const inputShape$1 = {
  source: z
    .string()
    .optional()
    .describe(
      "Restrict to a single AddressBook source UUID (the directory name under ~/Library/Application Support/AddressBook/Sources). Omit for all sources merged with cross-source dedup.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum contacts to return. Default 50, hard cap 200."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Skip the first N contacts (for pagination). Default 0."),
};
const TOOL$1 = {
  name: "contacts_list",
  description:
    "List Apple Contacts merged across all AddressBook sources, sorted by display name. Returns summary records with primary email and primary phone.",
  inputShape: inputShape$1,
  domain: "contacts",
  handler: async (input) => {
    const args = z.object(inputShape$1).parse(input);
    return Promise.resolve(
      listContacts({
        source: args.source,
        limit: args.limit,
        offset: args.offset,
      }),
    );
  },
};
//#endregion
//#region src/server/tools/contacts/search.ts
const inputShape = {
  query: z
    .string()
    .min(1)
    .describe(
      "Substring to look for. Case-insensitive for emails (uses ZADDRESSNORMALIZED). For phones, non-digit characters are stripped before matching ZFULLNUMBER or ZLASTFOURDIGITS.",
    ),
  field: z
    .enum(["name", "email", "phone", "all"])
    .optional()
    .describe(
      "Which field to search. 'name' matches first/last/nick/organisation. 'email' matches the normalised address. 'phone' matches digits or the last four digits. 'all' (default) unions every field.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max results to return. Default 25, hard cap 100."),
};
const TOOL = {
  name: "contacts_search",
  description:
    "Search Apple Contacts by name, email, phone, or all fields. Returns summary records merged across sources.",
  inputShape,
  domain: "contacts",
  handler: async (input) => {
    const args = z.object(inputShape).parse(input);
    return Promise.resolve(
      searchContacts({
        query: args.query,
        field: args.field,
        limit: args.limit,
      }),
    );
  },
};
//#endregion
//#region src/domains/contacts/plugin.ts
function buildContactsPlugin() {
  return {
    name: "contacts",
    tools: [TOOL$1, TOOL$2, TOOL],
    getIndexStatus() {
      const sources = detectSources();
      if (sources.length === 0)
        return Promise.resolve({
          available: false,
          reason: "AddressBook sources not accessible (Full Disk Access required).",
        });
      return Promise.resolve({
        available: true,
        sourceCount: sources.length,
        sources: sources.map((s) => s.uuid),
      });
    },
  };
}
//#endregion
export { buildContactsPlugin };
