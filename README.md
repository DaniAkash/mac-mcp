# mac-mcp

A read-only MCP server that exposes data from native macOS apps (Mail, Notes, Calendar, Reminders, Contacts, Messages, Spotlight) to AI agents over stdio.

Bootstrapped with [Vite+](https://viteplus.dev/) and Bun. Status: Mail domain shipping; other domains in the pipeline.

## Status

| Domain    | State          |
| --------- | -------------- |
| Mail      | shipped (v0.1) |
| Spotlight | shipped        |
| Contacts  | shipped        |
| Calendar  | shipped        |
| Reminders | shipped        |
| Notes     | planned        |
| Messages  | planned        |

The server is read-only by construction. There is no CLI flag, env var, or config key that enables writes. A regression test sweeps every JXA template for write-capable Apple Events phrases (`set readStatus`, `move to`, `delete`, `send`, etc.) and another sweeps every tool / domain module to ensure they only spawn read-only system commands (`osascript`, `mdfind`).

## Requirements

- macOS 14 or newer (15+ unlocks Apple Mail category support)
- [Bun](https://bun.sh) 1.3+
- Full Disk Access granted to your terminal / MCP client (for reading Apple's local data stores)
- Automation permission for Mail.app (granted at first JXA call when listing accounts)

## CLI

```bash
mac-mcp serve            # start the MCP server over stdio (default)
mac-mcp init             # write ~/.mac-mcp/config.toml template
mac-mcp doctor           # probe macOS permissions, print a checklist
mac-mcp status           # print per-domain index health as JSON
mac-mcp index            # bulk-build domain indexes
mac-mcp rebuild --domain <name>   # rebuild a single domain's index
```

## Mail tools (v0.1)

Five read-only MCP tools, plus the `index://status` resource.

| Tool                  | What it does                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mail_list_accounts`  | List all Mail accounts with display names + UUIDs.                                                                                                                                                                                                                  |
| `mail_list_mailboxes` | List mailboxes per account with current unread counts.                                                                                                                                                                                                              |
| `mail_get_emails`     | Recency-sorted email list. Optional `account`, `mailbox`, `category` (primary/transactions/updates/promotions), `filter` (all/unread/flagged/today/last_7_days), `before`/`after` (YYYY-MM-DD), and **`group_by`** to bucket by unread state, category, or account. |
| `mail_get_email`      | Fetch a full email by Mail.app integer id with body, recipients, headers.                                                                                                                                                                                           |
| `mail_search`         | FTS5 BM25 search across subject/sender/body with scope, account, mailbox, category, and date filters.                                                                                                                                                               |

### Apple Mail category awareness

Mail's built-in categorisation (Primary, Transactions, Updates, Promotions) ships natively on macOS 15+. The server probes the `message_global_data.model_category` column at startup and degrades cleanly to category-less output on older macOS. The `category` filter and `group_by: "category"` both honour this gracefully.

### Local index

The Mail domain maintains a SQLite + FTS5 index at `~/.mac-mcp/mail.db`:

- WAL mode, `synchronous=NORMAL`, denormalised `is_unread`/`is_flagged` columns for indexed sorts.
- Disk-first state-reconciliation sync (NEW / DELETED / MOVED diffs in pure SQL).
- Background sync every 5 minutes by default (configurable).
- Dead-letter queue surfaces parse failures via `index://status`.

## Spotlight tool

One read-only tool: `spotlight_search`.

| Input   | Type                              | Default  | Notes                                                                                     |
| ------- | --------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `query` | string                            | required | Plain text or full mdfind metadata query syntax (`kMDItemContentType == "public.image"`). |
| `path`  | string                            | none     | Restrict to this directory tree. Must resolve under `$HOME`.                              |
| `kind`  | `"file"` \| `"folder"` \| `"any"` | `"any"`  | Post-filter on filesystem entry kind.                                                     |
| `limit` | number                            | 25       | Hard cap 100.                                                                             |

The macOS Spotlight index (`mds`) is already maintained by the OS; we never build our own. Subprocess runs `mdfind` with a 5-second per-call timeout; truncated indicates more matches existed beyond the limit.

## Contacts tools

Three read-only tools.

| Tool              | What it does                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `contacts_list`   | Page through contacts merged across every AddressBook source; output is sorted by display name.                                      |
| `contacts_get`    | Fetch a full record by Apple's `ZUNIQUEID` (`<GUID>:ABPerson`). Includes every email, phone, postal address, URL, and the note text. |
| `contacts_search` | Substring search by `name` (first/last/nick/organisation), `email` (normalised), `phone` (digits or last-four), or `all`.            |

Cross-source dedup uses a soft key of `(displayName, primaryEmail)`; collisions keep the source with the higher completeness score and fold the dropped source UUID into the kept record. Phones normalise to E.164 when AddressBook stored the parsed parts (country code + area code + local number); otherwise we strip whitespace and punctuation from the display value. No FTS5 index - LIKE queries against the indexed columns are fast enough at the volumes a personal address book holds.

## Calendar tools

| Tool                      | What it does                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `calendar_list_calendars` | List every calendar with id, title, type (`Local`, `CalDAV`, `Birthdays`, `Subscribed`, etc.) and color. |
| `calendar_list_events`    | Events sorted by start time. Optional calendar id and YYYY-MM-DD date bounds.                            |
| `calendar_get_event`      | Full event by UUID with description and last-modified.                                                   |
| `calendar_search`         | Substring search across title, description, and location with optional date bounds.                      |

Source: `~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb` (modern macOS path). Dates round-trip through Core Data's 2001-01-01 epoch.

## Reminders tools

| Tool                       | What it does                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `reminders_list_lists`     | Every list across every account; `type` distinguishes regular lists from Smart Lists.                |
| `reminders_list_reminders` | Reminders sorted by due date. Optional list id and `open`/`completed`/`all` status (default `open`). |
| `reminders_get_reminder`   | Full reminder by identifier with notes, start/due/completion dates.                                  |
| `reminders_search`         | Substring search across title and notes.                                                             |

Source: one SQLite file per account under `~/Library/Group Containers/group.com.apple.reminders/Container_v1/Stores/`. The domain queries every store and merges results.

## MCP client config

```json
{
  "mcpServers": {
    "mac": {
      "command": "bunx",
      "args": ["-y", "github:DaniAkash/mac-mcp"]
    }
  }
}
```

Run `mac-mcp doctor` after install to verify permissions.

## Development

```bash
bun install        # install dependencies
bun test           # unit + integration tests (CI-safe; e2e tests skip themselves)
bun run test:e2e   # live end-to-end tests; requires macOS + FDA + Mail.app data
bun run check      # lint + format + fallow code-quality, in parallel
bun run lint       # vp lint (oxlint with full TS typecheck)
bun run fmt        # vp fmt --check
bun run fmt:fix
```

There is no build step: Bun executes the TypeScript bin (`src/bin.ts`) directly, both for `bun src/bin.ts` during development and for consumers via `bunx -y github:DaniAkash/mac-mcp`. The package ships its `src/` directory and Bun handles the rest.

### End-to-end tests

`tests/e2e/` contains tests that hit the real Mail.app + Envelope Index on the local machine. They require Full Disk Access and a configured Mail account, so they only run when `MAC_MCP_E2E=1` is set. CI never sets this env var; the tests skip cleanly on every CI run.

Coverage includes the five Mail tools called directly against the live data (sort order, unread / category / account grouping, multi-account filter, get-email round-trip) plus a full MCP stdio round-trip that spawns the actual `mac-mcp serve` binary and drives it as a real MCP client over JSON-RPC.

```bash
# Grant Full Disk Access to your terminal first.
bun run test:e2e
```

## License

MIT
