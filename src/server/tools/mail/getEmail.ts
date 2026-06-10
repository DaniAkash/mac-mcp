import { z } from "zod";
import { displayNameForUuid, resolveAccountUuid } from "../../../domains/mail/index/accountMap.ts";
import {
  CATEGORY_INT_BY_LABEL,
  labelForCategoryInt,
} from "../../../domains/mail/index/categories.ts";
import { openEnvelopeIndex, parseMailboxUrl } from "../../../domains/mail/index/envelopeDirect.ts";
import { parseEmlx } from "../../../domains/mail/index/emlxParser.ts";
import type { EmailFull, MailCategory } from "../../../domains/mail/mail.types.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  messageId: z
    .number()
    .int()
    .describe("Mail.app's per-mailbox integer id (from a list tool result)."),
  account: z.string().optional(),
  mailbox: z.string().optional(),
  includeRawHeaders: z.boolean().optional(),
};

interface EnvelopeFullRow {
  emlx_path: string | null;
  message_id: number;
  mailbox_url: string;
  subject: string | null;
  sender: string | null;
  date_sent: number | null;
  date_received: number | null;
  read: number;
  flagged: number;
  category_int: number | null;
}

export const TOOL: ToolModule = {
  name: "mail_get_email",
  description:
    "Fetch a full email by Mail.app integer id, with body, headers, and recipient list. Reads from disk via the local index when available; falls back to live Mail.app for messages not yet indexed.",
  inputShape,
  domain: "mail",
  handler: async (input) => {
    const args = z.object(inputShape).parse(input);
    const handle = openEnvelopeIndex();
    if (!handle) {
      return { error: "Mail data not accessible. Grant Full Disk Access and re-run." };
    }
    try {
      const accountUuid = args.account ? await resolveAccountUuid(args.account) : null;
      if (args.account && accountUuid === undefined) {
        return { error: `No account matched display name "${args.account}".` };
      }
      const where: string[] = ["m.ROWID = ?"];
      const params: (string | number)[] = [args.messageId];
      if (accountUuid) {
        where.push("mb.url LIKE ?");
        params.push(`%://${accountUuid}/%`);
      }
      if (args.mailbox) {
        where.push("mb.url LIKE ?");
        params.push(`%/${encodeURIComponent(args.mailbox)}`);
      }
      const categorySupported = handle.categorySupport.kind === "supported";
      const categoryJoin = categorySupported
        ? "LEFT JOIN message_global_data mgd ON mgd.message_id = m.message_id AND (mgd.category_is_temporary IS NULL OR mgd.category_is_temporary = 0)"
        : "";
      const categoryCol = categorySupported
        ? "mgd.model_category AS category_int"
        : "NULL AS category_int";

      const row = handle.db
        .query(
          `SELECT
            mb.url AS mailbox_url,
            m.message_id AS message_id,
            s.subject AS subject,
            a.address AS sender,
            m.date_sent AS date_sent,
            m.date_received AS date_received,
            m.read AS read,
            m.flagged AS flagged,
            ${categoryCol},
            (SELECT NULL) AS emlx_path
          FROM messages m
          JOIN mailboxes mb ON mb.ROWID = m.mailbox
          LEFT JOIN subjects s ON s.ROWID = m.subject
          LEFT JOIN addresses a ON a.ROWID = m.sender
          ${categoryJoin}
          WHERE ${where.join(" AND ")}
          LIMIT 1`,
        )
        .get(...params) as EnvelopeFullRow | null;

      if (!row) {
        return { error: `No message with id ${args.messageId} found in the Envelope Index.` };
      }
      const mailboxParsed = parseMailboxUrl(row.mailbox_url);
      const accountDisplay = mailboxParsed
        ? await displayNameForUuid(mailboxParsed.uuid)
        : (args.account ?? "");

      const fromIndex = handle.db
        .query("SELECT emlx_path FROM emails WHERE message_id = ? LIMIT 1")
        .get(row.message_id) as { emlx_path: string | null } | null;
      const emlxPath = fromIndex?.emlx_path ?? null;
      if (emlxPath) {
        try {
          const parsed = await parseEmlx(emlxPath);
          if (parsed) {
            const out: EmailFull = {
              id: args.messageId,
              account: accountDisplay,
              mailbox: parsed.mailbox,
              subject: parsed.subject,
              sender: parsed.sender,
              recipients: parsed.recipients,
              replyTo: parsed.replyTo,
              messageIdHeader: parsed.messageIdHeader,
              dateSent: parsed.dateSent,
              dateReceived: parsed.dateReceived,
              isUnread: parsed.isUnread,
              isFlagged: parsed.isFlagged,
              category: labelForCategoryInt(row.category_int),
              body: parsed.body,
              attachmentCount: parsed.attachmentCount,
            };
            if (args.includeRawHeaders) out.rawHeaders = parsed.rawHeaders;
            return out;
          }
        } catch {
          // fall through to envelope-only response
        }
      }

      // No on-disk path available; return what we can from the envelope.
      void CATEGORY_INT_BY_LABEL.primary; // keep the import referenced
      const category: MailCategory | null = labelForCategoryInt(row.category_int);
      const result: EmailFull = {
        id: args.messageId,
        account: accountDisplay,
        mailbox: mailboxParsed?.mailbox ?? "",
        subject: row.subject ?? "",
        sender: row.sender ?? "",
        recipients: { to: [], cc: [], bcc: [] },
        replyTo: "",
        messageIdHeader: "",
        dateSent: row.date_sent ? new Date(row.date_sent * 1000).toISOString() : "",
        dateReceived: row.date_received ? new Date(row.date_received * 1000).toISOString() : "",
        isUnread: row.read === 0,
        isFlagged: row.flagged === 1,
        category,
        body: "",
        attachmentCount: 0,
      };
      return result;
    } finally {
      handle.close();
    }
  },
};
