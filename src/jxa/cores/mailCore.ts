/**
 * JXA core injected before every Mail-domain script. Defines a global
 * `MailCore` with helpers for the things mac-mcp's mail tools need:
 * - listing accounts and mailboxes
 * - resolving an account by display name (fallback to the first account)
 * - resolving a mailbox by name, with an alias map for the cross-provider
 *   naming chaos (Sent vs Sent Items vs Sent Messages vs Sent Mail, etc.)
 * - batchFetch: pulls N properties for an array of messages with one IPC
 *   round trip per property, rather than N x P round trips
 *
 * Every helper is READ-ONLY. Adding a write call here trips the JXA regex
 * sweep in tests/unit/readOnly.test.ts.
 *
 * Exported as a string constant rather than a separate .js file so the
 * bundler includes it in dist; loading via fs.readFileSync at runtime
 * broke `bunx -y github:...` consumers because cores/*.js was not
 * reachable from the bundle entry.
 */
export const MAIL_CORE = `
const Mail = Application("Mail");

const MAILBOX_ALIASES = {
  Inbox: ["INBOX", "Inbox"],
  Sent: ["Sent", "Sent Items", "Sent Messages", "Sent Mail"],
  Drafts: ["Drafts", "Draft"],
  Trash: ["Trash", "Deleted Items", "Deleted Messages", "Bin"],
  Junk: ["Junk", "Junk Email", "Spam", "Bulk Mail"],
  Archive: ["Archive", "All Mail", "[Gmail]/All Mail"],
};

function findAccountByName(name) {
  const accounts = Mail.accounts();
  if (!name) return accounts[0];
  for (const a of accounts) {
    try {
      if (a.name() === name) return a;
    } catch {}
  }
  const lower = name.toLowerCase();
  for (const a of accounts) {
    try {
      if (a.name().toLowerCase() === lower) return a;
    } catch {}
  }
  return null;
}

function findMailboxByName(account, name) {
  if (!account) return null;
  if (!name) return null;
  const boxes = account.mailboxes();
  for (const m of boxes) {
    try {
      if (m.name() === name) return m;
    } catch {}
  }
  let candidates = [name];
  for (const canonical of Object.keys(MAILBOX_ALIASES)) {
    const group = MAILBOX_ALIASES[canonical];
    if (group.indexOf(name) !== -1 || canonical === name) {
      candidates = group;
      break;
    }
  }
  for (const c of candidates) {
    for (const m of boxes) {
      try {
        if (m.name() === c) return m;
      } catch {}
    }
  }
  const lower = name.toLowerCase();
  for (const m of boxes) {
    try {
      if (m.name().toLowerCase() === lower) return m;
    } catch {}
  }
  return null;
}

globalThis.MailCore = {
  listAccounts() {
    const result = [];
    const accounts = Mail.accounts();
    for (const a of accounts) {
      try {
        result.push({ name: a.name(), id: a.id() });
      } catch {}
    }
    return result;
  },

  listMailboxes(accountName) {
    const account = findAccountByName(accountName);
    if (!account) return [];
    const result = [];
    const boxes = account.mailboxes();
    for (const m of boxes) {
      try {
        result.push({ name: m.name(), unreadCount: m.unreadCount() });
      } catch {}
    }
    return result;
  },

  getAccount: findAccountByName,
  getMailbox: findMailboxByName,

  batchFetch(messages, props) {
    const result = {};
    for (const p of props) {
      try {
        result[p] = messages[p]();
      } catch {
        result[p] = [];
      }
    }
    return result;
  },
};
`;
