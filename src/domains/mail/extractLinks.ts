import * as cheerio from "cheerio";
import type { ParsedMail } from "mailparser";
import type { EmailLink, EmailLinkKind, EmailLinksResult } from "./mail.types.ts";

const HEADERS_TO_SCAN = ["list-unsubscribe", "list-help", "list-archive"];

const URL_REGEX = /\b(?:https?:\/\/|mailto:|tel:)[^\s<>"'`]+/gi;

export interface ExtractLinksOpts {
  kinds?: EmailLinkKind[];
  dedupe?: boolean;
  limit?: number;
}

export function extractLinks(parsed: ParsedMail, opts: ExtractLinksOpts = {}): EmailLinksResult {
  const wantedKinds: ReadonlySet<EmailLinkKind> | null = opts.kinds ? new Set(opts.kinds) : null;
  const dedupe = opts.dedupe ?? true;
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));

  const html = typeof parsed.html === "string" ? parsed.html : "";
  const text = typeof parsed.text === "string" ? parsed.text : "";

  const fromHtml = html.length > 0 ? extractHtmlAnchors(html) : [];
  const fromText = text.length > 0 ? extractTextUrls(text) : [];
  const fromHeaders = extractHeaderLinks(parsed);

  // mailparser synthesises `text` from `html` when only HTML is present, so
  // matching URLs in both streams does NOT mean the email body had two
  // independent sources. Classify "both" only when the text stream surfaces
  // a URL that the HTML stream did not.
  const htmlUrlSet = new Set(fromHtml.map((l) => normaliseForKey(l.url)));
  const textHasUnique = fromText.some((l) => !htmlUrlSet.has(normaliseForKey(l.url)));
  const source: EmailLinksResult["source"] =
    fromHtml.length > 0 ? (textHasUnique ? "both" : "html") : "text";

  const combined: EmailLink[] = [...fromHtml, ...fromText, ...fromHeaders];
  const kindFiltered = wantedKinds ? combined.filter((l) => wantedKinds.has(l.kind)) : combined;
  const deduped = dedupe ? dedupeLinks(kindFiltered) : kindFiltered;
  const truncated = deduped.length > limit;
  const capped = deduped.slice(0, limit);
  return {
    source,
    links: capped,
    totalReturned: capped.length,
    truncated,
  };
}

function extractHtmlAnchors(html: string): EmailLink[] {
  const $ = cheerio.load(html);
  const out: EmailLink[] = [];
  $("a[href]").each((_, el) => {
    const rawHref = $(el).attr("href");
    if (!rawHref) return;
    const href = rawHref.trim();
    if (href.length === 0 || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) {
      return;
    }
    const text = collapseWhitespace($(el).text());
    const link: EmailLink = { url: href, kind: classify(href) };
    if (text.length > 0) link.text = text;
    out.push(link);
  });
  return out;
}

function extractTextUrls(text: string): EmailLink[] {
  const out: EmailLink[] = [];
  for (const match of text.matchAll(URL_REGEX)) {
    const url = trimTrailingPunctuation(match[0]);
    if (url.length === 0) continue;
    out.push({ url, kind: classify(url) });
  }
  return out;
}

function extractHeaderLinks(parsed: ParsedMail): EmailLink[] {
  const out: EmailLink[] = [];
  for (const headerLine of parsed.headerLines ?? []) {
    if (!HEADERS_TO_SCAN.includes(headerLine.key.toLowerCase())) continue;
    const colon = headerLine.line.indexOf(":");
    if (colon < 0) continue;
    const value = headerLine.line.slice(colon + 1).trim();
    for (const m of value.matchAll(/<([^>]+)>/g)) {
      const url = m[1]?.trim();
      if (!url) continue;
      out.push({ url, kind: classify(url), inHeader: true });
    }
  }
  return out;
}

function classify(url: string): EmailLinkKind {
  const lower = url.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) return "http";
  if (lower.startsWith("mailto:")) return "mailto";
  if (lower.startsWith("tel:")) return "tel";
  return "other";
}

function dedupeLinks(links: EmailLink[]): EmailLink[] {
  const out: EmailLink[] = [];
  const seen = new Map<string, number>();
  for (const link of links) {
    const key = `${link.kind}|${normaliseForKey(link.url)}|${link.inHeader ? "h" : "b"}`;
    const existingIdx = seen.get(key);
    if (existingIdx === undefined) {
      seen.set(key, out.length);
      out.push(link);
      continue;
    }
    const existing = out[existingIdx];
    if (existing && !existing.text && link.text) existing.text = link.text;
  }
  return out;
}

function normaliseForKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

function trimTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?)\]}>'"]+$/, "");
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
