import type { Config } from "../../config/configSchema.ts";
import { DEFAULT_INDEX_DIR } from "../../constants.ts";
import type { DomainIndexStatus, DomainPlugin } from "../../types.ts";
import { logger } from "../../utils/logger.ts";
import { TOOL as getEmailTool } from "../../server/tools/mail/getEmail.ts";
import { TOOL as getEmailLinksTool } from "../../server/tools/mail/getEmailLinks.ts";
import { TOOL as getEmailsTool } from "../../server/tools/mail/getEmails.ts";
import { TOOL as listAccountsTool } from "../../server/tools/mail/listAccounts.ts";
import { TOOL as listMailboxesTool } from "../../server/tools/mail/listMailboxes.ts";
import { TOOL as searchTool } from "../../server/tools/mail/search.ts";
import { getMailIndex } from "./index/manager.ts";

let initialised = false;

export function buildMailPlugin(config: Config): DomainPlugin {
  if (!initialised) {
    const indexDir = config.index.path || DEFAULT_INDEX_DIR;
    const mgr = getMailIndex({
      indexDir,
      maxEmailsPerMailbox: config.mail.max_emails_per_mailbox,
      excludeMailboxes: config.mail.exclude_mailboxes,
      syncIntervalSeconds: config.mail.sync_interval_seconds,
    });
    mgr.startBackgroundSync();
    initialised = true;
    logger.info("mail plugin initialised", { indexDir });
  }

  return {
    name: "mail",
    tools: [
      listAccountsTool,
      listMailboxesTool,
      getEmailsTool,
      getEmailTool,
      getEmailLinksTool,
      searchTool,
    ],
    async getIndexStatus(): Promise<DomainIndexStatus> {
      try {
        const snapshot = getMailIndex().getStatus();
        return snapshot as unknown as DomainIndexStatus;
      } catch (e) {
        return { available: false, reason: (e as Error).message };
      }
    },
  };
}
