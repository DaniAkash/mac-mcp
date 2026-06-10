import { expect, test } from "bun:test";
import { isLogLevel, parseLogLevel } from "../../src/utils/logger.ts";

test("parseLogLevel: recognises every level", () => {
  expect(parseLogLevel("debug")).toBe("debug");
  expect(parseLogLevel("info")).toBe("info");
  expect(parseLogLevel("warn")).toBe("warn");
  expect(parseLogLevel("error")).toBe("error");
});

test("parseLogLevel: falls back to info on unknown values", () => {
  expect(parseLogLevel("verbose")).toBe("info");
  expect(parseLogLevel("DEBUG")).toBe("info");
  expect(parseLogLevel("")).toBe("info");
  expect(parseLogLevel(undefined)).toBe("info");
});

test("isLogLevel: type guard rejects non-strings", () => {
  expect(isLogLevel("info")).toBe(true);
  expect(isLogLevel("bogus")).toBe(false);
  expect(isLogLevel(undefined)).toBe(false);
  expect(isLogLevel(42)).toBe(false);
  expect(isLogLevel(null)).toBe(false);
});
