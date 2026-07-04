import { stat } from "node:fs/promises";
import { basename, sep } from "node:path";
import { type ParsedMail, simpleParser } from "mailparser";
import { stripHtml } from "../../../utils/htmlStripper.ts";
import { decodeFlags, readFlagsFromPlist } from "../../../utils/plistFooter.ts";
import type { EmlxParseResult } from "../mail.types.ts";

const MAX_EMLX_SIZE = 25 * 1024 * 1024;
const HTML_FIELD_CAP = 1024 * 1024;

export interface EmlxParseFullResult {
  stripped: EmlxParseResult;
  raw: ParsedMail;
}

export class EmlxParseError extends Error {
  constructor(
    message: string,
    public readonly type: string,
  ) {
    super(message);
    this.name = "EmlxParseError";
  }
}

export interface ParseOpts {
  /** Override the size cap for tests. */
  maxSizeBytes?: number;
}

/**
 * Parse an .emlx file at the given path. Returns null on file size cap;
 * throws EmlxParseError on any other failure so the caller can route it to
 * the DLQ.
 */
export async function parseEmlx(
  path: string,
  opts: ParseOpts = {},
): Promise<EmlxParseResult | null> {
  const full = await parseEmlxFull(path, opts);
  return full?.stripped ?? null;
}

/**
 * Like parseEmlx but also returns the raw mailparser output so callers that
 * need attachment buffers, HTML, or full header objects do not have to
 * re-read and re-parse the file.
 */
export async function parseEmlxFull(
  path: string,
  opts: ParseOpts = {},
): Promise<EmlxParseFullResult | null> {
  const cap = opts.maxSizeBytes ?? MAX_EMLX_SIZE;
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (e) {
    throw new EmlxParseError(`stat failed: ${(e as Error).message}`, "stat_failed");
  }
  if (size > cap) return null;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  } catch (e) {
    throw new EmlxParseError(`read failed: ${(e as Error).message}`, "read_failed");
  }

  const newlineIdx = bytes.indexOf(0x0a);
  if (newlineIdx === -1) {
    throw new EmlxParseError("missing byte-count header newline", "no_header");
  }
  const headerStr = new TextDecoder("utf-8").decode(bytes.subarray(0, newlineIdx)).trim();
  const byteCount = Number.parseInt(headerStr, 10);
  if (!Number.isFinite(byteCount) || byteCount < 0) {
    throw new EmlxParseError(`invalid byte-count header "${headerStr}"`, "bad_header");
  }
  const mimeStart = newlineIdx + 1;
  const mimeEnd = Math.min(mimeStart + byteCount, bytes.byteLength);
  const mimeBytes = bytes.subarray(mimeStart, mimeEnd);
  const plistBytes = bytes.subarray(mimeEnd);

  let parsed: ParsedMail;
  try {
    parsed = await simpleParser(Buffer.from(mimeBytes));
  } catch (e) {
    throw new EmlxParseError(`MIME parse failed: ${(e as Error).message}`, "mime_failed");
  }

  const flags = decodeFlags(readFlagsFromPlist(plistBytes));
  const body = extractBody(parsed);
  const recipients = extractRecipients(parsed);
  const { account, mailbox } = inferAccountAndMailbox(path);
  const id = inferId(path);

  const html =
    typeof parsed.html === "string" && parsed.html.length > 0
      ? parsed.html.slice(0, HTML_FIELD_CAP)
      : undefined;

  const stripped: EmlxParseResult = {
    id,
    emlxPath: path,
    account,
    mailbox,
    subject: parsed.subject ?? "",
    sender: parsed.from?.text ?? "",
    recipients,
    replyTo: parsed.replyTo?.text ?? "",
    messageIdHeader: parsed.messageId ?? "",
    dateSent: parsed.date?.toISOString() ?? "",
    dateReceived: pickDateReceived(parsed),
    body,
    ...(html !== undefined ? { html } : {}),
    rawHeaders: parsed.headerLines.map((h) => h.line).join("\n"),
    attachmentCount: parsed.attachments?.length ?? 0,
    isUnread: !flags.read,
    isFlagged: flags.flagged,
    isDeleted: flags.deleted,
  };
  return { stripped, raw: parsed };
}

