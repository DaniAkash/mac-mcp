import { homedir } from "node:os";
import { expect, test } from "bun:test";
import { expandTilde, isWithin } from "../../src/utils/paths.ts";

test("isWithin: same path is within itself", () => {
  expect(isWithin("/a/b", "/a/b")).toBe(true);
});

test("isWithin: child is within parent", () => {
  expect(isWithin("/a/b/c", "/a/b")).toBe(true);
});

test("isWithin: sibling is not within", () => {
  expect(isWithin("/a/c", "/a/b")).toBe(false);
});

test("isWithin: prefix-sharing-but-not-child is rejected", () => {
  // Critical: /a/bb starts with /a/b but is NOT inside /a/b.
  expect(isWithin("/a/bb", "/a/b")).toBe(false);
});

test("isWithin: traversal attempt resolved and rejected", () => {
  expect(isWithin("/a/b/../c", "/a/b")).toBe(false);
});

test("expandTilde: bare ~", () => {
  expect(expandTilde("~")).toBe(homedir());
});

test("expandTilde: ~/path", () => {
  expect(expandTilde("~/foo/bar")).toBe(`${homedir()}/foo/bar`);
});

test("expandTilde: absolute paths pass through", () => {
  expect(expandTilde("/abs/path")).toBe("/abs/path");
});

test("expandTilde: relative paths pass through", () => {
  expect(expandTilde("relative")).toBe("relative");
});
