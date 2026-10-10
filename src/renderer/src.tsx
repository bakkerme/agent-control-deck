import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Activity, Chat, Command, Snapshot } from "../shared/types";
import { states } from "../shared/types";
import {
  attentionReason,
  effectiveState,
  finishedTurn,
  priorityAttention,
} from "../shared/status";
import ChatEditor, { type EditorHandle } from "./ChatEditor";
import Planning, { type PlanningHandle } from "./Planning";
import Sources from "./Sources";
import Settings from "./Settings";
import {
  providerLabel,
  displayName,
  message,
  age,
  Status,
  Modal,
} from "./components";
import TitleBar from "./TitleBar";
import Icon from "./Icon";
import "./style.css";
const api = window.deck;
function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState("");
  const [page, setPage] = useState<"today" | "repos" | "sources" | "settings">(
      "today",
    ),
    [repo, setRepo] = useState("all"),
    [selected, setSelected] = useState("");
  const [search, setSearch] = useState(""),
    [provider, setProvider] = useState("all"),
    [state, setState] = useState("all"),
    [archived, setArchived] = useState(false),
    [returnToday, setReturnToday] = useState(false);
  const [modal, setModal] = useState<"chat" | "rename" | null>(null),
    [renameId, setRenameId] = useState(""),
    [modalError, setModalError] = useState("");
  const [activities, setActivities] = useState<Activity[]>([]);
  const editor = useRef<EditorHandle>(null),
    planningEditor = useRef<PlanningHandle>(null),
    settingsEditor = useRef<EditorHandle>(null),
    queue = useRef<Promise<unknown>>(Promise.resolve()),
    revision = useRef(0);
  const [, tick] = useState(0);
  useEffect(() => {
    const reload = () => {
      const request = ++revision.current;
      void api
        .load()
        .then((value) => {
          if (request === revision.current) setSnapshot(value);
        })
        .catch((e) => setError(message(e)));
    };
    const unsubscribe = api.onChanged(reload);
    reload();
    const timer = setInterval(() => tick((n) => n + 1), 10000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  const mutate = useCallback((command: Command): Promise<void> => {
    const work = queue.current
      .catch(() => {})
      .then(async () => {
        const request = ++revision.current;
        const value = await api.command(command);
        if (request === revision.current) setSnapshot(value);
      });
    queue.current = work;
    return work;
  }, []);
  const navigate = async (action: () => void | Promise<void>) => {
    if (planningEditor.current && !(await planningEditor.current.flush()))
      return;
    if (editor.current && !(await editor.current.flush())) return;
    if (settingsEditor.current && !(await settingsEditor.current.flush()))
      return;
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
      .then((value) => {
        if (active) setActivities(value);
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [chat?.id, chat?.lastEventAt]);
  if (!snapshot)
    return (
      <div className="app">
        <TitleBar subtitle="Local workspace" />
        <div className="loading">
          <p>{error || "Opening your workspace…"}</p>
          {error && <button onClick={() => location.reload()}>Retry</button>}
        </div>
      </div>
    );
  const repositories = snapshot.projects.filter(
    (p) =>
      p.kind === "repo" || snapshot.chats.some((c) => c.repoProjectId === p.id),
  );
  const repositoryId = (c: Chat) =>
    c.repoProjectId ||
    (repositories.some((p) => p.id === c.projectId) ? c.projectId : null);
  const inRepo = (c: Chat, id: string) =>
    id === "all" || (id === "none" ? !repositoryId(c) : repositoryId(c) === id);
  const repoName = (c: Chat) =>
    repositories.find((p) => p.id === repositoryId(c))?.name || "No repository";
  const scoped = snapshot.chats.filter(
    (c) =>
      c.archived === archived &&
      inRepo(c, repo) &&
      (provider === "all" || c.provider === provider) &&
      `${displayName(c)} ${c.notes} ${c.preview} ${repoName(c)}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const matchesState = (c: Chat, value: string) =>
    value === "all" ||
    (value === "ended"
      ? c.lifecycle === "ended"
      : c.lifecycle === "open" &&
        (value === "finished" ? finishedTurn(c) : effectiveState(c) === value));
  const rank = (c: Chat) =>
    c.lifecycle === "ended"
      ? 6
      : {
          error: 0,
          waiting: 1,
          running: 2,
          monitoring: 3,
          idle: 4,
          unknown: 5,
        }[effectiveState(c)];
  const visible = scoped
    .filter((c) => matchesState(c, state))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (b.lastEventAt || b.updatedAt).localeCompare(
          a.lastEventAt || a.updatedAt,
        ),
    );
  const openChat = (id: string) =>
    void navigate(() => {
      const target = snapshot.chats.find((c) => c.id === id);
      if (!target) return;
      setSelected(id);
      setRepo(repositoryId(target) || "none");
      setArchived(target.archived);
      setSearch("");
      setState("all");
      setProvider("all");
      setReturnToday(true);
      setPage("repos");
    });
  return (
    <div className="app">
      <TitleBar
        subtitle={
          snapshot.demo
            ? "Demo workspace · separate sample data"
            : "Local workspace · read-only agent monitoring"
        }
      >
        <nav aria-label="Main">
          {(
            [
              ["today", "Today"],
              ["repos", "Repositories"],
              ["sources", "Sources"],
              ["settings", "Settings"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={page === value ? "selected" : ""}
              onClick={() =>
                void navigate(() => {
                  setPage(value);
                  if (value === "repos") setReturnToday(false);
                })
              }
            >
              {label}
            </button>
          ))}
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
                setRepo("all");
                setPage("today");
                setSearch("");
                setArchived(false);
              })
            }
          >
            {snapshot.demo ? "Leave demo" : "Try demo"}
          </button>
        </nav>
      </TitleBar>
      {snapshot.ingestionError && (
        <div className="global-error" role="alert">
          {snapshot.ingestionError}
        </div>
      )}
      {error && (
        <div className="global-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      <div
        className={page === "today" ? "today-page" : "today-page inactive-page"}
      >
        <Planning
          key={String(snapshot.demo)}
          ref={planningEditor}
          snapshot={snapshot}
          mutate={mutate}
          openChat={openChat}
          configureJira={() => void navigate(() => setPage("settings"))}
        />
      </div>
      {page === "sources" ? (
        <Sources snapshot={snapshot} mutate={mutate} report={setError} />
      ) : page === "settings" ? (
        <Settings
          key={String(snapshot.demo)}
          ref={settingsEditor}
          settings={snapshot.settings}
          mutate={mutate}
        />
      ) : page === "repos" ? (
        <main className="board repository-board">
          <aside className="projects repositories">
            <h2>Repositories</h2>
            <nav aria-label="Repositories">
              {[
                ["all", "All repositories"],
                ["none", "No repository"],
                ...repositories.map((p) => [p.id, p.name]),
              ].map(([id, label]) => {
                const project = repositories.find((p) => p.id === id),
                  count = snapshot.chats.filter(
                    (c) => c.archived === archived && inRepo(c, id),
                  ).length,
                  attention = project?.priority
                    ? snapshot.chats.filter(
                        (c) =>
                          !c.archived && inRepo(c, id) && attentionReason(c),
                      ).length
                    : 0;
                return (
                  <div
                    className={`project-row ${attention ? "has-attention" : ""}`}
                    key={id}
                  >
                    <button
                      className={repo === id ? "selected" : ""}
                      onClick={() =>
                        void navigate(() => {
                          setRepo(id);
                          setSelected("");
                        })
                      }
                    >
                      <span className="project-name" title={label}>
                        {attention > 0 && (
                          <span className="priority-lamp" aria-hidden="true" />
                        )}
                        {label}
                      </span>
                      <span className="project-count">{count}</span>
                    </button>
                    {project && (
                      <div className="project-tools">
                        <button
                          aria-label={`Rename repository ${project.name}`}
                          title="Rename repository"
                          onClick={() => {
                            setRenameId(id);
                            setModal("rename");
                            setModalError("");
                          }}
                        >
                          <Icon name="pencil" />
                        </button>
                        <button
                          aria-label={`Priority repository ${project.name}`}
                          aria-pressed={project.priority}
                          title="Flag repository for attention"
                          onClick={() =>
                            void mutate({
                              type: "setProjectPriority",
                              id,
                              priority: !project.priority,
                            }).catch((e) => setError(message(e)))
                          }
                        >
                          <Icon name="flag" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </nav>
            <div className="project-note">
              <p>
                Repository paths are discovered from observed chats. Last
                reported states are observations, not process liveness.
              </p>
            </div>
          </aside>
          <section className="chat-list" aria-label="Chats">
            <div className="section-heading">
              <h2>
                {repo === "all"
                  ? "All chats"
                  : repo === "none"
                    ? "No repository"
                    : repositories.find((p) => p.id === repo)?.name ||
                      "Repository"}
              </h2>
              <button
                onClick={() => {
                  setModal("chat");
                  setModalError("");
                }}
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
                placeholder="Name, notes, or repository"
              />
            </label>
            <div className="filters">
              <select
                aria-label="Provider filter"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                <option value="all">All providers</option>
                {["claude", "cursor", "codex", "manual"].map((value) => (
                  <option key={value} value={value}>
                    {providerLabel(value)}
                  </option>
                ))}
              </select>
              <select
                aria-label="State filter"
                value={state}
                onChange={(e) => setState(e.target.value)}
              >
                <option value="all">All states</option>
                <option value="finished">Finished turns</option>
                <option value="monitoring">Monitoring</option>
                {states.map((value) => (
                  <option key={value}>{value}</option>
                ))}
                <option value="ended">ended</option>
              </select>
            </div>
            <nav
              className="status-filters chat-views"
              aria-label="Chat visibility"
            >
              {[false, true].map((value) => (
                <button
                  key={String(value)}
                  className={archived === value ? "selected" : ""}
                  aria-pressed={archived === value}
                  onClick={() =>
                    void navigate(() => {
                      setArchived(value);
                      setProvider("all");
                      setSelected("");
                      setSearch("");
                      setState("all");
                    })
                  }
                >
                  {value ? "Archived chats" : "Active chats"}{" "}
                  <span>
                    {
                      snapshot.chats.filter(
                        (c) => c.archived === value && inRepo(c, repo),
                      ).length
                    }
                  </span>
                </button>
              ))}
            </nav>
            <nav className="status-filters" aria-label="Quick status filters">
              {[
                ["all", "All"],
                ["running", "Running"],
                ["monitoring", "Monitoring"],
                ["waiting", "Needs input"],
                ["finished", "Finished turns"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  className={state === value ? "selected" : ""}
                  aria-pressed={state === value}
                  onClick={() => setState(value)}
                >
                  {label}{" "}
                  <span>
                    {scoped.filter((c) => matchesState(c, value)).length}
                  </span>
                </button>
              ))}
            </nav>
            <div className="record-heading" aria-hidden="true">
              <span>Chat / repository / provider</span>
              <span>Reported</span>
              <span>Event age</span>
            </div>
            <div className="chat-items">
              {visible.map((c) => (
                <button
                  key={c.id}
                  className={`chat-item ${selected === c.id ? "selected" : ""} ${priorityAttention({ ...c, projectId: repositoryId(c) }, repositories) ? "priority-attention" : ""}`}
                  aria-label={`Select chat ${displayName(c)}`}
                  aria-description={
                    priorityAttention(
                      { ...c, projectId: repositoryId(c) },
                      repositories,
                    )
                      ? `Priority repository · ${attentionReason(c)}`
                      : undefined
                  }
                  aria-pressed={selected === c.id}
                  onClick={() => void navigate(() => setSelected(c.id))}
                >
                  <div className="chat-record-title">
                    <strong>{displayName(c)}</strong>
                    <small>
                      {repoName(c)} · {providerLabel(c.provider)}
                    </small>
                  </div>
                  <Status chat={c} />
                  <small className="record-age">
                    {c.provider === "manual"
                      ? "Manual entry"
                      : age(c.lastEventAt)}
                  </small>
                </button>
              ))}
              {!visible.length && (
                <div className="empty">
                  <h3>No matching chats</h3>
                  <p>Adjust the filters or look in Archived chats.</p>
                </div>
              )}
            </div>
          </section>
          <div className="repository-detail">
            {returnToday && (
              <button
                className="back-to-today quiet"
                onClick={() => void navigate(() => setPage("today"))}
              >
                Back to Today
              </button>
            )}
            {chat ? (
              <>
                <section className="repository-linked-tasks">
                  <h3>Linked tasks</h3>
                  {snapshot.planning.items
                    .filter((i) => i.chatIds.includes(chat.id))
                    .map((i) => (
                      <button
                        className="quiet"
                        key={i.id}
                        onClick={() =>
                          void navigate(() => {
                            planningEditor.current?.selectTask(i.id);
                            setPage("today");
                          })
                        }
                      >
                        {i.name}
                      </button>
                    ))}
                  {!snapshot.planning.items.some((i) =>
                    i.chatIds.includes(chat.id),
                  ) && <small>No task linked yet.</small>}
                </section>
                <ChatEditor
                  key={`${snapshot.demo}:${chat.id}`}
                  ref={editor}
                  repositoryOnly
                  chat={chat}
                  projects={snapshot.projects}
                  settings={snapshot.settings}
                  links={snapshot.links.filter(
                    (link) => link.chatId === chat.id,
                  )}
                  activities={activities}
                  mutate={mutate}
                  report={setError}
                  configureJira={() => void navigate(() => setPage("settings"))}
                  renameProject={(id) => {
                    setRenameId(id);
                    setModal("rename");
                  }}
                  createProject={() => {}}
                  archive={() =>
                    void navigate(async () => {
                      await mutate({
                        type: "updateChat",
                        id: chat.id,
                        patch: { archived: !chat.archived },
                      });
                      setArchived(!chat.archived);
                    })
                  }
                />
              </>
            ) : (
              <section className="empty detail-empty">
                <h2>Select a chat</h2>
                <p>
                  Choose a conversation to view its observed history and saved
                  context.
                </p>
              </section>
            )}
          </div>
        </main>
      ) : null}
      {modal && (
        <Modal
          title={modal === "rename" ? "Rename repository" : "New chat"}
          close={() => setModal(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget),
                name = String(form.get("name"));
              const command: Command =
                modal === "rename"
                  ? { type: "renameProject", id: renameId, name }
                  : {
                      type: "createChat",
                      projectId: String(form.get("repository") || "") || null,
                      name,
                    };
              void navigate(async () => {
                try {
                  const before = new Set(snapshot.chats.map((c) => c.id));
                  await mutate(command);
                  const next = await api.load();
                  setSnapshot(next);
                  setModal(null);
                  if (command.type === "createChat") {
                    const added = next.chats.find((c) => !before.has(c.id));
                    if (added) {
                      setSelected(added.id);
                      setRepo(command.projectId || "none");
                      setArchived(false);
                      setSearch("");
                      setState("all");
                    }
                  }
                } catch (e) {
                  setModalError(message(e));
                }
              });
            }}
          >
            <label>
              Name
              <input
                name="name"
                autoFocus
                required
                maxLength={200}
                defaultValue={
                  modal === "rename"
                    ? repositories.find((p) => p.id === renameId)?.name
                    : ""
                }
              />
            </label>
            {modal === "chat" && (
              <label>
                Repository
                <select
                  name="repository"
                  aria-label="Repository"
                  defaultValue={
                    repositories.some((p) => p.id === repo) ? repo : ""
                  }
                >
                  <option value="">No repository</option>
                  {repositories.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {modalError && (
              <p className="error" role="alert">
                {modalError}
              </p>
            )}
            <div className="plan-actions">
              <button className="primary">
                {modal === "rename" ? "Save name" : "Create chat"}
              </button>
              <button type="button" onClick={() => setModal(null)}>
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
