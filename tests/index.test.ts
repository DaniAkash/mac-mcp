import { expect, test } from "bun:test";
import {
  ALL_DOMAINS,
  ConfigError,
  ensureWritable,
  loadConfig,
  ReadOnlyError,
  SERVER_NAME,
} from "../src/index.ts";

test("public surface exposes core helpers", () => {
  expect(SERVER_NAME).toBe("mac-mcp");
  expect(ALL_DOMAINS).toContain("mail");
  expect(typeof loadConfig).toBe("function");
});

test("ensureWritable throws ReadOnlyError", () => {
  expect(() => ensureWritable()).toThrow(ReadOnlyError);
});

test("ConfigError is constructable", () => {
  const e = new ConfigError("test");
  expect(e.name).toBe("ConfigError");
  expect(e.message).toBe("test");
});
