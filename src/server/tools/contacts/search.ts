import { z } from "zod";
import { searchContacts } from "../../../domains/contacts/addressBook.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  query: z
    .string()
    .min(1)
    .describe(
      "Substring to look for. Case-insensitive for emails (uses ZADDRESSNORMALIZED). For phones, non-digit characters are stripped before matching ZFULLNUMBER or ZLASTFOURDIGITS.",
    ),
  field: z
    .enum(["name", "email", "phone", "all"])
    .optional()
    .describe(
      "Which field to search. 'name' matches first/last/nick/organisation. 'email' matches the normalised address. 'phone' matches digits or the last four digits. 'all' (default) unions every field.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max results to return. Default 25, hard cap 100."),
};

export const TOOL: ToolModule = {
  name: "contacts_search",
  description:
    "Search Apple Contacts by name, email, phone, or all fields. Returns summary records merged across sources.",
  inputShape,
  domain: "contacts",
  handler: async (input) => {
    const args = z.object(inputShape).parse(input);
    return Promise.resolve(
      searchContacts({ query: args.query, field: args.field, limit: args.limit }),
    );
  },
};
