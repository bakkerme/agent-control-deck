import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Activity, Chat, Command, Snapshot } from "../shared/types";
import { states } from "../shared/types";
import ChatEditor, { type EditorHandle } from "./ChatEditor";
import Sources from "./Sources";
import { providerLabel, displayName, displayPreview, message, age, Status, Modal } from "./components";
import MarkdownPreview from "./MarkdownPreview";
import "./style.css";
const api = window.deck;

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [project, setProject] = useState("all");
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("all");
  const [state, setState] = useState("all");
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState<"workspace" | "sources">("workspace");
  const [modal, setModal] = useState<"project" | "chat" | "rename" | null>(
    null,
  );
  const [modalError, setModalError] = useState("");
  const [activities, setActivities] = useState<Activity[]>([]);
  const editor = useRef<EditorHandle>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const reload = () => {
      void api
        .load()
        .then(setSnapshot)
        .catch((e) => setError(message(e)));
    };
    const unsubscribe = api.onChanged(reload);
    reload();
    const timer = setInterval(() => tick((t) => t + 1), 10000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  const mutate = useCallback(async (command: Command) => {
    setSnapshot(await api.command(command));
  }, []);
  const navigate = async (action: () => void | Promise<void>) => {
    if (editor.current && !(await editor.current.flush())) return;
    try {
      await action();
    } catch (e) {
      setError(message(e));
    }
  };
  const chat = snapshot?.chats.find((c) => c.id === selected);
  useEffect(() => {
    let active = true;
    if (!chat) {
      setActivities([]);
      return;
    }
    void api
      .activity(chat.id)
      .then((a) => {
        if (active) setActivities(a);
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [chat, snapshot]);
  if (!snapshot)
    return (
      <div className="loading">
        <h1>Agent Control Deck</h1>
        <p>{error || "Opening your workspace…"}</p>
        {error && <button onClick={() => location.reload()}>Retry</button>}
      </div>
    );
  const activeChats = snapshot.chats.filter((c) => !c.archived);
  const rank = (c: Chat) =>
    c.lifecycle === "ended"
      ? 5
      : { error: 0, waiting: 1, running: 2, idle: 3, unknown: 4 }[c.state];
  const visible = snapshot.chats
    .filter(
      (c) =>
        c.archived === archived &&
        (project === "all" || c.projectId === (project === "unassigned" ? null : project)) &&
        (provider === "all" || c.provider === provider) &&
        (state === "all" ||
          (state === "ended"
            ? c.lifecycle === "ended"
            : c.lifecycle === "open" && c.state === state)) &&
        [
          displayName(c),
          c.notes,
          c.jiraKey,
          c.preview,
          (snapshot.projects.find((p) => p.id === c.projectId)?.name ?? "No project"),
        ]
          .join(" ")
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (b.lastEventAt ?? b.updatedAt).localeCompare(
          a.lastEventAt ?? a.updatedAt,
        ) ||
        a.id.localeCompare(b.id),
    );
  const openModal = (kind: "project" | "chat" | "rename") =>
    void navigate(() => {
      setModalError("");
      setModal(kind);
    });
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name"));
    try {
      const before = new Set(snapshot.chats.map((c) => c.id));
      const next = await api.command(
        modal === "project"
          ? { type: "createProject", name }
          : modal === "rename"
            ? { type: "renameProject", id: project, name }
            : {
                type: "createChat",
                projectId: String(data.get("projectId") ?? "") || null,
                name,
              },
      );
      setSnapshot(next);
      setModal(null);
      if (modal === "chat") {
        const created = next.chats.find((c) => !before.has(c.id));
        if (created) {
          setSelected(created.id);
          setProject(created.projectId ?? "unassigned");
          setArchived(false);
          setSearch("");
          setState("all");
          setProvider("all");
        }
      }
    } catch (e) {
      setModalError(message(e));
    }
  };
  return (
    <div className="app">
      <header>
        <div>
          <h1>Agent Control Deck</h1>
          <span className="muted">
            {snapshot.demo
              ? "Demo workspace · separate sample data"
              : "Local workspace · read-only agent monitoring"}
          </span>
        </div>
        <nav aria-label="Main">
          <button
            className={page === "workspace" ? "selected" : ""}
            onClick={() => void navigate(() => setPage("workspace"))}
          >
            Workspace
          </button>
          <button
            className={page === "sources" ? "selected" : ""}
            onClick={() => void navigate(() => setPage("sources"))}
          >
            Sources
          </button>
          {snapshot.demo && (
            <button
              onClick={() =>
                void mutate({ type: "advanceDemo" }).catch((e) =>
                  setError(message(e)),
                )
              }
            >
              Next sample event
            </button>
          )}
          <button
            onClick={() =>
              void navigate(async () => {
                await mutate({ type: "setDemo", enabled: !snapshot.demo });
                setSelected("");
                setProject("all");
                setPage("workspace");
                setSearch("");
                setArchived(false);
              })
            }
          >
            {snapshot.demo ? "Leave demo" : "Try demo"}
          </button>
        </nav>
      </header>
      {snapshot.ingestionError && <div className="global-error" role="alert">{snapshot.ingestionError}</div>}
      {error && (
        <div className="global-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      {page === "sources" ? (
        <Sources snapshot={snapshot} mutate={mutate} report={setError} />
      ) : (
        <main className="board">
          <aside className="projects">
            <div className="section-heading">
              <h2>Projects</h2>
              <button
                aria-label="Add project"
                onClick={() => openModal("project")}
              >
                +
              </button>
            </div>
            <nav aria-label="Projects">
              <button
                className={project === "all" ? "selected" : ""}
                onClick={() => void navigate(() => setProject("all"))}
              >
                All projects <span>{activeChats.length}</span>
              </button>
              <button
                className={project === "unassigned" ? "selected" : ""}
                onClick={() => void navigate(() => setProject("unassigned"))}
              >
                No project <span>{activeChats.filter((c) => c.projectId === null).length}</span>
              </button>
              {snapshot.projects.map((p) => (
                <button
                  key={p.id}
                  className={project === p.id ? "selected" : ""}
                  onClick={() => void navigate(() => setProject(p.id))}
                >
                  <span>{p.name}</span>
                  <span>
                    {activeChats.filter((c) => c.projectId === p.id).length}
                  </span>
                </button>
              ))}
            </nav>
            {snapshot.projects.some((p) => p.id === project) && (
              <button
                className="text-button"
                onClick={() => openModal("rename")}
              >
                Rename project
              </button>
            )}
            <div className="project-note">
              {snapshot.sources.length
                ? `${snapshot.sources.filter((s) => s.enabled).length} sources enabled`
                : "No live sources configured"}
              <p>
                States reflect the last reported event, not process liveness.
              </p>
            </div>
          </aside>
          <section className="chat-list" aria-label="Chats">
            <div className="section-heading">
              <h2>{archived ? "Archived chats" : "Chats"}</h2>
              <button
                onClick={() =>
                  openModal("chat")
                }
              >
                New chat
              </button>
            </div>
            <label className="search">
              Search chats
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name, notes, ticket, or project"
              />
            </label>
            <div className="filters">
              <select
                aria-label="Provider filter"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                <option value="all">All providers</option>
                <option value="claude">Claude Code</option>
                <option value="cursor">Cursor</option>
                <option value="codex">Codex</option>
                <option value="manual">Manual</option>
              </select>
              <select
                aria-label="State filter"
                value={state}
                onChange={(e) => setState(e.target.value)}
              >
                <option value="all">All states</option>
                {states.map((s) => (
                  <option key={s}>{s}</option>
                ))}
                <option value="ended">ended</option>
              </select>
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={archived}
                onChange={(e) => setArchived(e.target.checked)}
              />
              Show archived chats
            </label>
            <div className="chat-items">
              {visible.map((c) => (
                <button
                  key={c.id}
                  className={`chat-item ${selected === c.id ? "selected" : ""}`}
                  aria-label={`Select chat ${displayName(c)}`}
                  aria-pressed={selected === c.id}
                  onClick={() => void navigate(() => setSelected(c.id))}
                >
                  <div className="chat-item-heading">
                    <strong>{displayName(c)}</strong>
                    <Status chat={c} />
                  </div>
                  <small>
                    {(snapshot.projects.find((p) => p.id === c.projectId)?.name ?? "No project")}{" "}
                    · {providerLabel(c.provider)}
                    {c.jiraKey && ` · ${c.jiraKey}`}
                  </small>
                  <MarkdownPreview compact text={displayPreview(c) || c.notes || "No notes or activity yet"} />
                  <small>
                    {c.provider === "manual"
                      ? "Manual entry"
                      : `Last event ${age(c.lastEventAt)}`}
                  </small>
                </button>
              ))}
              {!visible.length && (
                <div className="empty">
                  <h3>
                    {snapshot.chats.length
                      ? "No matching chats"
                      : "Start with a chat"}
                  </h3>
                  <p>
                    {snapshot.chats.length
                      ? "Adjust the filters or look in the archive."
                      : "Track something manually, connect a source, or try the demo."}
                  </p>
                  {!snapshot.chats.length && (
                    <button onClick={() => openModal("chat")}>
                      Create chat
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>
          {chat ? (
            <ChatEditor
              key={`${snapshot.demo}:${chat.id}`}
              ref={editor}
              chat={chat}
              projects={snapshot.projects}
              activities={activities}
              mutate={mutate}
              report={setError}
              archive={() =>
                void navigate(() =>
                  mutate({
                    type: "updateChat",
                    id: chat.id,
                    patch: { archived: !chat.archived },
                  }),
                )
              }
            />
          ) : (
            <section className="empty detail-empty">
              <h2>Select a chat</h2>
              <p>
                Names, notes, Jira references, and recent activity live here.
              </p>
            </section>
          )}
        </main>
      )}
      <footer>
        <span>
          {snapshot.demo ? "Demo data" : "Local data"}: {snapshot.dataDirectory}
        </span>
        <span>
          {
            activeChats.filter(
              (c) => c.state === "running" && c.lifecycle === "open",
            ).length
          }{" "}
          running ·{" "}
          {
            activeChats.filter(
              (c) =>
                ["waiting", "error"].includes(c.state) &&
                c.lifecycle === "open",
            ).length
          }{" "}
          need attention
        </span>
      </footer>
      {modal && (
        <Modal
          title={
            modal === "project"
              ? "Create project"
              : modal === "rename"
                ? "Rename project"
                : "Create chat"
          }
          close={() => setModal(null)}
        >
          <form onSubmit={submit}>
            {modalError && (
              <p className="error" role="alert">
                {modalError}
              </p>
            )}
            <label>
              {modal === "chat" ? "Chat name" : "Project name"}
              <input
                autoFocus
                name="name"
                required
                maxLength={200}
                defaultValue={
                  modal === "rename"
                    ? snapshot.projects.find((p) => p.id === project)?.name
                    : ""
                }
              />
            </label>
            {modal === "chat" && (
              <label>
                Project
                <select
                  name="projectId"
                  defaultValue={
                    snapshot.projects.some((p) => p.id === project) ? project : ""
                  }
                >
                  <option value="">No project</option>
                  {snapshot.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button className="primary">
              {modal === "rename"
                ? "Save name"
                : modal === "chat"
                  ? "Create chat"
                  : "Create project"}
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="loading">
        <h1>Something went wrong</h1>
        <p>{this.state.error}</p>
        <button onClick={() => location.reload()}>Reload workspace</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
