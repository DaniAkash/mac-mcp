import { afterEach, beforeEach, expect, test } from "bun:test";
import { _clearAccountMapForTests } from "../../../src/domains/mail/index/accountMap.ts";

beforeEach(() => {
  _clearAccountMapForTests();
});
afterEach(() => {
  _clearAccountMapForTests();
});

test("_clearAccountMapForTests is callable repeatedly without throwing", () => {
  expect(() => {
    _clearAccountMapForTests();
    _clearAccountMapForTests();
    _clearAccountMapForTests();
  }).not.toThrow();
});
