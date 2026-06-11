/**
 * Live tests against the real AddressBook. Requires Full Disk Access and at
 * least one source with contacts. Run with `bun run test:e2e`.
 */
import { describe, expect, test } from "bun:test";
import {
  detectSources,
  getContact,
  listContacts,
  searchContacts,
} from "../../src/domains/contacts/addressBook.ts";
import { TOOL as getTool } from "../../src/server/tools/contacts/get.ts";
import { TOOL as listTool } from "../../src/server/tools/contacts/list.ts";
import { TOOL as searchTool } from "../../src/server/tools/contacts/search.ts";
import type {
  ContactFull,
  ContactsListResult,
  ContactsSearchResult,
} from "../../src/domains/contacts/contacts.types.ts";

const E2E = process.env.MAC_MCP_E2E === "1";

describe.skipIf(!E2E)("contacts e2e: live AddressBook", () => {
  test("detectSources returns >=1 source with at least one populated", () => {
    const sources = detectSources();
    expect(sources.length).toBeGreaterThan(0);
    let totalContacts = 0;
    for (const s of sources)
      totalContacts += listContacts({ source: s.uuid, limit: 1 }).contacts.length;
    expect(totalContacts).toBeGreaterThan(0);
  });

  test("contacts_list returns >=1 contact with displayName non-empty", () => {
    const r = listContacts({ limit: 10 });
    expect(r.contacts.length).toBeGreaterThan(0);
    for (const c of r.contacts) {
      expect(c.displayName.length).toBeGreaterThan(0);
      expect(c.id).toMatch(/^.{8,}/);
    }
  });

  test("contacts_list pagination: offset moves the window", () => {
    const page1 = listContacts({ limit: 5, offset: 0 });
    const page2 = listContacts({ limit: 5, offset: 5 });
    if (page1.contacts.length === 5 && page2.contacts.length > 0) {
      const overlap = page1.contacts.filter((c) => page2.contacts.some((c2) => c.id === c2.id));
      expect(overlap.length).toBe(0);
    }
  });

  test("contacts_search by email substring returns rows with email matching", () => {
    const r = searchContacts({ query: "@gmail.com", field: "email", limit: 5 });
    if (r.results.length === 0) return; // user might not have gmail contacts
    for (const c of r.results) {
      const full = getContact(c.id);
      expect(full).not.toBe(null);
      const hasGmail = full?.emails.some((e) => e.address.toLowerCase().includes("@gmail.com"));
      expect(hasGmail).toBe(true);
    }
  });

  test("contacts_search by phone last-four digits matches", () => {
    // Pick a real contact, take its primaryPhone's last 4, search by them.
    const list = listContacts({ limit: 50 });
    const withPhone = list.contacts.find((c) => c.primaryPhone && c.primaryPhone.length >= 4);
    if (!withPhone || !withPhone.primaryPhone) return; // user has no phones
    const last4 = withPhone.primaryPhone.replace(/\D+/g, "").slice(-4);
    expect(last4.length).toBe(4);
    const r = searchContacts({ query: last4, field: "phone", limit: 10 });
    expect(r.results.some((c) => c.id === withPhone.id)).toBe(true);
  });

  test("contacts_get round-trip: list -> get returns same displayName + has structured fields", () => {
    const list = listContacts({ limit: 5 });
    const first = list.contacts[0];
    expect(first).toBeDefined();
    if (!first) return;
    const full = getContact(first.id);
    expect(full).not.toBe(null);
    expect(full?.displayName).toBe(first.displayName);
    expect(Array.isArray(full?.emails)).toBe(true);
    expect(Array.isArray(full?.phones)).toBe(true);
  });

  test("contacts_get unknown id returns an error envelope through the tool", async () => {
    const result = (await getTool.handler({ contactId: "DOES-NOT-EXIST:ABPerson" })) as {
      error?: string;
    };
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/No contact found/);
  });

  test("the three tool handlers match the lower-level functions", async () => {
    const direct = listContacts({ limit: 3 });
    const viaTool = (await listTool.handler({ limit: 3 })) as ContactsListResult;
    expect(viaTool.contacts.length).toBe(direct.contacts.length);
    expect(viaTool.contacts[0]?.id).toBe(direct.contacts[0]?.id);

    if (direct.contacts[0]) {
      const fullViaTool = (await getTool.handler({
        contactId: direct.contacts[0].id,
      })) as ContactFull;
      expect(fullViaTool.id).toBe(direct.contacts[0].id);
    }

    const searchDirect = searchContacts({ query: "@", field: "email", limit: 3 });
    const searchViaTool = (await searchTool.handler({
      query: "@",
      field: "email",
      limit: 3,
    })) as ContactsSearchResult;
    expect(searchViaTool.results.length).toBe(searchDirect.results.length);
  });
});
