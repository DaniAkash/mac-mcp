import { expect, test } from "bun:test";
import { coreDataDateToIso, dateOnlyToCoreData } from "../../src/utils/coreDataDate.ts";

test("coreDataDateToIso: 817171200 -> 2026-11-24 (real Calendar event timestamp)", () => {
  expect(coreDataDateToIso(817_171_200)).toBe("2026-11-24T00:00:00.000Z");
});

test("coreDataDateToIso: 0 -> 2001-01-01 (the epoch itself)", () => {
  expect(coreDataDateToIso(0)).toBe("2001-01-01T00:00:00.000Z");
});

test("coreDataDateToIso: null / undefined / NaN -> undefined", () => {
  expect(coreDataDateToIso(null)).toBe(undefined);
  expect(coreDataDateToIso(undefined)).toBe(undefined);
  expect(coreDataDateToIso(Number.NaN)).toBe(undefined);
});

test("dateOnlyToCoreData: 2026-11-15 round-trips through coreDataDateToIso", () => {
  const cd = dateOnlyToCoreData("2026-11-15");
  expect(cd).not.toBe(null);
  expect(coreDataDateToIso(cd as number)).toBe("2026-11-15T00:00:00.000Z");
});

test("dateOnlyToCoreData: 2001-01-01 -> 0 (the epoch)", () => {
  expect(dateOnlyToCoreData("2001-01-01")).toBe(0);
});

test("dateOnlyToCoreData: invalid date returns null", () => {
  expect(dateOnlyToCoreData("not-a-date")).toBe(null);
});
