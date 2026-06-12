import type { ParsedMail } from "mailparser";
import type {
  AttachmentBytesResult,
  AttachmentSummary,
  AttachmentsListResult,
} from "./mail.types.ts";

export const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const HARD_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function listAttachments(parsed: ParsedMail): AttachmentsListResult {
  const items = parsed.attachments ?? [];
  const attachments: AttachmentSummary[] = items.map((att, index) => {
    const size = att.size ?? att.content?.byteLength ?? 0;
    const summary: AttachmentSummary = {
      index,
      filename: att.filename ?? "",
      contentType: att.contentType ?? "application/octet-stream",
      size,
      contentDisposition: att.contentDisposition === "inline" ? "inline" : "attachment",
    };
    if (att.cid) summary.contentId = att.cid;
    return summary;
  });
  return { attachments, totalReturned: attachments.length };
}

export type GetAttachmentResult =
  | { kind: "ok"; result: AttachmentBytesResult }
  | { kind: "index_out_of_range"; available: number }
  | { kind: "too_large"; actualSize: number; maxBytes: number };

export function getAttachment(
  parsed: ParsedMail,
  attachmentIndex: number,
  opts: { maxBytes?: number } = {},
): GetAttachmentResult {
  const max = Math.min(opts.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES, HARD_MAX_ATTACHMENT_BYTES);
  const items = parsed.attachments ?? [];
  if (attachmentIndex < 0 || attachmentIndex >= items.length) {
    return { kind: "index_out_of_range", available: items.length };
  }
  const att = items[attachmentIndex];
  if (!att) return { kind: "index_out_of_range", available: items.length };
  const buf = att.content ?? Buffer.alloc(0);
  const size = att.size ?? buf.byteLength;
  if (size > max) return { kind: "too_large", actualSize: size, maxBytes: max };
  return {
    kind: "ok",
    result: {
      filename: att.filename ?? "",
      contentType: att.contentType ?? "application/octet-stream",
      size,
      base64: buf.toString("base64"),
    },
  };
}
