export const CONFIG_TEMPLATE = `# mac-mcp configuration
# All keys are optional. Anything not set falls back to a built-in default.
# Every key has a matching environment variable prefixed with MAC_MCP_.
# Resolution order: CLI flag > env var > this file > default.

config_version = 1

[domains]
# Which domains to expose. Disable a domain to skip its tool registration
# AND its index build. Removing a domain here is the only way to avoid
# prompting the user for the matching macOS permission.
# enabled = ["mail", "notes", "calendar", "reminders", "contacts", "messages", "spotlight"]
# env: MAC_MCP_DOMAINS_ENABLED (comma-separated)

[index]
# Where per-domain SQLite indexes live. The directory is created 0o700 on first use.
# path = "~/.mac-mcp"
# env: MAC_MCP_INDEX_PATH

# Number of hours since last sync before status surfaces a "stale" warning.
# staleness_hours = 24
# env: MAC_MCP_INDEX_STALENESS_HOURS

[mail]
# Cap the number of emails ingested per mailbox during a full build.
# Set to 0 for uncapped (use uncapped only if you know your largest mailbox fits).
# max_emails_per_mailbox = 5000
# env: MAC_MCP_MAIL_MAX_EMAILS_PER_MAILBOX

# Mailbox display names to skip entirely. An EMPTY array means "no exclusions",
# not "fall back to default": the default is ["Drafts"].
# exclude_mailboxes = ["Drafts"]
# env: MAC_MCP_MAIL_EXCLUDE_MAILBOXES (comma-separated)

# Account display name used when a tool input does not specify one.
# Empty string means "all accounts".
# default_account = ""
# env: MAC_MCP_MAIL_DEFAULT_ACCOUNT

# Mailbox name used when a tool input does not specify one.
# Empty string means "all mailboxes".
# default_mailbox = ""
# env: MAC_MCP_MAIL_DEFAULT_MAILBOX

# How often (seconds) the server re-syncs the Mail index in the background.
# Minimum 30.
# sync_interval_seconds = 300
# env: MAC_MCP_MAIL_SYNC_INTERVAL_SECONDS
`;
