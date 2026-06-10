import { z } from "zod";
import { displayNameForUuid, resolveAccountUuid } from "../../../domains/mail/index/accountMap.ts";
import { getMailIndex } from "../../../domains/mail/index/manager.ts";
import { searchEmails } from "../../../domains/mail/index/search.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  query: z
    .string()
    .min(1)
    .describe("FTS5 search query. Supports phrases, AND/OR/NOT, and trailing * prefix."),
  scope: z.enum(["all", "subject", "sender", "body"]).optional(),
  account: z.string().optional(),
  mailbox: z.string().optional(),
  category: z.enum(["primary", "transactions", "updates", "promotions", "all"]).optional(),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  after: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  highlight: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
};

export const TOOL: ToolModule = {
  name: "mail_search",
  description:
    "Full-text search across indexed email subject, sender, and body. Sorted by BM25 relevance, then date received. Optional scope, account, mailbox, category, and date range filters.",
  inputShape,
  domain: "mail",
  handler: async (input) => {
    const args = z.object(inputShape).parse(input);
    let index;
    try {
      index = getMailIndex();
    } catch {
      return { results: [], hint: "Mail index not initialised yet." };
    }
    const accountUuid = args.account ? await resolveAccountUuid(args.account) : null;
    if (args.account && accountUuid === undefined) {
      return { results: [], hint: `No account matched display name "${args.account}".` };
    }
    const effectiveCategory = args.category && args.category !== "all" ? args.category : undefined;

    // The local index stores `emails.account` as the Apple UUID (set by the
    // sync pipeline from the on-disk path). Filter by UUID, then translate
    // back to display name in the response for parity with the other tools.
    const rawResults = searchEmails(index.getDb(), {
      query: args.query,
      scope: args.scope,
      account: accountUuid ?? undefined,
      mailbox: args.mailbox,
      category: effectiveCategory,
      before: args.before,
      after: args.after,
      highlight: args.highlight,
      limit: args.limit,
      offset: args.offset,
    });
    const results = await Promise.all(
      rawResults.map(async (r) => ({ ...r, account: await displayNameForUuid(r.account) })),
    );
    return {
      ordering: "bm25_then_date_received_desc",
      results,
      totalMatching: results.length,
    };
  },
};
