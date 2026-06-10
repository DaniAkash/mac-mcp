/**
 * JXA script builders for the Mail domain. Every untrusted string is
 * `JSON.stringify`-inlined into the script body, which makes JXA injection
 * impossible by construction. The read-only sweep in
 * tests/unit/readOnly.test.ts rejects any write-capable Apple Events phrase
 * that might sneak in.
 */

export function buildListAccountsScript(): string {
  return `JSON.stringify(MailCore.listAccounts());`;
}
