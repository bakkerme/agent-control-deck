import type { Chat } from "./types";
import type { PlanEntry, PlanItem } from "./planning";
import { localPlanDay } from "./planning";

function activityDay(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : localPlanDay(date);
}

// A chat is covered only when a task on today's card links it. Chats linked to
// tasks from earlier days resurface so they are not lost when the task is not
// carried forward.
export function recentUnlinkedChats(
  chats: Chat[],
  items: PlanItem[],
  entries: PlanEntry[],
  today = localPlanDay(),
): Chat[] {
  const onToday = new Set(entries.filter((entry) => entry.day === today).map((entry) => entry.itemId));
  const linked = new Set(items.filter((item) => onToday.has(item.id)).flatMap((item) => item.chatIds));
  return chats
    .filter((chat) => !chat.archived && !linked.has(chat.id) &&
      (activityDay(chat.createdAt) === today || activityDay(chat.lastEventAt) === today))
    .sort((a, b) =>
      Math.max(Date.parse(b.createdAt), Date.parse(b.lastEventAt || b.createdAt)) -
      Math.max(Date.parse(a.createdAt), Date.parse(a.lastEventAt || a.createdAt)) ||
      a.id.localeCompare(b.id));
}

export function newChatActivity(chat: Chat, today = localPlanDay()): "New" | "Updated" {
  return activityDay(chat.createdAt) === today ? "New" : "Updated";
}
