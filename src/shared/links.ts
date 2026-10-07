import type { ChatLink, LinkRule } from "./types";
import { ticketUrl } from "./validation";

export const MAX_EVENT_LINKS = 100;
export const MAX_CHAT_LINKS = 1000;

// Extract only explicit web URLs. No page requests, provider storage or title lookup.
export function detectLinks(text: string): Pick<ChatLink, "url" | "label">[] {
  const found = new Map<string, Pick<ChatLink, "url" | "label">>();
  const input = text.slice(0, 262144);
  const pattern = /https?:\/\/[^\s<>"'`]+/gi;
  for (let match = pattern.exec(input); match; match = pattern.exec(input)) {
    const prefix = input.slice(Math.max(0, match.index - 550), match.index);
    const markdown = /\[([^\]\n]{1,500})\]\(\s*<?$/.exec(prefix);
    let candidate = match[0];
    if (markdown && !prefix.endsWith("<")) {
      let depth = 0;
      for (let i = 0; i < candidate.length; i++) {
        if (candidate[i] === "(") depth++;
        else if (candidate[i] === ")") {
          if (!depth) {
            candidate = candidate.slice(0, i);
            pattern.lastIndex = match.index + i;
            break;
          }
          depth--;
        }
      }
    }
    if (candidate.length > 2100) continue;
    candidate = candidate.replace(/[.,;:!?]+$/, "");
    // Prose and Markdown can close a URL with punctuation; balanced brackets
    // within the address are retained (e.g. a wiki page named Function_(math)).
    const brackets = [["(", ")"], ["[", "]"], ["{", "}"]];
    const excess = new Map(brackets.map(([open, close]) => [close, candidate.split(close).length - candidate.split(open).length]));
    for (let changed = true; changed;) {
      changed = false;
      for (const [, close] of brackets) {
        if (candidate.endsWith(close) && excess.get(close)! > 0) {
          candidate = candidate.slice(0, -1).replace(/[.,;:!?]+$/, "");
          excess.set(close, excess.get(close)! - 1);
          changed = true;
        }
      }
    }
    if (candidate.length > 2000 || !ticketUrl.safeParse(candidate).success) continue;
    const url = new URL(candidate).href;
    if (url.length > 2000) continue;
    const label = markdown?.[1].replace(/\\([\\`*_{}\[\]()#+.!>-])/g, "$1").trim().slice(0, 500) ?? "";
    const existing = found.get(url);
    if (existing) {
      if (!existing.label && label) existing.label = label;
    } else if (found.size < MAX_EVENT_LINKS) found.set(url, { url, label });
  }
  return [...found.values()];
}

export function linkCategory(url: string, rules: LinkRule[]): string {
  const address = new URL(url);
  const matches = rules.filter(rule => address.hostname === rule.domain &&
    (!rule.pathPrefix || address.pathname === rule.pathPrefix || address.pathname.startsWith(`${rule.pathPrefix}/`)));
  matches.sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);
  return matches[0]?.category ?? "Other";
}

export function linkLabel(link: Pick<ChatLink, "url" | "label">): string {
  if (link.label) return link.label;
  const url = new URL(link.url);
  return `${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`;
}
