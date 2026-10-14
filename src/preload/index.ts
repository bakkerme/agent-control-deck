import { contextBridge, ipcRenderer } from "electron";
import type { DeckApi } from "../shared/types";
async function invoke<T>(channel: string, input?: unknown): Promise<T> {
  const reply = await ipcRenderer.invoke(channel, input);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value as T;
}
const api: DeckApi = {
  installLocalMatching: () => invoke("deck:install-local-matching"),
  matchingAnalytics: days => invoke("deck:matching-analytics", days),
  exportMatchingAnalytics: days => invoke("deck:export-matching-analytics", days),
  clearMatchingAnalytics: () => invoke("deck:clear-matching-analytics"),
  saveMatching: input => invoke("deck:save-matching", input),
  removeMatchingKey: () => invoke("deck:remove-matching-key"),
  testMatchingConnection: () => invoke("deck:test-matching-connection"),
  suggestContinuation: input => invoke("deck:suggest-continuation", input),
  load: () => invoke("deck:load"),
  command: (command) => invoke("deck:command", command),
  respond: response => invoke("deck:respond", response),
  activity: (id) => invoke("deck:activity", id),
  copy: (text) => invoke("deck:copy", text),
  openTicket: (id) => invoke("deck:open-ticket", id),
  openLink: (id) => invoke("deck:open-link", id),
  openPlanLink: (itemId, url) => invoke("deck:open-plan-link", { itemId, url }),
  openPlanTicket: (itemId, key) =>
    invoke("deck:open-plan-ticket", { itemId, key }),
  onChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("deck:changed", listener);
    return () => ipcRenderer.removeListener("deck:changed", listener);
  },
};
contextBridge.exposeInMainWorld("deck", api);
