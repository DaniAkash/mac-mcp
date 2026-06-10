import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  CATEGORY_INT_BY_LABEL,
  CATEGORY_LABEL_BY_INT,
  labelForCategoryInt,
  probeCategorySupport,
} from "../../../src/domains/mail/index/categories.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
});
afterEach(() => {
  db.close();
});

test("CATEGORY_INT_BY_LABEL matches CATEGORY_LABEL_BY_INT round-trip", () => {
  for (const [intStr, label] of Object.entries(CATEGORY_LABEL_BY_INT)) {
    expect(CATEGORY_INT_BY_LABEL[label]).toBe(Number(intStr));
  }
});

test("labelForCategoryInt: known values", () => {
  expect(labelForCategoryInt(0)).toBe("primary");
  expect(labelForCategoryInt(1)).toBe("transactions");
  expect(labelForCategoryInt(2)).toBe("updates");
  expect(labelForCategoryInt(3)).toBe("promotions");
});

test("labelForCategoryInt: null / undefined / unknown ints", () => {
  expect(labelForCategoryInt(null)).toBe(null);
  expect(labelForCategoryInt(undefined)).toBe(null);
  expect(labelForCategoryInt(42)).toBe(null);
});

test("probeCategorySupport: missing table reports unsupported", () => {
  const result = probeCategorySupport(db);
  expect(result.kind).toBe("unsupported");
  if (result.kind === "unsupported") {
    expect(result.reason).toContain("message_global_data");
  }
});

test("probeCategorySupport: missing column reports unsupported", () => {
  db.exec("CREATE TABLE message_global_data (some_other_col INTEGER)");
  const result = probeCategorySupport(db);
  expect(result.kind).toBe("unsupported");
  if (result.kind === "unsupported") {
    expect(result.reason).toContain("model_category");
  }
});

test("probeCategorySupport: no categorised rows yet reports unsupported", () => {
  db.exec(
    "CREATE TABLE message_global_data (message_id INTEGER, model_category INTEGER, category_model_version INTEGER, category_is_temporary INTEGER)",
  );
  const result = probeCategorySupport(db);
  expect(result.kind).toBe("unsupported");
  if (result.kind === "unsupported") {
    expect(result.reason).toContain("no categorised");
  }
});

test("probeCategorySupport: rows with model_category report supported with version", () => {
  db.exec(
    "CREATE TABLE message_global_data (message_id INTEGER, model_category INTEGER, category_model_version INTEGER, category_is_temporary INTEGER)",
  );
  db.run(
    "INSERT INTO message_global_data (message_id, model_category, category_model_version, category_is_temporary) VALUES (?, ?, ?, ?)",
    [123, 1, 3, 0],
  );
  const result = probeCategorySupport(db);
  expect(result.kind).toBe("supported");
  if (result.kind === "supported") {
    expect(result.categoryModelVersion).toBe(3);
  }
});