function getTopLevelContentType(parsed: ParsedMail): string {
  const ct = parsed.headers.get("content-type");
  if (typeof ct === "string") {
    const semi = ct.indexOf(";");
    return (semi === -1 ? ct : ct.slice(0, semi)).trim().toLowerCase();
  }
  if (ct && typeof ct === "object" && "value" in ct) {
    const value = (ct as { value: unknown }).value;
    if (typeof value === "string") return value.toLowerCase();
  }
  return "";
}

function extractBody(parsed: ParsedMail): string {
  const contentType = getTopLevelContentType(parsed);
  const htmlStr = typeof parsed.html === "string" && parsed.html.length > 0 ? parsed.html : null;

  // Top-level text/html: skip mailparser's synthesised parsed.text. On real
  // newsletters that synthesis returns empty or leaks raw markup (issue #12).
  // Multipart is unaffected because parsed.text there is the real text/plain
  // child part, not a synthesis.
  if (contentType === "text/html" && htmlStr !== null) {
    const stripped = stripHtml(htmlStr);
    if (stripped.length > 0) return stripped;
  }

  if (typeof parsed.text === "string" && parsed.text.length > 0) {
    return collapseWhitespace(parsed.text);
  }
  if (htmlStr !== null) {
    return stripHtml(htmlStr);
  }
  if (parsed.html === false && typeof parsed.textAsHtml === "string") {
    return stripHtml(parsed.textAsHtml);
  }
  return "";
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function extractRecipients(parsed: ParsedMail): {
  to: string[];
  cc: string[];
  bcc: string[];
} {
  return {
    to: addressArray(parsed.to),
    cc: addressArray(parsed.cc),
    bcc: addressArray(parsed.bcc),
  };
}

function addressArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((v) => addressArray(v));
  }
  if (typeof value === "object" && value !== null && "text" in value) {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") {
      return text
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
  }
  return [];
}

function pickDateReceived(parsed: ParsedMail): string {
  const received = parsed.headers.get("received");
  if (typeof received === "string") {
    const lastSemi = received.lastIndexOf(";");
    if (lastSemi !== -1) {
      const dateStr = received.slice(lastSemi + 1).trim();
      const d = new Date(dateStr);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  if (parsed.date) return parsed.date.toISOString();
  return "";
}

export function inferId(path: string): number {
  const file = basename(path);
  const stripped = file.replace(/\.partial\.emlx$/, "").replace(/\.emlx$/, "");
  const n = Number.parseInt(stripped, 10);
  if (!Number.isFinite(n)) {
    throw new EmlxParseError(`cannot infer integer id from filename "${file}"`, "bad_filename");
  }
  return n;
}

/**
 * Walk forward from the V<N> directory to find the account UUID and the
 * mailbox name. The mailbox name joins every `.mbox`-ending path segment, so
 * a nested folder like `Work.mbox/Projects.mbox/Q1.mbox` reads as
 * "Work/Projects/Q1".
 */
export function inferAccountAndMailbox(path: string): { account: string; mailbox: string } {
  const parts = path.split(sep);
  let mailIndex = -1;
  for (let i = 0; i < parts.length; i++) {
    if (/^V\d+$/.test(parts[i] ?? "")) {
      mailIndex = i;
      break;
    }
  }
  if (mailIndex === -1 || mailIndex + 1 >= parts.length) {
    return { account: "", mailbox: "" };
  }
  const accountRaw = parts[mailIndex + 1] ?? "";
  const account = accountRaw.split(".")[0] ?? accountRaw;
  const mailboxParts: string[] = [];
  for (let i = mailIndex + 2; i < parts.length; i++) {
    const p = parts[i] ?? "";
    if (p.endsWith(".mbox")) {
      mailboxParts.push(p.slice(0, -".mbox".length));
    } else if (mailboxParts.length > 0) {
      break;
    }
  }
  return { account, mailbox: mailboxParts.join("/") };
}
