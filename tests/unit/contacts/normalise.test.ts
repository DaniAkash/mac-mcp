import { describe, expect, test } from "bun:test";
import {
  composeDisplayName,
  coreDataDateToIso,
  dedupContacts,
  normalisePhone,
  pivotPipeEncoded,
  unwrapLabel,
} from "../../../src/domains/contacts/normalise.ts";
import type { ContactSummary } from "../../../src/domains/contacts/contacts.types.ts";

describe("unwrapLabel", () => {
  test("strips Apple's _$!<...>!$_ wrapper", () => {
    expect(unwrapLabel("_$!<Mobile>!$_")).toBe("Mobile");
    expect(unwrapLabel("_$!<Work>!$_")).toBe("Work");
    expect(unwrapLabel("_$!<WorkFAX>!$_")).toBe("WorkFAX");
  });
  test("passes through user-typed labels", () => {
    expect(unwrapLabel("Mobile")).toBe("Mobile");
    expect(unwrapLabel("My custom label")).toBe("My custom label");
  });
  test("returns undefined for null/empty/whitespace", () => {
    expect(unwrapLabel(null)).toBe(undefined);
    expect(unwrapLabel(undefined)).toBe(undefined);
    expect(unwrapLabel("")).toBe(undefined);
    expect(unwrapLabel("   ")).toBe(undefined);
  });
});

describe("normalisePhone", () => {
  test("composes E.164 from parsed parts", () => {
    expect(
      normalisePhone({
        full: "+91 79041 36907",
        countryCode: "91",
        areaCode: "79041",
        localNumber: "36907",
        extension: null,
      }),
    ).toBe("+917904136907");
  });
  test("appends extension when present", () => {
    expect(
      normalisePhone({
        full: "+1 (555) 123-4567 x42",
        countryCode: "1",
        areaCode: "555",
        localNumber: "1234567",
        extension: "42",
      }),
    ).toBe("+15551234567;ext=42");
  });
  test("falls back to stripping the display value when parts are missing", () => {
    expect(
      normalisePhone({
        full: "73730 74962",
        countryCode: null,
        areaCode: null,
        localNumber: null,
        extension: null,
      }),
    ).toBe("7373074962");
  });
  test("vanity numbers come through with letters preserved (doc-confirmed behaviour)", () => {
    expect(
      normalisePhone({
        full: "1-800-MY-APPLE",
        countryCode: null,
        areaCode: null,
        localNumber: null,
        extension: null,
      }),
    ).toBe("1800MYAPPLE");
  });
  test("preserves leading + when no parsed parts", () => {
    expect(
      normalisePhone({
        full: "+44 20 1234 5678",
        countryCode: null,
        areaCode: null,
        localNumber: null,
        extension: null,
      }),
    ).toBe("+442012345678");
  });
  test("returns empty string for null/empty input", () => {
    expect(
      normalisePhone({
        full: null,
        countryCode: null,
        areaCode: null,
        localNumber: null,
        extension: null,
      }),
    ).toBe("");
    expect(
      normalisePhone({
        full: "",
        countryCode: null,
        areaCode: null,
        localNumber: null,
        extension: null,
      }),
    ).toBe("");
  });
});

describe("coreDataDateToIso", () => {
  test("Core Data epoch 802821745 maps to 2026-06-10 (offset 978307200)", () => {
    const iso = coreDataDateToIso(802_821_745);
    expect(iso).toBe("2026-06-10T22:02:25.000Z");
  });
  test("null/undefined/NaN return undefined", () => {
    expect(coreDataDateToIso(null)).toBe(undefined);
    expect(coreDataDateToIso(undefined)).toBe(undefined);
    expect(coreDataDateToIso(Number.NaN)).toBe(undefined);
  });
});

describe("composeDisplayName", () => {
  test("first + middle + last", () => {
    expect(
      composeDisplayName({
        firstName: "Ada",
        middleName: "Augusta",
        lastName: "Lovelace",
        nickname: null,
        organization: null,
      }),
    ).toBe("Ada Augusta Lovelace");
  });
  test("falls back to nickname when no name parts", () => {
    expect(
      composeDisplayName({
        firstName: null,
        middleName: null,
        lastName: null,
        nickname: "ada",
        organization: "Bletchley",
      }),
    ).toBe("ada");
  });
  test("falls back to organization when no name + no nickname", () => {
    expect(
      composeDisplayName({
        firstName: null,
        middleName: null,
        lastName: null,
        nickname: null,
        organization: "Apple Inc.",
      }),
    ).toBe("Apple Inc.");
  });
  test("returns '(no name)' as the last resort", () => {
    expect(
      composeDisplayName({
        firstName: null,
        middleName: null,
        lastName: null,
        nickname: null,
        organization: null,
      }),
    ).toBe("(no name)");
  });
});

describe("pivotPipeEncoded", () => {
  test("splits records by ASCII RS (0x1E)", () => {
    expect(pivotPipeEncoded("a\x1Eb\x1Ec")).toEqual(["a", "b", "c"]);
  });
  test("drops empty segments and handles single value", () => {
    expect(pivotPipeEncoded("only")).toEqual(["only"]);
    expect(pivotPipeEncoded("\x1Ea\x1E\x1Eb\x1E")).toEqual(["a", "b"]);
  });
  test("null and empty return []", () => {
    expect(pivotPipeEncoded(null)).toEqual([]);
    expect(pivotPipeEncoded("")).toEqual([]);
  });
});

describe("dedupContacts", () => {
  function summary(args: Partial<ContactSummary>): ContactSummary {
    return {
      id: args.id ?? `id-${Math.random()}`,
      displayName: args.displayName ?? "Person",
      sources: args.sources ?? ["src-a"],
      isMe: args.isMe ?? false,
      ...args,
    };
  }

  test("merges sources when displayName + primaryEmail match", () => {
    const a = summary({
      id: "1",
      displayName: "Bob",
      primaryEmail: "bob@x.com",
      sources: ["src-a"],
    });
    const b = summary({
      id: "2",
      displayName: "Bob",
      primaryEmail: "bob@x.com",
      sources: ["src-b"],
    });
    const out = dedupContacts([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]?.sources.sort()).toEqual(["src-a", "src-b"]);
  });
  test("keeps distinct contacts with different emails", () => {
    const a = summary({ displayName: "Bob", primaryEmail: "bob@x.com" });
    const b = summary({ displayName: "Bob", primaryEmail: "bob@y.com" });
    expect(dedupContacts([a, b])).toHaveLength(2);
  });
  test("isMe is sticky: surviving merge keeps the flag", () => {
    const a = summary({ displayName: "Me", primaryEmail: "me@x.com", isMe: false });
    const b = summary({
      displayName: "Me",
      primaryEmail: "me@x.com",
      isMe: true,
      sources: ["src-b"],
    });
    const out = dedupContacts([a, b]);
    expect(out[0]?.isMe).toBe(true);
  });
});
