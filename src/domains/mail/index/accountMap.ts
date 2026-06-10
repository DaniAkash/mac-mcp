import { buildListAccountsScript } from "../../../jxa/builders/mail.ts";
import { MAIL_CORE } from "../../../jxa/cores/mailCore.ts";
import { runJxa } from "../../../jxa/executor.ts";
import type { MailAccount } from "../mail.types.ts";

const TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  accounts: MailAccount[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<MailAccount[]> | null = null;

/**
 * Mail.app account list with a 5-minute in-process TTL. The cold path goes
 * out to JXA; the warm path is instant. Single inflight per fetch so
 * concurrent callers share the same osascript spawn.
 */
export async function getAccounts(opts: { force?: boolean } = {}): Promise<MailAccount[]> {
  const now = Date.now();
  if (!opts.force && cache && now - cache.fetchedAt < TTL_MS) {
    return cache.accounts;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const raw =
        (await runJxa<MailAccount[]>(buildListAccountsScript(), { cores: [MAIL_CORE] })) ?? [];
      const normalised = raw
        .filter(
          (a): a is MailAccount =>
            Boolean(a) && typeof a.id === "string" && typeof a.name === "string",
        )
        .map((a) => ({ name: a.name, id: a.id }));
      cache = { accounts: normalised, fetchedAt: now };
      return normalised;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Resolve a user-supplied display name (or empty string for "all") into an
 * account UUID. Returns null for "all accounts", or undefined when no match.
 */
export async function resolveAccountUuid(
  displayName: string | undefined,
): Promise<string | null | undefined> {
  if (!displayName) return null;
  const accounts = await getAccounts();
  for (const a of accounts) {
    if (a.name === displayName) return a.id;
  }
  const lower = displayName.toLowerCase();
  for (const a of accounts) {
    if (a.name.toLowerCase() === lower) return a.id;
  }
  return undefined;
}

export async function displayNameForUuid(uuid: string): Promise<string> {
  const accounts = await getAccounts();
  for (const a of accounts) {
    if (a.id === uuid) return a.name;
  }
  return uuid;
}

/** Test helper: clear the cache. */
export function _clearAccountMapForTests(): void {
  cache = null;
  inflight = null;
}
