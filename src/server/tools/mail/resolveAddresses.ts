import { z } from "zod";
import { resolveContactByEmail } from "../../../domains/contacts/resolveByEmail.ts";
import type { ContactSummary } from "../../../domains/contacts/contacts.types.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  emails: z
    .array(z.email())
    .min(1)
    .max(100)
    .describe(
      "Email addresses (bare, no display-name wrapper) to look up in the local AddressBook.",
    ),
};

interface ResolutionMatch {
  email: string;
  contact: ContactSummary | null;
}

interface ResolutionResult {
  matches: ResolutionMatch[];
}

export const TOOL: ToolModule = {
  name: "mail_resolve_addresses",
  description:
    "Bulk-resolve up to 100 bare email addresses against the local Contacts AddressBook. Returns one match per input email (contact summary on exact match, null otherwise). Substring matches are filtered out; only exact email matches qualify.",
  inputShape,
  domain: "mail",
  handler: (input) => {
    const args = z.object(inputShape).parse(input);
    const matches: ResolutionMatch[] = args.emails.map((email) => ({
      email: email.toLowerCase(),
      contact: resolveContactByEmail(email),
    }));
    const result: ResolutionResult = { matches };
    return Promise.resolve(result);
  },
};
