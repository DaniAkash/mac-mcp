import type { ParsedMail } from "mailparser";
import type { EmlxParseResult, MailCategory } from "../mail.types.ts";
import { displayNameForUuid, resolveAccountUuid } from "./accountMap.ts";
import { labelForCategoryInt } from "./categories.ts";
import { encodeMailboxPath, openEnvelopeIndex, parseMailboxUrl } from "./envelopeDirect.ts";
import { parseEmlxFull } from "./emlxParser.ts";
import { getMailIndex } from "./manager.ts";

export interface LoadEmailArgs {
  messageId: number;
  account?: string;
  mailbox?: string;
}

export interface EnvelopeContext {
  messageId: number;
  accountUuid: string;
  accountDisplay: string;
  mailbox: string;
  subject: string;
  sender: string;
  dateSent: string;
  dateReceived: string;
  isUnread: boolean;
  isFlagged: boolean;
  category: MailCategory | null;
}

export type LoadEmailResult =
  | { kind: "envelope_not_accessible" }
  | { kind: "account_unknown"; account: string }
  | { kind: "envelope_not_found" }
  | { kind: "envelope_only"; envelope: EnvelopeContext }
  | {
      kind: "with_emlx";
      envelope: EnvelopeContext;
      emlxPath: string;
      parsed: EmlxParseResult;
      raw: ParsedMail;
    };

interface EnvelopeRow {
  mailbox_url: string;
  subject: string | null;
  sender: string | null;
  date_sent: number | null;
  date_received: number | null;
  read: number;
  flagged: number;
  category_int: number | null;
}

/**
 * Locate an email by `(messageId, account?, mailbox?)` and, where possible,
 * load and parse the underlying .emlx so callers can inspect the body,
 * headers, or attachment buffers. Returns a discriminated union so each
 * caller maps failures to whatever error envelope its tool exposes.
 */
export async function loadEmail(args: LoadEmailArgs): Promise<LoadEmailResult> {
  const handle = openEnvelopeIndex();
  if (!handle) return { kind: "envelope_not_accessible" };
  try {
    const accountUuid = args.account ? await resolveAccountUuid(args.account) : null;
    if (args.account && accountUuid === undefined) {
      return { kind: "account_unknown", account: args.account };
    }

    const where: string[] = ["m.ROWID = ?"];
    const params: (string | number)[] = [args.messageId];
    if (accountUuid) {
      where.push("mb.url LIKE ?");
      params.push(`%://${accountUuid}/%`);
    }
    if (args.mailbox) {
      where.push("mb.url LIKE ?");
      params.push(`%/${encodeMailboxPath(args.mailbox)}`);
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
          s.subject AS subject,
          a.address AS sender,
          m.date_sent AS date_sent,
          m.date_received AS date_received,
          m.read AS read,
          m.flagged AS flagged,
          ${categoryCol}
        FROM messages m
        JOIN mailboxes mb ON mb.ROWID = m.mailbox
        LEFT JOIN subjects s ON s.ROWID = m.subject
        LEFT JOIN addresses a ON a.ROWID = m.sender
        ${categoryJoin}
        WHERE ${where.join(" AND ")}
        LIMIT 1`,
      )
      .get(...params) as EnvelopeRow | null;

    if (!row) return { kind: "envelope_not_found" };

    const mailboxParsed = parseMailboxUrl(row.mailbox_url);
    const accountDisplay = mailboxParsed
      ? await displayNameForUuid(mailboxParsed.uuid)
      : (args.account ?? "");
    const envelope: EnvelopeContext = {
      messageId: args.messageId,
      accountUuid: mailboxParsed?.uuid ?? "",
      accountDisplay,
      mailbox: mailboxParsed?.mailbox ?? "",
      subject: row.subject ?? "",
      sender: row.sender ?? "",
      dateSent: row.date_sent ? new Date(row.date_sent * 1000).toISOString() : "",
      dateReceived: row.date_received ? new Date(row.date_received * 1000).toISOString() : "",
      isUnread: row.read === 0,
      isFlagged: row.flagged === 1,
      category: labelForCategoryInt(row.category_int),
    };

    const emlxPath = await lookupEmlxPath({
      messageId: args.messageId,
      accountUuid: envelope.accountUuid,
      mailbox: envelope.mailbox,
    });
    if (!emlxPath) return { kind: "envelope_only", envelope };

    try {
      const full = await parseEmlxFull(emlxPath);
      if (!full) return { kind: "envelope_only", envelope };
      return {
        kind: "with_emlx",
        envelope,
        emlxPath,
        parsed: full.stripped,
        raw: full.raw,
      };
    } catch {
      return { kind: "envelope_only", envelope };
    }
  } finally {
    handle.close();
  }
}

async function lookupEmlxPath(args: {
  messageId: number;
  accountUuid: string;
  mailbox: string;
}): Promise<string | null> {
  if (!args.accountUuid) return null;
  try {
    const localDb = getMailIndex().getDb();
    const row = localDb
      .query(
        "SELECT emlx_path FROM emails WHERE message_id = ? AND account = ? AND mailbox = ? LIMIT 1",
      )
      .get(args.messageId, args.accountUuid, args.mailbox) as { emlx_path: string | null } | null;
    return row?.emlx_path ?? null;
  } catch {
    return null;
  }
}
