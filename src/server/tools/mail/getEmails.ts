import { z } from "zod";
import { displayNameForUuid, resolveAccountUuid } from "../../../domains/mail/index/accountMap.ts";
import {
  emailSummaryFromEnvelopeRow,
  openEnvelopeIndex,
  queryEmails,
} from "../../../domains/mail/index/envelopeDirect.ts";
import type { EmailSummary, MailCategory } from "../../../domains/mail/mail.types.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  account: z.string().optional().describe("Account display name. Omit for all accounts."),
  mailbox: z.string().optional().describe("Mailbox name, e.g. 'INBOX'. Omit for all mailboxes."),
  category: z
    .enum(["primary", "transactions", "updates", "promotions", "all"])
    .optional()
    .describe("Apple Mail category filter. Requires macOS 15+ with Mail's categoriser enabled."),
  filter: z
    .enum(["all", "unread", "flagged", "today", "last_7_days"])
    .optional()
    .describe("Status / recency filter."),
  group_by: z
    .enum(["none", "unread", "category", "account"])
    .optional()
    .describe("Group the results. Default 'none' returns a flat list."),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("YYYY-MM-DD upper bound (exclusive)."),
  after: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("YYYY-MM-DD lower bound (inclusive)."),
  limit: z.number().int().min(1).max(200).optional().describe("Max emails per group. Default 50."),
};

export const TOOL: ToolModule = {
  name: "mail_get_emails",
  description:
    "List emails sorted by date received (most recent first). Supports filtering by account, mailbox, status, Apple Mail category, and date range, plus optional grouping by unread state, category, or account.",
  inputShape,
  domain: "mail",
  handler: async (input) => {
    const args = z.object(inputShape).parse(input);
    const groupBy = args.group_by ?? "none";
    const limit = args.limit ?? 50;

    const handle = openEnvelopeIndex();
    if (!handle) {
      return {
        ordering: "date_received_desc",
        emails: [],
        hint: "Mail data not accessible. Grant Full Disk Access and re-run.",
      };
    }
    try {
      const accountUuid = args.account ? await resolveAccountUuid(args.account) : null;
      if (args.account && accountUuid === undefined) {
        return {
          ordering: "date_received_desc",
          emails: [],
          hint: `No account matched display name "${args.account}".`,
        };
      }

      const categorySupported = handle.categorySupport.kind === "supported";
      if (args.category && !categorySupported && args.category !== "all") {
        return {
          ordering: "date_received_desc",
          emails: [],
          hint: "Apple Mail categories not available on this macOS version.",
        };
      }
      const effectiveCategory: MailCategory | undefined =
        args.category && args.category !== "all" ? args.category : undefined;

      // For grouping we pull a bigger window so each group has a reasonable
      // tail. For flat output we honour limit exactly.
      const queryLimit = groupBy === "none" ? limit : limit * 4;
      const rows = queryEmails(handle, {
        accountUuid: accountUuid ?? undefined,
        mailbox: args.mailbox,
        filter: args.filter,
        category: effectiveCategory,
        after: args.after,
        before: args.before,
        limit: queryLimit,
      });
      const summaries = await Promise.all(
        rows.map(async (r) => emailSummaryFromEnvelopeRow(r, await displayNameForUuid(r.account))),
      );

      const hint = !categorySupported
        ? "Apple Mail categories not available on this macOS version; category fields will be null."
        : undefined;

      switch (groupBy) {
        case "none":
          return {
            ordering: "date_received_desc",
            emails: summaries.slice(0, limit),
            hint,
          };
        case "unread":
          return {
            ordering: "date_received_desc",
            groups: {
              unread: summaries.filter((e) => e.isUnread).slice(0, limit),
              read: summaries.filter((e) => !e.isUnread).slice(0, limit),
            },
            hint,
          };
        case "category": {
          const groups: Record<string, EmailSummary[]> = {
            primary: [],
            transactions: [],
            updates: [],
            promotions: [],
            uncategorised: [],
          };
          for (const e of summaries) {
            const k = e.category ?? "uncategorised";
            const arr = groups[k] ?? groups.uncategorised;
            if (arr && arr.length < limit) arr.push(e);
          }
          if (!categorySupported) {
            return {
              ordering: "date_received_desc",
              groups: { uncategorised: groups.uncategorised },
              hint,
            };
          }
          return { ordering: "date_received_desc", groups, hint };
        }
        case "account": {
          const groups: Record<string, EmailSummary[]> = {};
          for (const e of summaries) {
            const arr = (groups[e.account] ??= []);
            if (arr.length < limit) arr.push(e);
          }
          return { ordering: "date_received_desc", groups, hint };
        }
        default:
          return {
            ordering: "date_received_desc",
            emails: summaries.slice(0, limit),
            hint,
          };
      }
    } finally {
      handle.close();
    }
  },
};
