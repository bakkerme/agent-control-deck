import React, { useEffect, useRef } from "react";
import type { Chat } from "../shared/types";
import { codexPrompt, promptTitle } from "../shared/presentation";
import { effectiveState, statusLabel } from "../shared/status";

export const providerLabel = (provider: string) =>
  ({ manual: "Manual", claude: "Claude Code", cursor: "Cursor", codex: "Codex" })[provider] ??
  provider;
export const automaticName = (chat: Chat) =>
  (chat.provider === "codex" ? promptTitle(chat.providerTitle, true) : chat.providerTitle) || "Untitled chat";
export const displayName = (chat: Chat) => chat.name || automaticName(chat);
export const displayPreview = (chat: Chat) => {
  if (chat.provider !== "codex" || !/^# Files mentioned by the user:/i.test(chat.preview.trim())) return chat.preview;
  const { content, attachment } = codexPrompt(chat.preview);
  return content || attachment;
};
export const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export function age(date: string | null): string {
  if (!date) return "No agent events yet";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(date)) / 1000),
  );
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export function Status({ chat }: { chat: Chat }) {
  return (
    <span
      className={`status ${chat.lifecycle === "ended" ? "ended" : effectiveState(chat)}`}
      title={chat.subagents.length ? "Subagent activity is based on received hooks. After five minutes without a subagent observation, its status is uncertain; silence does not prove completion." : undefined}
    >
      {statusLabel(chat)}
    </span>
  );
}
export function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onCancel={close} aria-label={title}>
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button aria-label="Close dialog" onClick={close}>
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
