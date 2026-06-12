import { describe, expect, test } from "bun:test";
import { resolveContactByEmailWith } from "../../../src/domains/contacts/resolveByEmail.ts";
import type { ContactSummary } from "../../../src/domains/contacts/contacts.types.ts";

function summary(id: string, displayName: string, primaryEmail?: string): ContactSummary {
  const base: ContactSummary = {
    id,
    displayName,
    sources: ["src"],
    isMe: false,
  };
  if (primaryEmail) base.primaryEmail = primaryEmail;
  return base;
}

describe("resolveContactByEmailWith", () => {
  test("returns the candidate when primaryEmail matches case-insensitively", () => {
    const r = resolveContactByEmailWith("ALICE@EXAMPLE.COM", {
      search: () => [summary("c1", "Alice", "alice@example.com")],
      fullEmails: () => [],
    });
    expect(r?.id).toBe("c1");
  });

  test("matches via a secondary email when primaryEmail is different", () => {
    const r = resolveContactByEmailWith("work@example.com", {
      search: () => [summary("c2", "Bob", "bob@personal.com")],
      fullEmails: (id) => (id === "c2" ? ["bob@personal.com", "work@example.com"] : []),
    });
    expect(r?.id).toBe("c2");
  });

  test("filters out substring-only matches", () => {
    const r = resolveContactByEmailWith("foo@bar.com", {
      search: () => [summary("c3", "Foozer", "xfoo@bar.com")],
      fullEmails: () => ["xfoo@bar.com"],
    });
    expect(r).toBeNull();
  });

  test("returns null when search returns nothing", () => {
    const r = resolveContactByEmailWith("nobody@example.com", {
      search: () => [],
      fullEmails: () => [],
    });
    expect(r).toBeNull();
  });

  test("ignores empty input", () => {
    const r = resolveContactByEmailWith("   ", {
      search: () => {
        throw new Error("search should not be called");
      },
      fullEmails: () => [],
    });
    expect(r).toBeNull();
  });
});
