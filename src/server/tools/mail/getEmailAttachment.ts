import { z } from "zod";
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  HARD_MAX_ATTACHMENT_BYTES,
  getAttachment,
} from "../../../domains/mail/extractAttachments.ts";
import { loadEmail } from "../../../domains/mail/index/loadEmail.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  messageId: z.number().int().describe("Mail.app per-mailbox integer id."),
  account: z.string().optional().describe("Account UUID or display name."),
  mailbox: z.string().optional().describe("Mailbox name."),
  attachmentIndex: z
    .number()
    .int()
    .min(0)
    .describe("0-based index from mail_get_email_attachments."),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(HARD_MAX_ATTACHMENT_BYTES)
    .optional()
    .describe(
      `Hard cap on the response payload. Default ${DEFAULT_MAX_ATTACHMENT_BYTES} bytes (5 MiB), absolute max ${HARD_MAX_ATTACHMENT_BYTES} bytes (10 MiB). Larger attachments return an error envelope.`,
    ),
};

export const TOOL: ToolModule = {
  name: "mail_get_email_attachment",
  description:
    "Fetch a single attachment's bytes as base64 by 0-based index. Default cap 5 MiB, hard cap 10 MiB; larger attachments return an error envelope describing the actual size so the caller can decide what to do.",
  inputShape,
  domain: "mail",
  handler: async (input) => {
    const args = z.object(inputShape).parse(input);
    const result = await loadEmail({
      messageId: args.messageId,
      account: args.account,
      mailbox: args.mailbox,
    });
    switch (result.kind) {
      case "envelope_not_accessible":
        return { error: "Mail data not accessible. Grant Full Disk Access and re-run." };
      case "account_unknown":
        return { error: `No account matched display name "${result.account}".` };
      case "envelope_not_found":
        return { error: `No message with id ${args.messageId} found in the Envelope Index.` };
      case "envelope_only":
        return {
          error:
            "Message envelope found but the .emlx is not in the local index. Try again after a sync.",
        };
      case "with_emlx": {
        const got = getAttachment(result.raw, args.attachmentIndex, { maxBytes: args.maxBytes });
        switch (got.kind) {
          case "ok":
            return got.result;
          case "index_out_of_range":
            return {
              error: `attachmentIndex ${args.attachmentIndex} is out of range; this email has ${got.available} attachment(s).`,
            };
          case "too_large":
            return {
              error: "attachment_too_large",
              actualSize: got.actualSize,
              maxBytes: got.maxBytes,
            };
        }
      }
    }
  },
};
