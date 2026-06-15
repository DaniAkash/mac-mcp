import { z } from "zod";
import { listAttachments } from "../../../domains/mail/extractAttachments.ts";
import { loadEmail } from "../../../domains/mail/index/loadEmail.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  messageId: z.number().int().describe("Mail.app per-mailbox integer id."),
  account: z.string().optional().describe("Account UUID or display name."),
  mailbox: z.string().optional().describe("Mailbox name."),
};

export const TOOL: ToolModule = {
  name: "mail_get_email_attachments",
  description:
    "List metadata for every attachment on an email (filename, content type, size, disposition, optional content-id). Use mail_get_email_attachment to fetch the bytes for a specific entry.",
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
      case "with_emlx":
        return listAttachments(result.raw);
    }
  },
};
