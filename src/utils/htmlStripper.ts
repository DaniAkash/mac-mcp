import * as cheerio from "cheerio";

/**
 * Convert an HTML string to plaintext using a real parser. Never uses regex;
 * regex-based stripping has well-known XSS-style bypasses (`<<script>>` etc).
 */
export function stripHtml(html: string): string {
  if (html.length === 0) return "";
  const $ = cheerio.load(html);
  $("script, style, noscript, head, title, link, meta").remove();
  const text = $("body").text() || $.root().text();
  return collapseWhitespace(text);
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
