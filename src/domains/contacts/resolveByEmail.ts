import { getContact, searchContacts } from "./addressBook.ts";
import type { ContactSummary } from "./contacts.types.ts";

/**
 * Exact-email contact lookup. Substring matches on `foo@bar.com` are
 * filtered out by re-checking the contact's full email list before
 * returning. Returns null when nothing matches.
 */
export function resolveContactByEmail(email: string): ContactSummary | null {
  return resolveContactByEmailWith(email, {
    search: (q) => searchContacts({ query: q, field: "email", limit: 25 }).results,
    fullEmails: (id) => getContact(id)?.emails.map((e) => e.address) ?? [],
  });
}

export interface ResolutionDeps {
  search: (lowercaseEmail: string) => ContactSummary[];
  fullEmails: (id: string) => string[];
}

export function resolveContactByEmailWith(
  email: string,
  deps: ResolutionDeps,
): ContactSummary | null {
  const target = email.trim().toLowerCase();
  if (target.length === 0) return null;
  for (const summary of deps.search(target)) {
    if (summary.primaryEmail?.toLowerCase() === target) return summary;
    const emails = deps.fullEmails(summary.id);
    if (emails.some((addr) => addr.toLowerCase() === target)) return summary;
  }
  return null;
}
