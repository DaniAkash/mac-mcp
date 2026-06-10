import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { expandTilde, isWithin } from "../../src/utils/paths.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mac-mcp-paths-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

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

test("isWithin: a symlink pointing OUTSIDE the root is rejected", () => {
  const root = join(tmp, "root");
  const outside = join(tmp, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "x");
  // sneaky.txt lives "inside" root by path string but resolves outside via symlink.
  symlinkSync(join(outside, "secret.txt"), join(root, "sneaky.txt"));
  expect(isWithin(join(root, "sneaky.txt"), root)).toBe(false);
});

test("isWithin: a symlink pointing INSIDE the root is accepted", () => {
  const root = join(tmp, "root");
  mkdirSync(root);
  writeFileSync(join(root, "real.txt"), "x");
  symlinkSync(join(root, "real.txt"), join(root, "alias.txt"));
  expect(isWithin(join(root, "alias.txt"), root)).toBe(true);
});
