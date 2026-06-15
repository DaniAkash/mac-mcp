export type MailCategory = "primary" | "transactions" | "updates" | "promotions";

export interface MailAccount {
  /** Display name as it appears in Mail.app's sidebar. */
  name: string;
  /** Mail.app's internal UUID for the account. */
  id: string;
}

export interface MailMailbox {
  account: string;
  name: string;
  unreadCount: number;
}

export interface EmailSummary {
  id: number;
  account: string;
  mailbox: string;
  subject: string;
  sender: string;
  preview: string;
  dateReceived: string;
  isUnread: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  category: MailCategory | null;
}

export interface EmailFull {
  id: number;
  account: string;
  mailbox: string;
  subject: string;
  sender: string;
  recipients: { to: string[]; cc: string[]; bcc: string[] };
  replyTo: string;
  messageIdHeader: string;
  dateSent: string;
  dateReceived: string;
  isUnread: boolean;
  isFlagged: boolean;
  category: MailCategory | null;
  body: string;
  rawHeaders?: string;
  attachmentCount: number;
}

export interface SearchResult extends EmailSummary {
  snippet: string;
  bm25Score: number;
}

export type EmailLinkKind = "http" | "mailto" | "tel" | "other";

export interface EmailLink {
  url: string;
  text?: string;
  kind: EmailLinkKind;
  inHeader?: boolean;
}

export interface EmailLinksResult {
  source: "html" | "text" | "both";
  links: EmailLink[];
  totalReturned: number;
  truncated: boolean;
}

export interface AttachmentSummary {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  contentDisposition: "attachment" | "inline";
  contentId?: string;
}

export interface AttachmentsListResult {
  attachments: AttachmentSummary[];
  totalReturned: number;
}

export interface AttachmentBytesResult {
  filename: string;
  contentType: string;
  size: number;
  base64: string;
}

export interface EmlxParseResult {
  id: number;
  emlxPath: string;
  account: string;
  mailbox: string;
  subject: string;
  sender: string;
  recipients: { to: string[]; cc: string[]; bcc: string[] };
  replyTo: string;
  messageIdHeader: string;
  dateSent: string;
  dateReceived: string;
  body: string;
  rawHeaders: string;
  attachmentCount: number;
  isUnread: boolean;
  isFlagged: boolean;
  isDeleted: boolean;
}
