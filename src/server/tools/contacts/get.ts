import { z } from "zod";
import { getContact } from "../../../domains/contacts/addressBook.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  contactId: z
    .string()
    .min(1)
    .describe(
      "Apple's stable ZUNIQUEID for the contact, e.g. '...:ABPerson'. Obtained from a contacts_list or contacts_search result.",
    ),
};

export const TOOL: ToolModule = {
  name: "contacts_get",
  description:
    "Fetch a full contact record by Apple ZUNIQUEID, including every email, phone, postal address, URL, and the note text. When no source contains the id, returns an error envelope { error: string } instead of throwing.",
  inputShape,
  domain: "contacts",
  handler: async (input) => {
    const args = z.object(inputShape).parse(input);
    const contact = getContact(args.contactId);
    if (!contact) {
      return Promise.resolve({
        error: `No contact found with id "${args.contactId}".`,
      });
    }
    return Promise.resolve(contact);
  },
};
