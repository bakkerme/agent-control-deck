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
export function backgroundCounts(chat: Chat, time = Date.now()) {
  let working = 0, monitors = 0, scheduled = 0, uncertain = 0;
  for (const task of chat.backgroundTasks) {
    if (task.state === "unknown" || time - Date.parse(task.lastEventAt) >= SUBAGENT_OBSERVATION_AGE) uncertain++;
    else if (task.type === "monitor") monitors++;
    else working++;
  }
  for (const check of chat.scheduledChecks) {
    // A schedule can intentionally wait much longer than a worker observation.
    if (check.state === "observed") scheduled++;
    else uncertain++;
  }
  return { working, monitors, scheduled, uncertain };
}
export function hasBackgroundWork(chat: Chat): boolean {
  return !!(chat.subagents.length || chat.backgroundTasks.length || chat.scheduledChecks.length);
}
export function effectiveState(chat: Chat, time = Date.now()): State | "monitoring" {
  if (chat.state === "waiting" || chat.state === "error" || chat.state === "running") return chat.state;
  const counts = subagentCounts(chat, time);
  const background = backgroundCounts(chat, time);
  return counts.running || background.working ? "running"
    : background.monitors || background.scheduled ? "monitoring"
    : counts.uncertain || background.uncertain ? "unknown" : chat.state;
}
export function finishedTurn(chat: Chat): boolean {
  return chat.lifecycle === "open" && chat.provider !== "manual" && chat.state === "idle" && !!chat.lastEventAt && !hasBackgroundWork(chat);
}
export function attentionReason(chat: Chat): string | null {
  if (chat.archived) return null;
  if (chat.lifecycle === "ended") return hasBackgroundWork(chat) ? null : "Session ended";
  if (chat.state === "waiting") return "Needs input";
  if (chat.state === "error") return "Error";
  return finishedTurn(chat) ? "Turn finished" : null;
}
export interface ChatProgress { action: number; working: number; finished: number }
// Rolls a task's linked chats into the three questions a card answers: what needs me, what is
// moving, and what is done. Idle manual chats and unknown states belong to none of them.
export function chatProgress(chats: Chat[], time = Date.now()): ChatProgress {
  const progress = { action: 0, working: 0, finished: 0 };
  for (const chat of chats) {
    if (chat.archived) continue;
    const state = effectiveState(chat, time);
    if (state === "waiting" || state === "error") progress.action++;
    else if (state === "running" || state === "monitoring") progress.working++;
    else if (chat.lifecycle === "ended" || finishedTurn(chat)) progress.finished++;
  }
  return progress;
}
export function priorityAttention(chat: Chat, projects: Project[]): string | null {
  return projects.some(p => p.priority && p.id === chat.projectId)
    ? attentionReason(chat) : null;
}
export function statusLabel(chat: Chat, time = Date.now()): string {
  const background = backgroundCounts(chat, time);
  const main = chat.lifecycle === "ended" ? "Ended"
    : chat.state === "waiting" ? "Needs input"
    : chat.state === "idle" && chat.provider !== "manual" && chat.lastEventAt
      ? effectiveState(chat, time) === "monitoring" ? "Monitoring" : hasBackgroundWork(chat) ? "Main turn finished" : "Turn finished"
      : ({ running: "Running", idle: "Idle", error: "Error", unknown: "Unknown" }[chat.state]);
  const { running, uncertain } = subagentCounts(chat, time);
  const parts = [main];
  if (running) parts.push(`${running} subagent${running === 1 ? "" : "s"} working`);
  if (uncertain) parts.push(`${uncertain} subagent${uncertain === 1 ? "" : "s"} status uncertain`);
  if (background.working) parts.push(`${background.working} background task${background.working === 1 ? "" : "s"} working`);
  if (background.monitors) parts.push(`${background.monitors} monitor${background.monitors === 1 ? "" : "s"} observed`);
  if (background.scheduled) parts.push(main === "Monitoring" && !background.monitors ? "waiting for next check" : `${background.scheduled} scheduled check${background.scheduled === 1 ? "" : "s"}`);
  if (background.uncertain) parts.push(`${background.uncertain} background observation${background.uncertain === 1 ? "" : "s"} uncertain`);
  return parts.join(" · ");
}
