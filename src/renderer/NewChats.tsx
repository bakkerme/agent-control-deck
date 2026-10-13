import { useEffect, useState, type Ref } from "react";
import type { Activity, Chat, Command, Snapshot } from "../shared/types";
import { localPlanDay, planCategories, type PlanCategory } from "../shared/planning";
import { newChatActivity } from "../shared/new-chats";
import { age, displayName, message, providerLabel, Status } from "./components";
import { LatestRound } from "./TaskContext";
import ChatEditor, { type EditorHandle } from "./ChatEditor";

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
        <small>Not on today's card</small>
      </button>
      <div id="new-chats-content" hidden={collapsed}>
        <small className="new-chats-caption">Created or updated today · not on today's card</small>
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
        {!chats.length && <small>No chats created or updated today are missing from today's card.</small>}
        {chats.length > 3 && <button className="quiet new-chats-more" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Show less" : `Show ${chats.length - 3} more`}
        </button>}
      </div>
    </section>
  );
}

export function NewChatContext({ chat, snapshot, day, busy, save, selectTask, create, openChat, editorRef, mutate, report, configureJira, active }: {
  chat: Chat;
  snapshot: Snapshot;
  day: string;
  busy: boolean;
  save: (command: Command, notice?: string) => Promise<boolean>;
  selectTask: (id: string) => void;
  create: (name: string, category: PlanCategory, chatId: string) => void;
  openChat: (id: string) => void;
  editorRef: Ref<EditorHandle>;
  mutate: (command: Command) => Promise<void>;
  report: (error: string) => void;
  configureJira: () => void;
  active: boolean;
}) {
  const [form, setForm] = useState<"link" | "create" | null>(null);
  const [target, setTarget] = useState("");
  const [name, setName] = useState(displayName(chat).slice(0, 200));
  const [category, setCategory] = useState<PlanCategory>("Coding");
  const [activities, setActivities] = useState<Activity[]>([]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void window.deck.activity(chat.id).then((value) => {
      if (current) setActivities(value);
    }).catch((error) => {
      if (current) report(message(error));
    });
    return () => { current = false; };
  }, [active, chat.id, chat.lastEventAt, report]);
  const linked = snapshot.planning.items.filter((item) => item.chatIds.includes(chat.id));
  const task = snapshot.planning.items.find((item) => item.id === target);
  const today = localPlanDay();
  const onToday = new Set(snapshot.planning.entries.filter((entry) => entry.day === today).map((entry) => entry.itemId));
  const todayTasks = snapshot.planning.items.filter((item) => onToday.has(item.id));
  const otherTasks = snapshot.planning.items.filter((item) => !onToday.has(item.id));
  const taskOption = (item: (typeof snapshot.planning.items)[number]) => {
    const latest = snapshot.planning.entries.filter((entry) => entry.itemId === item.id)
      .sort((a, b) => b.day.localeCompare(a.day))[0];
    return <option key={item.id} value={item.id}>{item.name} · {latest ? `${latest.day} · ${latest.category}` : "Not on a card"}</option>;
  };
  // Navigation flushes the editor before hiding Today. Remount it on return so
  // edits made in Repositories are reflected without discarding pending drafts.
  if (!active) return null;
  return (
    <div className="new-chat-context">
      <small className="new-chat-context-label">New · {newChatActivity(chat) === "New" ? "created" : "updated"} today</small>
      <ChatEditor ref={editorRef} repositoryOnly chat={chat} projects={snapshot.projects}
        settings={snapshot.settings} links={snapshot.links.filter((link) => link.chatId === chat.id)}
        activities={activities} mutate={mutate} report={report} configureJira={configureJira}
        renameProject={() => {}} createProject={() => {}}
        archive={() => void save({ type: "updateChat", id: chat.id, patch: { archived: true } }, "Chat archived; available in Repositories → Archived chats")}
        historyPreview={<LatestRound chat={chat} fullHistory={() => openChat(chat.id)} />}>
      <section className="plan-detail-section">
        <h3>{linked.length ? "Linked tasks" : "Task links (optional)"}</h3>
        {linked.length ? linked.map((item) => <button key={item.id} onClick={() => selectTask(item.id)}>{item.name}</button>) : <>
          <small>This chat can stay here without a task.</small>
          <div className="plan-actions">
            <button className="primary" disabled={busy || !snapshot.planning.items.length} onClick={() => setForm("link")}>Link to existing task</button>
            <button disabled={busy} onClick={() => setForm("create")}>Create task from chat</button>
          </div>
          {form === "link" && <form className="new-chat-form" aria-label="Link new chat" onSubmit={(event) => {
            event.preventDefault();
            if (!task) return;
            void save({ type: "setPlanChats", id: task.id, chatIds: [...new Set([...task.chatIds, chat.id])] }, "Chat linked; removed from New")
              .then((ok) => { if (ok) selectTask(task.id); });
          }}>
            <label>Task<select aria-label="Task" required value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)}>
              <option value="">Choose a task</option>
              {todayTasks.map(taskOption)}
              {todayTasks.length > 0 && otherTasks.length > 0 && <option disabled>──────────</option>}
              {otherTasks.map(taskOption)}
            </select></label>
            <small>Tasks from all cards are available, with their latest card date and category. Earlier cards keep their dates.</small>
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
      </ChatEditor>
    </div>
  );
}
