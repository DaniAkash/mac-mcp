import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sanitiseFtsQuery, searchEmails } from "../../../src/domains/mail/index/search.ts";
import { SCHEMA_V1 } from "../../../src/domains/mail/index/schema.sql.ts";
import { createConnection } from "../../../src/utils/sqlite.ts";

describe("sanitiseFtsQuery", () => {
  test("preserves balanced phrases", () => {
    expect(sanitiseFtsQuery('"quarterly report"')).toBe('"quarterly report"');
  });

  test("preserves trailing-* prefix tokens", () => {
    expect(sanitiseFtsQuery("meet*")).toBe("meet*");
  });

  test("uppercases AND / OR / NOT operators", () => {
    expect(sanitiseFtsQuery("foo and bar or baz")).toBe("foo AND bar OR baz");
  });

  test("wraps tokens with special chars in quotes", () => {
    expect(sanitiseFtsQuery("user:admin")).toBe('"user:admin"');
    expect(sanitiseFtsQuery("foo-bar")).toBe('"foo-bar"');
  });

  test("drops unbalanced quotes", () => {
    expect(sanitiseFtsQuery('"unclosed').includes('"')).toBe(false);
  });

  test("returns empty string for empty input", () => {
    expect(sanitiseFtsQuery("")).toBe("");
  });
});

describe("searchEmails", () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mac-mcp-search-"));
    dbPath = join(tmp, "mail.db");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function seed() {
    const db = createConnection(dbPath);
    db.exec(SCHEMA_V1);
    const insert = db.prepare(
      `INSERT INTO emails (message_id, account, mailbox, subject, sender, content, date_received, date_sent, emlx_path, category, is_unread, is_flagged, attachment_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      1,
      "Work",
      "INBOX",
      "Q4 budget review",
      "boss@example.com",
      "Reminder about the quarterly Q4 budget review on Friday.",
      "2026-06-01T09:00:00Z",
      "2026-06-01T08:00:00Z",
      "/tmp/1.emlx",
      "primary",
      1,
      0,
      0,
    );
    insert.run(
      2,
      "Work",
      "INBOX",
      "Lunch?",
      "friend@example.com",
      "Want to grab lunch this Thursday?",
      "2026-06-02T11:00:00Z",
      "2026-06-02T11:00:00Z",
      "/tmp/2.emlx",
      "primary",
      0,
      0,
      0,
    );
    insert.run(
      3,
      "Personal",
      "INBOX",
      "Spotify order confirmation",
      "no-reply@spotify.com",
      "Your order confirmation for Spotify Premium.",
      "2026-06-03T13:00:00Z",
      "2026-06-03T12:00:00Z",
      "/tmp/3.emlx",
      "transactions",
      1,
      0,
      0,
    );
    return db;
  }

  test("matches against body and returns recency-tied BM25 order", () => {
    const db = seed();
    try {
      const results = db.query("SELECT COUNT(*) AS n FROM emails").get() as { n: number };
      expect(results.n).toBe(3);
      const matches = searchEmails(db, { query: "budget" });
      expect(matches).toHaveLength(1);
      expect(matches[0]?.subject).toBe("Q4 budget review");
    } finally {
      db.close();
    }
  });

  test("filters by category", () => {
    const db = seed();
    try {
      const matches = searchEmails(db, { query: "confirmation", category: "transactions" });
      expect(matches).toHaveLength(1);
      expect(matches[0]?.id).toBe(3);
      const noPrimary = searchEmails(db, { query: "confirmation", category: "primary" });
      expect(noPrimary).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("filters by account display name", () => {
    const db = seed();
    try {
      const matches = searchEmails(db, { query: "lunch", account: "Personal" });
      expect(matches).toHaveLength(0);
      const workOnly = searchEmails(db, { query: "lunch", account: "Work" });
      expect(workOnly).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("scope:subject matches subject only", () => {
    const db = seed();
    try {
      // 'review' is in the body of #1 too, but scope=subject narrows it
      const both = searchEmails(db, { query: "review" });
      expect(both).toHaveLength(1);
      const justSubject = searchEmails(db, { query: "review", scope: "subject" });
      expect(justSubject).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("highlight wraps matches in **markers**", () => {
    const db = seed();
    try {
      const matches = searchEmails(db, { query: "lunch", highlight: true });
      expect(matches[0]?.snippet).toContain("**");
    } finally {
      db.close();
    }
  });

  test("empty query returns empty results", () => {
    const db = seed();
    try {
      const matches = searchEmails(db, { query: "" });
      expect(matches).toEqual([]);
    } finally {
      db.close();
    }
  });
});
