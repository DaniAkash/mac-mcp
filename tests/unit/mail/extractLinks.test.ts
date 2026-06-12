import { describe, expect, test } from "bun:test";
import { simpleParser } from "mailparser";
import { extractLinks } from "../../../src/domains/mail/extractLinks.ts";

async function parseMime(mime: string) {
  return simpleParser(Buffer.from(mime, "utf8"));
}

const MIME_HEADERS = [
  "From: sender@example.com",
  "To: rcpt@example.com",
  "Subject: t",
  "MIME-Version: 1.0",
].join("\r\n");

describe("extractLinks", () => {
  test("returns html anchors with visible text", async () => {
    const parsed = await parseMime(
      `${MIME_HEADERS}\r\nContent-Type: text/html\r\n\r\n` +
        `<p><a href="https://example.com/a">click here</a></p>`,
    );
    const r = extractLinks(parsed);
    expect(r.source).toBe("html");
    expect(r.links).toEqual([{ url: "https://example.com/a", text: "click here", kind: "http" }]);
  });

  test("extracts bare URLs from plaintext body", async () => {
    const parsed = await parseMime(
      `${MIME_HEADERS}\r\nContent-Type: text/plain\r\n\r\nVisit https://example.com and email foo@example.com or mailto:bar@example.com.`,
    );
    const r = extractLinks(parsed);
    expect(r.source).toBe("text");
    const urls = r.links.map((l) => l.url);
    expect(urls).toContain("https://example.com");
    expect(urls).toContain("mailto:bar@example.com");
    expect(r.links.find((l) => l.url === "mailto:bar@example.com")?.kind).toBe("mailto");
  });

  test("source=both when html and text both contribute links", async () => {
    const boundary = "BOUND";
    const mime =
      `${MIME_HEADERS}\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` +
      `--${boundary}\r\nContent-Type: text/plain\r\n\r\nSee https://text-only.example.com\r\n` +
      `--${boundary}\r\nContent-Type: text/html\r\n\r\n<a href="https://html.example.com">x</a>\r\n` +
      `--${boundary}--`;
    const parsed = await parseMime(mime);
    const r = extractLinks(parsed);
    expect(r.source).toBe("both");
    const urls = r.links.map((l) => l.url).sort();
    expect(urls).toContain("https://html.example.com");
    expect(urls).toContain("https://text-only.example.com");
  });

  test("List-Unsubscribe header links flagged with inHeader", async () => {
    const parsed = await parseMime(
      `${MIME_HEADERS}\r\nList-Unsubscribe: <https://list.example.com/u>, <mailto:unsub@example.com>\r\nContent-Type: text/plain\r\n\r\nhi`,
    );
    const r = extractLinks(parsed);
    const inHeader = r.links.filter((l) => l.inHeader);
    expect(inHeader.map((l) => l.url).sort()).toEqual([
      "https://list.example.com/u",
      "mailto:unsub@example.com",
    ]);
  });

  test("kinds filter restricts the result set", async () => {
    const parsed = await parseMime(
      `${MIME_HEADERS}\r\nContent-Type: text/plain\r\n\r\nhttps://a.example.com mailto:b@example.com tel:+155500`,
    );
    const r = extractLinks(parsed, { kinds: ["mailto"] });
    expect(r.links.length).toBe(1);
    expect(r.links[0]?.kind).toBe("mailto");
  });

  test("dedup collapses duplicate urls but keeps anchor text", async () => {
    const parsed = await parseMime(
      `${MIME_HEADERS}\r\nContent-Type: text/html\r\n\r\n` +
        `<a href="https://example.com/x">first</a> ` +
        `also see https://example.com/x for more.`,
    );
    const r = extractLinks(parsed);
    const matching = r.links.filter((l) => l.url === "https://example.com/x");
    expect(matching.length).toBe(1);
    expect(matching[0]?.text).toBe("first");
  });

  test("limit truncates and sets truncated flag", async () => {
    const anchors = Array.from(
      { length: 5 },
      (_, i) => `<a href="https://example.com/${i}">l${i}</a>`,
    ).join(" ");
    const parsed = await parseMime(`${MIME_HEADERS}\r\nContent-Type: text/html\r\n\r\n${anchors}`);
    const r = extractLinks(parsed, { limit: 3 });
    expect(r.links.length).toBe(3);
    expect(r.totalReturned).toBe(3);
    expect(r.truncated).toBe(true);
  });

  test("skips javascript: and anchor-only hrefs", async () => {
    const parsed = await parseMime(
      `${MIME_HEADERS}\r\nContent-Type: text/html\r\n\r\n` +
        `<a href="#section">in-page</a><a href="javascript:alert(1)">bad</a><a href="https://ok.example.com">ok</a>`,
    );
    const r = extractLinks(parsed);
    expect(r.links.map((l) => l.url)).toEqual(["https://ok.example.com"]);
  });
});
