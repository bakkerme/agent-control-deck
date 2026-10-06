import type { Chat, Project, State } from "./types";

// Start/stop hooks observe work; they do not provide a heartbeat or prove liveness.
export const SUBAGENT_OBSERVATION_AGE = 5 * 60 * 1000;
export function subagentCounts(chat: Chat, time = Date.now()) {
  let running = 0, uncertain = 0;
  for (const agent of chat.subagents) {
    if (agent.state === "running" && time - Date.parse(agent.lastEventAt) < SUBAGENT_OBSERVATION_AGE) running++;
    else uncertain++;
  }
  return { running, uncertain };
}
export function effectiveState(chat: Chat, time = Date.now()): State {
  if (chat.state === "waiting" || chat.state === "error" || chat.state === "running") return chat.state;
  const counts = subagentCounts(chat, time);
  return counts.running ? "running" : counts.uncertain ? "unknown" : chat.state;
}
export function finishedTurn(chat: Chat): boolean {
  return chat.lifecycle === "open" && chat.provider !== "manual" && chat.state === "idle" && !!chat.lastEventAt && !chat.subagents.length;
}
export function attentionReason(chat: Chat): string | null {
  if (chat.archived) return null;
  if (chat.lifecycle === "ended") return chat.subagents.length ? null : "Session ended";
  if (chat.state === "waiting") return "Needs input";
  if (chat.state === "error") return "Error";
  return finishedTurn(chat) ? "Turn finished" : null;
}
export function priorityAttention(chat: Chat, projects: Project[]): string | null {
  return projects.some(p => p.priority && (p.id === chat.projectId || p.id === chat.repoProjectId))
    ? attentionReason(chat) : null;
}
export function statusLabel(chat: Chat, time = Date.now()): string {
  const main = chat.lifecycle === "ended" ? "Ended"
    : chat.state === "waiting" ? "Needs input"
    : chat.state === "idle" && chat.provider !== "manual" && chat.lastEventAt
      ? chat.subagents.length ? "Main turn finished" : "Turn finished"
      : ({ running: "Running", idle: "Idle", error: "Error", unknown: "Unknown" }[chat.state]);
  const { running, uncertain } = subagentCounts(chat, time);
  const parts = [main];
  if (running) parts.push(`${running} subagent${running === 1 ? "" : "s"} working`);
  if (uncertain) parts.push(`${uncertain} subagent${uncertain === 1 ? "" : "s"} status uncertain`);
  return parts.join(" · ");
}
