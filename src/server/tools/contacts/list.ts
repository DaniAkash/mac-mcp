import { z } from "zod";
import { listContacts } from "../../../domains/contacts/addressBook.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  source: z
    .string()
    .optional()
    .describe(
      "Restrict to a single AddressBook source UUID (the directory name under ~/Library/Application Support/AddressBook/Sources). Omit for all sources merged with cross-source dedup.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum contacts to return. Default 50, hard cap 200."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Skip the first N contacts (for pagination). Default 0."),
};

export const TOOL: ToolModule = {
  name: "contacts_list",
  description:
    "List Apple Contacts merged across all AddressBook sources, sorted by display name. Returns summary records with primary email and primary phone.",
  inputShape,
  domain: "contacts",
  handler: async (input) => {
    const args = z.object(inputShape).parse(input);
    return Promise.resolve(
      listContacts({
        source: args.source,
        limit: args.limit,
        offset: args.offset,
      }),
    );
  },
};
