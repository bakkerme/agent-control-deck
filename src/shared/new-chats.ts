import type { Chat } from "./types";
import type { PlanItem } from "./planning";
import { localPlanDay } from "./planning";

function activityDay(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : localPlanDay(date);
}

export function recentUnlinkedChats(
  chats: Chat[],
  items: PlanItem[],
  today = localPlanDay(),
): Chat[] {
  const linked = new Set(items.flatMap((item) => item.chatIds));
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
