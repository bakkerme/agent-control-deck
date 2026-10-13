import { linkOccurrences } from "./links";
import { parseTicket } from "./tickets";

export const MATCHING_INPUT_VERSION = "opening.compact.v1";
const genericLabel = /^(?:here|link|click here|read more|this|page|doc|ticket)$/i;
function readable(value: string) {
  try { return decodeURIComponent(value.replace(/\+/g, " ")).trim(); } catch { return ""; }
}
function compactLink(url: string, label: string): string | null {
  const key = parseTicket(url).jiraKey;
  const useful = label && !genericLabel.test(label) ? label : "";
  if (key) return useful ? new RegExp(`\\b${key}\\b`, "i").test(useful) ? useful : `${useful} (${key})` : key;
  const address = new URL(url);
  const page = /\/(?:spaces\/[^/]+\/pages\/\d+|display\/[^/]+)\/([^/]+)\/?$/i.exec(address.pathname);
  const title = page ? readable(page[1]) : "";
  if (title) return useful && useful.toLowerCase() !== title.toLowerCase() ? `${useful} (${title})` : title;
  if (["github.com", "www.github.com"].includes(address.hostname)) {
    const issue = /^\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)\/?$/.exec(address.pathname);
    if (issue) {
      const ref = `${issue[1]} ${issue[2] === "pull" ? "PR" : "issue"} #${issue[3]}`;
      return useful ? `${useful} (${ref})` : ref;
    }
  }
  return useful || null;
}

// Matching-only copy: no network access and no edits to stored prompts, notes or URLs.
export function compactMatchingText(text: string): string {
  const input = text.slice(0, 262144);
  const parts: string[] = [];
  let cursor = 0;
  for (const link of linkOccurrences(input)) {
    if (link.start < cursor) continue;
    const replacement = compactLink(link.url, link.label);
    if (replacement === null) continue;
    parts.push(input.slice(cursor, link.start), replacement);
    cursor = link.end;
  }
  parts.push(input.slice(cursor));
  return parts.join("").replace(/[ \t]+/g, " ").replace(/ *\r?\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
