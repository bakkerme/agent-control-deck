import { contextBridge, ipcRenderer } from "electron";
import type { DeckApi } from "../shared/types";
async function invoke<T>(channel: string, input?: unknown): Promise<T> {
  const reply = await ipcRenderer.invoke(channel, input);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value as T;
}
const api: DeckApi = {
  saveMatching: input => invoke("deck:save-matching", input),
  removeMatchingKey: () => invoke("deck:remove-matching-key"),
  testMatchingConnection: () => invoke("deck:test-matching-connection"),
  load: () => invoke("deck:load"),
  command: (command) => invoke("deck:command", command),
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
