# mac-mcp

A read-only MCP server that exposes data from native macOS apps (Mail, Notes, Calendar, Reminders, Contacts, Messages, Spotlight) to AI agents over stdio.

Bootstrapped with [Vite+](https://viteplus.dev/) and Bun. Status: shared infrastructure in place, no domain tools wired yet.

## Status

| Domain               | State   |
| -------------------- | ------- |
| Mail                 | next up |
| Notes                | planned |
| Calendar / Reminders | planned |
| Contacts             | planned |
| Messages             | planned |
| Spotlight            | planned |

The server is read-only by construction. There is no CLI flag, env var, or config key that enables writes. A regression test sweeps every JXA template for write-capable Apple Events phrases (`set readStatus`, `move to`, `delete`, `send`, etc.) and another sweeps every tool / domain module to ensure they only spawn `osascript`.

## Requirements

- macOS 14 or newer
- [Bun](https://bun.sh) 1.3+
- Full Disk Access granted to your terminal / MCP client (for reading Apple's local data stores once Mail and other domains land)

## CLI

```bash
mac-mcp serve            # start the MCP server over stdio (default)
mac-mcp init             # write ~/.mac-mcp/config.toml template
mac-mcp doctor           # probe macOS permissions, print a checklist
mac-mcp status           # print per-domain index health as JSON
mac-mcp index            # (no-op until the first domain lands)
mac-mcp rebuild --domain <name>   # (no-op until the first domain lands)
```

## Development

```bash
vp install   # install dependencies
vp test      # run unit tests
vp pack      # build the library
vp dev       # build in watch mode
vp check     # lint + format + typecheck
```

## License

MIT
