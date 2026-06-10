import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  EmlxParseError,
  inferAccountAndMailbox,
  inferId,
  parseEmlx,
} from "../../../src/domains/mail/index/emlxParser.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mac-mcp-emlx-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function buildEmlx(args: {
  mime: string;
  flags: number;
  filename?: string;
  mailDir?: string;
}): string {
  const mime = args.mime;
  const mimeBytes = Buffer.from(mime, "utf8");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>flags</key>
  <integer>${args.flags}</integer>
</dict>
</plist>`;
  const path = join(args.mailDir ?? tmp, args.filename ?? "12345.emlx");
  mkdirSync(args.mailDir ?? tmp, { recursive: true });
  const body = `${mimeBytes.byteLength}\n${mime}${plist}`;
  writeFileSync(path, body);
  return path;
}

describe("parseEmlx", () => {
  test("parses a plain text/plain message", async () => {
    const path = buildEmlx({
      mime:
        "From: sender@example.com\r\n" +
        "To: rcpt@example.com\r\n" +
        "Subject: Hello world\r\n" +
        "Date: Tue, 09 Jun 2026 12:00:00 +0000\r\n" +
        "Message-ID: <abc123@example.com>\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        "\r\n" +
        "Hi there, this is a plain text body.\r\n",
      flags: 0x01,
    });
    const out = await parseEmlx(path);
    expect(out).not.toBeNull();
    expect(out?.subject).toBe("Hello world");
    expect(out?.body).toContain("plain text body");
    expect(out?.isUnread).toBe(false); // flags=1 -> read
    expect(out?.isFlagged).toBe(false);
    expect(out?.messageIdHeader).toBe("<abc123@example.com>");
    expect(out?.attachmentCount).toBe(0);
  });

  test("prefers text/plain over text/html in multipart", async () => {
    const boundary = "MAC_MCP_BOUNDARY_42";
    const mime =
      `From: sender@example.com\r\n` +
      `Subject: Mixed parts\r\n` +
      `Date: Tue, 09 Jun 2026 12:00:00 +0000\r\n` +
      `Content-Type: multipart/alternative; boundary="${boundary}"\r\n` +
      `\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n` +
      `PLAIN_TEXT_SHOULD_WIN\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n` +
      `\r\n` +
      `<p>HTML_SHOULD_LOSE</p>\r\n` +
      `--${boundary}--\r\n`;
    const path = buildEmlx({ mime, flags: 0 });
    const out = await parseEmlx(path);
    expect(out?.body).toContain("PLAIN_TEXT_SHOULD_WIN");
    expect(out?.body).not.toContain("HTML_SHOULD_LOSE");
  });

  test("falls back to HTML stripping when no plain part exists", async () => {
    const mime =
      "From: s@e.com\r\n" +
      "Subject: HTML only\r\n" +
      "Content-Type: text/html; charset=utf-8\r\n" +
      "\r\n" +
      "<html><body><script>alert(1)</script><p>Hello <b>world</b></p></body></html>";
    const path = buildEmlx({ mime, flags: 0 });
    const out = await parseEmlx(path);
    expect(out?.body).toBe("Hello world");
    expect(out?.body).not.toContain("script");
    expect(out?.body).not.toContain("alert");
  });

  test("flags bitmask decodes correctly", async () => {
    const baseMime = "From: s@e.com\r\nSubject: Flags\r\nContent-Type: text/plain\r\n\r\nbody";
    const unreadPath = buildEmlx({ mime: baseMime, flags: 0, filename: "1.emlx" });
    const readPath = buildEmlx({ mime: baseMime, flags: 0x01, filename: "2.emlx" });
    const flaggedPath = buildEmlx({ mime: baseMime, flags: 0x10, filename: "3.emlx" });
    const readAndFlagged = buildEmlx({ mime: baseMime, flags: 0x11, filename: "4.emlx" });

    expect((await parseEmlx(unreadPath))?.isUnread).toBe(true);
    expect((await parseEmlx(readPath))?.isUnread).toBe(false);
    expect((await parseEmlx(flaggedPath))?.isFlagged).toBe(true);
    expect((await parseEmlx(readAndFlagged))?.isFlagged).toBe(true);
    expect((await parseEmlx(readAndFlagged))?.isUnread).toBe(false);
  });

  test("returns null for files over the size cap", async () => {
    const path = buildEmlx({
      mime: "From: s@e.com\r\nSubject: tiny\r\n\r\nx",
      flags: 0,
    });
    const out = await parseEmlx(path, { maxSizeBytes: 10 });
    expect(out).toBeNull();
  });

  test("throws EmlxParseError on missing byte-count header", async () => {
    const path = join(tmp, "999.emlx");
    writeFileSync(path, "no newline header");
    let caught: unknown = null;
    try {
      await parseEmlx(path);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmlxParseError);
  });

  test("throws EmlxParseError on non-numeric byte-count header", async () => {
    const path = join(tmp, "998.emlx");
    writeFileSync(path, "not-a-number\nMIME body\n");
    let caught: unknown = null;
    try {
      await parseEmlx(path);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmlxParseError);
  });

  test("malformed plist falls back to flags=0 (unread, unflagged)", async () => {
    const mimeBytes = Buffer.from(
      "From: s@e.com\r\nSubject: bad plist\r\nContent-Type: text/plain\r\n\r\nhi\r\n",
      "utf8",
    );
    const path = join(tmp, "777.emlx");
    writeFileSync(path, `${mimeBytes.byteLength}\n${mimeBytes.toString("utf8")}<not-real-xml/>`);
    const out = await parseEmlx(path);
    expect(out?.isUnread).toBe(true);
    expect(out?.isFlagged).toBe(false);
  });
});

describe("inferId", () => {
  test("strips .emlx suffix", () => {
    expect(inferId("/path/to/12345.emlx")).toBe(12345);
  });
  test("strips .partial.emlx suffix", () => {
    expect(inferId("/path/to/9.partial.emlx")).toBe(9);
  });
  test("throws on non-numeric basename", () => {
    expect(() => inferId("/path/to/hello.emlx")).toThrow(EmlxParseError);
  });
});

describe("inferAccountAndMailbox", () => {
  test("simple INBOX path", () => {
    const r = inferAccountAndMailbox("/Users/x/Library/Mail/V10/UUID-AAA/INBOX.mbox/Data/123.emlx");
    expect(r.account).toBe("UUID-AAA");
    expect(r.mailbox).toBe("INBOX");
  });
  test("nested mailbox joins .mbox segments", () => {
    const r = inferAccountAndMailbox(
      "/Users/x/Library/Mail/V10/UUID-BBB/Work.mbox/Projects.mbox/Q1.mbox/Data/9.emlx",
    );
    expect(r.account).toBe("UUID-BBB");
    expect(r.mailbox).toBe("Work/Projects/Q1");
  });
  test("returns empty for malformed path with no V<N> directory", () => {
    const r = inferAccountAndMailbox("/totally/unrelated/file.emlx");
    expect(r.account).toBe("");
    expect(r.mailbox).toBe("");
  });
});
