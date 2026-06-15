import { describe, expect, test } from "bun:test";
import { simpleParser } from "mailparser";
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  getAttachment,
  listAttachments,
} from "../../../src/domains/mail/extractAttachments.ts";

const BOUND = "BOUND";

function buildMultipart(parts: { headers: string; body: string }[]): string {
  const head = [
    "From: sender@example.com",
    "To: rcpt@example.com",
    "Subject: t",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${BOUND}"`,
    "",
  ].join("\r\n");
  const partsBody = parts.map((p) => `--${BOUND}\r\n${p.headers}\r\n\r\n${p.body}\r\n`).join("");
  return `${head}\r\n${partsBody}--${BOUND}--`;
}

describe("extractAttachments", () => {
  test("listAttachments returns empty array for a body-only email", async () => {
    const parsed = await simpleParser(
      Buffer.from("From: a@b.com\r\nSubject: t\r\nContent-Type: text/plain\r\n\r\nbody", "utf8"),
    );
    const r = listAttachments(parsed);
    expect(r.attachments).toEqual([]);
    expect(r.totalReturned).toBe(0);
  });

  test("listAttachments surfaces filename, size, contentType, and disposition", async () => {
    const mime = buildMultipart([
      { headers: "Content-Type: text/plain", body: "hello" },
      {
        headers:
          'Content-Type: application/pdf; name="report.pdf"\r\nContent-Disposition: attachment; filename="report.pdf"\r\nContent-Transfer-Encoding: base64',
        body: Buffer.from("PDF-BYTES-HERE").toString("base64"),
      },
    ]);
    const parsed = await simpleParser(Buffer.from(mime, "utf8"));
    const r = listAttachments(parsed);
    expect(r.attachments.length).toBe(1);
    const att = r.attachments[0];
    expect(att?.index).toBe(0);
    expect(att?.filename).toBe("report.pdf");
    expect(att?.contentType).toBe("application/pdf");
    expect(att?.size).toBeGreaterThan(0);
    expect(att?.contentDisposition).toBe("attachment");
  });

  test("inline attachments carry contentId and inline disposition", async () => {
    const mime = buildMultipart([
      { headers: "Content-Type: text/html", body: '<img src="cid:img1">' },
      {
        headers:
          'Content-Type: image/png; name="x.png"\r\nContent-Disposition: inline; filename="x.png"\r\nContent-Id: <img1>\r\nContent-Transfer-Encoding: base64',
        body: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
      },
    ]);
    const parsed = await simpleParser(Buffer.from(mime, "utf8"));
    const r = listAttachments(parsed);
    expect(r.attachments[0]?.contentDisposition).toBe("inline");
    expect(r.attachments[0]?.contentId).toBe("img1");
  });

  test("getAttachment returns base64 bytes for in-range index", async () => {
    const payload = "the bytes";
    const mime = buildMultipart([
      { headers: "Content-Type: text/plain", body: "body" },
      {
        headers:
          'Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="x.bin"\r\nContent-Transfer-Encoding: base64',
        body: Buffer.from(payload).toString("base64"),
      },
    ]);
    const parsed = await simpleParser(Buffer.from(mime, "utf8"));
    const r = getAttachment(parsed, 0);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(Buffer.from(r.result.base64, "base64").toString("utf8")).toBe(payload);
      expect(r.result.filename).toBe("x.bin");
    }
  });

  test("getAttachment with out-of-range index returns index_out_of_range", async () => {
    const parsed = await simpleParser(Buffer.from("From: a@b.com\r\nSubject: t\r\n\r\nb", "utf8"));
    const r = getAttachment(parsed, 5);
    expect(r.kind).toBe("index_out_of_range");
    if (r.kind === "index_out_of_range") expect(r.available).toBe(0);
  });

  test("getAttachment with maxBytes lower than size returns too_large", async () => {
    const payload = "a".repeat(100);
    const mime = buildMultipart([
      { headers: "Content-Type: text/plain", body: "body" },
      {
        headers:
          'Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="big.bin"\r\nContent-Transfer-Encoding: base64',
        body: Buffer.from(payload).toString("base64"),
      },
    ]);
    const parsed = await simpleParser(Buffer.from(mime, "utf8"));
    const r = getAttachment(parsed, 0, { maxBytes: 10 });
    expect(r.kind).toBe("too_large");
    if (r.kind === "too_large") {
      expect(r.actualSize).toBeGreaterThan(10);
      expect(r.maxBytes).toBe(10);
    }
  });

  test("default cap is 5 MiB", () => {
    expect(DEFAULT_MAX_ATTACHMENT_BYTES).toBe(5 * 1024 * 1024);
  });
});
