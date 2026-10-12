import { useState } from "react";
import type { Chat, Command, Snapshot } from "../shared/types";
import { planCategories, type PlanCategory } from "../shared/planning";
import { newChatActivity } from "../shared/new-chats";
import { age, displayName, providerLabel, Status } from "./components";
import { LatestRound } from "./TaskContext";

export function NewChatList({ chats, snapshot, selected, select }: {
  chats: Chat[];
  snapshot: Snapshot;
  selected: string;
  select: (id: string) => void;
}) {
  const collapseKey = `new-chats-collapsed-${snapshot.demo ? "demo" : "live"}`;
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(collapseKey) === "true");
  const [showAll, setShowAll] = useState(false);
  return (
    <section className="new-chats" aria-label="New chats">
      <button className="new-chats-heading" aria-expanded={!collapsed}
        aria-controls="new-chats-content" onClick={() => {
          setCollapsed(!collapsed);
          localStorage.setItem(collapseKey, String(!collapsed));
        }}>
        <span><span aria-hidden="true">{collapsed ? "›" : "⌄"}</span><strong>New</strong>
          <span className="new-chats-count">{chats.length}</span></span>
        <small>Unlinked chats</small>
      </button>
      <div id="new-chats-content" hidden={collapsed}>
        <small className="new-chats-caption">Created or updated today · not on any card</small>
        {(showAll ? chats : chats.slice(0, 3)).map((chat) => (
          <button key={chat.id} className={`new-chat-row ${selected === chat.id ? "selected" : ""}`}
            aria-label={`Select new chat ${displayName(chat)}`} aria-pressed={selected === chat.id}
            onClick={() => select(chat.id)}>
            <span className="new-chat-title"><strong>{displayName(chat)}</strong>
              <span className="new-chat-activity">{newChatActivity(chat)}</span></span>
            <small>{snapshot.projects.find((p) => p.id === (chat.repoProjectId || chat.projectId))?.name || "No repository"}
              {" · "}{providerLabel(chat.provider)}</small>
            <span className="new-chat-observation"><Status chat={chat} />
              <small>{chat.lastEventAt ? `Last event ${age(chat.lastEventAt)}` : `Created ${age(chat.createdAt)}`}</small></span>
          </button>
        ))}
        {!chats.length && <small>No unlinked chats created or updated today.</small>}
        {chats.length > 3 && <button className="quiet new-chats-more" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Show less" : `Show ${chats.length - 3} more`}
        </button>}
      </div>
    </section>
  );
}

export function NewChatContext({ chat, snapshot, day, busy, save, selectTask, create, openChat }: {
  chat: Chat;
  snapshot: Snapshot;
  day: string;
  busy: boolean;
  save: (command: Command, notice?: string) => Promise<boolean>;
  selectTask: (id: string) => void;
  create: (name: string, category: PlanCategory, chatId: string) => void;
  openChat: (id: string) => void;
}) {
  const [form, setForm] = useState<"link" | "create" | null>(null);
  const [target, setTarget] = useState("");
  const [name, setName] = useState(displayName(chat).slice(0, 200));
  const [category, setCategory] = useState<PlanCategory>("Coding");
  const linked = snapshot.planning.items.filter((item) => item.chatIds.includes(chat.id));
  const task = snapshot.planning.items.find((item) => item.id === target);
  return (
    <div className="new-chat-context">
      <small className="new-chat-context-label">New · {newChatActivity(chat) === "New" ? "created" : "updated"} today</small>
      <h2>{displayName(chat)}</h2>
      <small>{snapshot.projects.find((p) => p.id === (chat.repoProjectId || chat.projectId))?.name || "No repository"}
        {" · "}{providerLabel(chat.provider)} · {chat.lastEventAt ? `Last event ${age(chat.lastEventAt)}` : `Created ${age(chat.createdAt)}`}</small>
      <div className="plan-actions"><Status chat={chat} /></div>
      <section className="plan-detail-section">
        <h3>{linked.length ? "Linked tasks" : "Not linked to a card"}</h3>
        {linked.length ? linked.map((item) => <button key={item.id} onClick={() => selectTask(item.id)}>{item.name}</button>) : <>
          <small>Choose where this chat belongs.</small>
          <div className="plan-actions">
            <button className="primary" disabled={busy || !snapshot.planning.items.length} onClick={() => setForm("link")}>Link to existing task</button>
            <button disabled={busy} onClick={() => setForm("create")}>Create task from chat</button>
          </div>
          {!snapshot.planning.items.length && <small>Create a task to start your card.</small>}
          {form === "link" && <form className="new-chat-form" aria-label="Link new chat" onSubmit={(event) => {
            event.preventDefault();
            if (!task) return;
            void save({ type: "setPlanChats", id: task.id, chatIds: [...new Set([...task.chatIds, chat.id])] }, "Chat linked; removed from New")
              .then((ok) => { if (ok) selectTask(task.id); });
          }}>
            <label>Task<select aria-label="Task" required value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)}>
              <option value="">Choose a task</option>
              {snapshot.planning.items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
            <small>Tasks from all cards are available. Earlier cards keep their dates.</small>
            <div className="plan-actions"><button className="primary" disabled={busy || !task}>Link chat</button>
              <button type="button" disabled={busy} onClick={() => setForm(null)}>Cancel</button></div>
          </form>}
          {form === "create" && <form className="new-chat-form" aria-label="Create task from chat" onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) create(name.trim(), category, chat.id);
          }}>
            <label>Task name<input required maxLength={200} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
            <label>Category<select aria-label="Category" value={category} disabled={busy} onChange={(event) => setCategory(event.target.value as PlanCategory)}>
              {planCategories.map((value) => <option key={value}>{value}</option>)}
            </select></label>
            <small>Added to {day} with this chat linked.</small>
            <div className="plan-actions"><button className="primary" disabled={busy || !name.trim()}>Create task</button>
              <button type="button" disabled={busy} onClick={() => setForm(null)}>Cancel</button></div>
          </form>}
        </>}
      </section>
      <section className="plan-detail-section"><LatestRound chat={chat} fullHistory={() => openChat(chat.id)} /></section>
    </div>
  );
}
