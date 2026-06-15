import { z } from "zod";
import { extractLinks } from "../../../domains/mail/extractLinks.ts";
import { loadEmail } from "../../../domains/mail/index/loadEmail.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  messageId: z
    .number()
    .int()
    .describe("Mail.app's per-mailbox integer id (same as mail_get_email)."),
  account: z.string().optional().describe("Account UUID or display name."),
  mailbox: z.string().optional().describe("Mailbox name. Use mail_list_mailboxes to discover."),
  kinds: z
    .array(z.enum(["http", "mailto", "tel"]))
    .optional()
    .describe("Restrict to these URL schemes. Default: all of them."),
  dedupe: z.boolean().optional().describe("Collapse duplicate URLs. Default true."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Max links to return. Default 100, hard cap 500."),
};

export const TOOL: ToolModule = {
  name: "mail_get_email_links",
  description:
    "Extract URLs from an email's HTML body, plaintext body, and the List-Unsubscribe / List-Help / List-Archive headers. Returns dedup'd `(url, kind, text?, inHeader?)` records sorted by appearance.",
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
            "Message envelope found but the .emlx is not in the local index. Try again after a sync, or use mail_get_email to confirm the envelope-only view.",
        };
      case "with_emlx":
        return extractLinks(result.raw, {
          kinds: args.kinds,
          dedupe: args.dedupe,
          limit: args.limit,
        });
    }
  },
};
