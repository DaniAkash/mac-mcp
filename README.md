# mac-mcp

A read-only MCP server that exposes data from native macOS apps (Mail, Notes, Calendar, Reminders, Contacts, Messages, Spotlight) to AI agents over stdio.

Bootstrapped with [Vite+](https://viteplus.dev/) and Bun. Status: Mail domain shipping; other domains in the pipeline.

## Status

| Domain               | State          |
| -------------------- | -------------- |
| Mail                 | shipped (v0.1) |
| Notes                | planned        |
| Calendar / Reminders | planned        |
| Contacts             | planned        |
| Messages             | planned        |
| Spotlight            | planned        |

The server is read-only by construction. There is no CLI flag, env var, or config key that enables writes. A regression test sweeps every JXA template for write-capable Apple Events phrases (`set readStatus`, `move to`, `delete`, `send`, etc.) and another sweeps every tool / domain module to ensure they only spawn `osascript`.

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
bun install   # install dependencies
bun test      # run all tests (bun's runner; supports bun:sqlite natively)
bun run check # lint + format + fallow code-quality, in parallel
bun run lint  # vp lint (oxlint with full TS typecheck)
bun run fmt   # vp fmt --check
bun run fmt:fix
bun run build # vp pack
```

## License

MIT
