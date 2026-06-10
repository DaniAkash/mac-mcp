import { z } from "zod";
import { displayNameForUuid, resolveAccountUuid } from "../../../domains/mail/index/accountMap.ts";
import { listMailboxes, openEnvelopeIndex } from "../../../domains/mail/index/envelopeDirect.ts";
import type { MailMailbox } from "../../../domains/mail/mail.types.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  account: z.string().optional().describe("Account display name. Omit for all accounts."),
};

export const TOOL: ToolModule = {
  name: "mail_list_mailboxes",
  description:
    "List mailboxes (folders) across one or all Apple Mail accounts. Returns each mailbox's account, name, and current unread count.",
  inputShape,
  domain: "mail",
  handler: async (input) => {
    const { account } = z.object(inputShape).parse(input);
    const handle = openEnvelopeIndex();
    if (!handle) {
      return {
        mailboxes: [],
        hint: "Mail data not accessible. Grant Full Disk Access and re-run.",
      };
    }
    try {
      const accountUuid = account ? await resolveAccountUuid(account) : null;
      if (account && accountUuid === undefined) {
        return { mailboxes: [], hint: `No account matched display name "${account}".` };
      }
      const rows = listMailboxes(handle.db, accountUuid ?? undefined);
      const mailboxes: MailMailbox[] = [];
      for (const r of rows) {
        mailboxes.push({
          account: await displayNameForUuid(r.account),
          name: r.name,
          unreadCount: r.unreadCount,
        });
      }
      return { mailboxes };
    } finally {
      handle.close();
    }
  },
};
