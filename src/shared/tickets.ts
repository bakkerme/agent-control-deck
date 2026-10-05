import type { Chat, Settings } from "./types";
import { ticketUrl } from "./validation";

const keyPattern = /^[A-Z][A-Z0-9_]*-\d+$/i;
export function parseTicket(input: string): Pick<Chat, "jiraKey" | "jiraUrl"> {
  const value = input.trim();
  if (!value) return { jiraKey: "", jiraUrl: "" };
  if (value.length <= 100 && keyPattern.test(value))
    return { jiraKey: value.toUpperCase(), jiraUrl: "" };
  const url = new URL(ticketUrl.parse(value));
  const match = url.pathname.match(/\/browse\/([^/]+)\/?$/i);
  let key = "";
  try { key = match ? decodeURIComponent(match[1]) : ""; } catch { /* Keep the explicit URL. */ }
  return { jiraKey: key.length <= 100 && keyPattern.test(key) ? key.toUpperCase() : "", jiraUrl: url.href };
}

export function resolveTicketUrl(chat: Pick<Chat, "jiraKey" | "jiraUrl">, settings: Settings): string {
  if (chat.jiraUrl) return ticketUrl.parse(chat.jiraUrl);
  if (!chat.jiraKey) return "";
  if (!settings.jiraBaseUrl) throw new Error("Set the Jira base URL in Settings to open ticket numbers.");
  return ticketUrl.parse(`${settings.jiraBaseUrl}/browse/${encodeURIComponent(chat.jiraKey)}`);
}
