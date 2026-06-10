import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { buildMdfindArgs, resolveSearchPath } from "../../../src/domains/spotlight/mdfind.ts";

test("buildMdfindArgs: bare query", () => {
  expect(buildMdfindArgs({ query: "report", scopedPath: null })).toEqual(["report"]);
});

test("buildMdfindArgs: scoped to a directory", () => {
  expect(buildMdfindArgs({ query: "report", scopedPath: "/Users/x/Documents" })).toEqual([
    "-onlyin",
    "/Users/x/Documents",
    "report",
  ]);
});

test("buildMdfindArgs: query containing spaces or metadata syntax is passed as one argv slot", () => {
  expect(
    buildMdfindArgs({ query: 'kMDItemContentType == "public.image"', scopedPath: null }),
  ).toEqual(['kMDItemContentType == "public.image"']);
});

test("resolveSearchPath: undefined input returns null", () => {
  expect(resolveSearchPath(undefined)).toBe(null);
});

test("resolveSearchPath: home directory itself is accepted", () => {
  expect(resolveSearchPath(homedir())).toBe(homedir());
});

test("resolveSearchPath: child of home is accepted and absolute", () => {
  const child = join(homedir(), "Documents");
  expect(resolveSearchPath(child)).toBe(child);
});

test("resolveSearchPath: absolute path outside home is rejected", () => {
  expect(() => resolveSearchPath("/tmp")).toThrow(/resolves outside the home directory/);
});

test("resolveSearchPath: traversal attempt out of home is rejected", () => {
  expect(() => resolveSearchPath(`${homedir()}/../etc`)).toThrow(/outside the home directory/);
});
