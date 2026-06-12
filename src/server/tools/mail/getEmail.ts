import { z } from "zod";
import { loadEmail } from "../../../domains/mail/index/loadEmail.ts";
import type { EmailFull } from "../../../domains/mail/mail.types.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  messageId: z
    .number()
    .int()
    .describe("Mail.app's per-mailbox integer id (from a list tool result)."),
  account: z.string().optional(),
  mailbox: z.string().optional(),
  includeRawHeaders: z.boolean().optional(),
};

export const TOOL: ToolModule = {
  name: "mail_get_email",
  description:
    "Fetch a full email by Mail.app integer id, with body, headers, and recipient list. Reads from disk via the local index when available; falls back to live Mail.app for messages not yet indexed.",
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
      case "with_emlx": {
        const { envelope, parsed } = result;
        const out: EmailFull = {
          id: args.messageId,
          account: envelope.accountDisplay,
          mailbox: parsed.mailbox,
          subject: parsed.subject,
          sender: parsed.sender,
          recipients: parsed.recipients,
          replyTo: parsed.replyTo,
          messageIdHeader: parsed.messageIdHeader,
          dateSent: parsed.dateSent,
          dateReceived: parsed.dateReceived,
          isUnread: parsed.isUnread,
          isFlagged: parsed.isFlagged,
          category: envelope.category,
          body: parsed.body,
          attachmentCount: parsed.attachmentCount,
        };
        if (args.includeRawHeaders) out.rawHeaders = parsed.rawHeaders;
        return out;
      }
      case "envelope_only": {
        const { envelope } = result;
        const out: EmailFull = {
          id: args.messageId,
          account: envelope.accountDisplay,
          mailbox: envelope.mailbox,
          subject: envelope.subject,
          sender: envelope.sender,
          recipients: { to: [], cc: [], bcc: [] },
          replyTo: "",
          messageIdHeader: "",
          dateSent: envelope.dateSent,
          dateReceived: envelope.dateReceived,
          isUnread: envelope.isUnread,
          isFlagged: envelope.isFlagged,
          category: envelope.category,
          body: "",
          attachmentCount: 0,
        };
        return out;
      }
    }
  },
};
