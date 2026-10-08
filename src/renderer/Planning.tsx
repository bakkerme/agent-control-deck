import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { Command, Snapshot } from "../shared/types";
import {
  categoryDescription,
  localPlanDay,
  nextPlanDay,
  parseDailyPlan,
  planCategories,
  type PlanCategory,
  type PlanInboxFile,
  type PlanItem,
} from "../shared/planning";
import {
  displayName,
  displayPreview,
  age,
  message,
  Modal,
  Status,
} from "./components";
import { effectiveState } from "../shared/status";
import MarkdownPreview from "./MarkdownPreview";
export interface PlanningHandle {
  flush(): Promise<boolean>;
}
const dayLabel = (day: string) =>
  new Date(day + "T12:00:00").toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
const example = (day: string) =>
  `---\ndate: ${day}\n---\n\n## Coding\n- Agent Control Deck\n\n## Agentic\n- Research workflows\n\n## Other\n- Review design document\n- Ask about deployment`;
export default forwardRef<
  PlanningHandle,
  {
    snapshot: Snapshot;
    mutate: (command: Command) => Promise<void>;
    report: (error: string) => void;
    allChats: () => void;
    openChat: (id: string) => void;
    createProject: () => void;
  }
>(function Planning(
  { snapshot, mutate, report, allChats, openChat, createProject },
  ref,
) {
  const { planning } = snapshot;
  const [day, setDay] = useState(localPlanDay);
  const [project, setProject] = useState("day");
  const [selected, setSelected] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<
    "add" | "link" | "import" | "original" | "inbox" | "schedule" | null
  >(null);
  const [modalError, setModalError] = useState("");
  const [category, setCategory] = useState<PlanCategory>("Coding");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [noteEditing, setNoteEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [chatIds, setChatIds] = useState<string[]>([]);
  const [card, setCard] = useState({
    name: "Pasted card",
    markdown: example(localPlanDay()),
  });
  const [review, setReview] = useState<ReturnType<
    typeof parseDailyPlan
  > | null>(null);
  const [connections, setConnections] = useState<(string | null)[]>([]);
  const [targetDay, setTargetDay] = useState(nextPlanDay(localPlanDay()));
  const dirty = useRef(false),
    notesRef = useRef<HTMLTextAreaElement>(null);
  const item = planning.items.find((i) => i.id === selected);
  const itemRef = useRef(item);
  itemRef.current = item;
  const noteRef = useRef(note);
  noteRef.current = note;
  const flight = useRef<Promise<boolean> | null>(null);
  const flush = (): Promise<boolean> => {
    if (flight.current) return flight.current;
    const promise = (async () => {
      while (dirty.current && itemRef.current) {
        const current = itemRef.current,
          value = noteRef.current;
        try {
          await mutate({
            type: "updatePlanItem",
            id: current.id,
            patch: { notes: value },
          });
          if (noteRef.current === value) {
            dirty.current = false;
            setNotice("Saved");
          }
        } catch (e) {
          report(message(e));
          return false;
        }
      }
      return true;
    })();
    flight.current = promise;
    void promise.finally(() => {
      if (flight.current === promise) flight.current = null;
    });
    return promise;
  };
  useImperativeHandle(ref, () => ({ flush }));
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, []);
  useEffect(() => {
    if (!noteEditing && !dirty.current) setNote(item?.notes ?? "");
  }, [item?.id, item?.notes, noteEditing]);
  const todayEntries = planning.entries.filter((e) => e.day === day);
  const visible =
    project === "day"
      ? todayEntries
          .map((e) => planning.items.find((i) => i.id === e.itemId)!)
          .filter(Boolean)
      : planning.items.filter(
          (i) =>
            project === "all" ||
            (project === "unassigned" ? !i.projectId : i.projectId === project),
        );
  useEffect(() => {
    if (!selected && visible.length) setSelected(visible[0].id);
  }, [selected, visible.map((i) => i.id).join("|")]);
  async function navigate(action: () => void) {
    if (await flush()) {
      setNoteEditing(false);
      action();
    }
  }
  async function run(command: Command, success = "Saved") {
    if (busy) return false;
    setBusy(true);
    try {
      if (!(await flush())) return false;
      await mutate(command);
      setNotice(success);
      return true;
    } catch (e) {
      report(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  function show(kind: typeof modal) {
    setModalError("");
    setModal(kind);
  }
  function selectItem(i: PlanItem) {
    void navigate(() => {
      setSelected(i.id);
      setNote(i.notes);
    });
  }
  function loadCard(file: PlanInboxFile) {
    setCard({ name: file.name, markdown: file.markdown });
    setReview(null);
    setConnections([]);
    show("import");
    if (file.error) setModalError(file.error);
  }
  const entry = todayEntries.find((e) => e.itemId === item?.id);
  const days = [
    ...new Set(
      planning.entries
        .map((e) => e.day)
        .concat(planning.imports.map((i) => i.day)),
    ),
  ]
    .sort()
    .reverse();
  const row = (i: PlanItem) => {
    const current = todayEntries.find((e) => e.itemId === i.id),
      linked = snapshot.chats.filter((c) => i.chatIds.includes(c.id)),
      waiting = linked.filter(
        (c) =>
          !c.archived &&
          c.lifecycle === "open" &&
          ["waiting", "error"].includes(effectiveState(c)),
      ).length,
      running = linked.filter(
        (c) =>
          !c.archived &&
          c.lifecycle === "open" &&
          effectiveState(c) === "running",
      ).length;
    return (
      <button
        key={i.id}
        className={`plan-row ${selected === i.id ? "selected" : ""} ${waiting ? "plan-attention" : ""}`}
        aria-label={`Select plan item ${i.name}`}
        onClick={() => selectItem(i)}
      >
        <span
          className={`plan-work-mark ${current?.workedOn ? "worked" : ""}`}
          aria-label={
            current?.workedOn ? "Worked on this day" : "Not marked worked on"
          }
        >
          {current?.workedOn ? "✓" : ""}
        </span>
        <span>
          <strong>{i.name}</strong>
          <small>
            {snapshot.projects.find((p) => p.id === i.projectId)?.name ||
              "Project optional"}
            {current?.workedOn ? " · Worked on" : ""}
          </small>
          <span className="plan-row-chats">
            {waiting > 0 && (
              <span className="plan-needs-input">
                {waiting} need attention ·{" "}
              </span>
            )}
            {running > 0 && <span>{running} running · </span>}
            {linked.length
              ? `${linked.length} linked chat${linked.length === 1 ? "" : "s"}`
              : "No linked chats"}
          </span>
        </span>
      </button>
    );
  };
  return (
    <main className="board planning-board">
      <aside className="projects plan-rail">
        <nav aria-label="Planning navigation">
          <button
            className={project === "day" ? "selected" : ""}
            onClick={() =>
              void navigate(() => {
                setProject("day");
                setDay(localPlanDay());
                setSelected("");
              })
            }
          >
            Today
          </button>
          <button onClick={allChats}>
            All chats <span>{snapshot.chats.length}</span>
          </button>
          <button onClick={() => show("inbox")}>
            Plan inbox <span>{planning.inbox.files.length}</span>
          </button>
        </nav>
        <h3>Projects</h3>
        <nav aria-label="Planning projects">
          <button
            className={project === "all" ? "selected" : ""}
            onClick={() =>
              void navigate(() => {
                setProject("all");
                setSelected("");
              })
            }
          >
            All plan items
          </button>
          <button
            className={project === "unassigned" ? "selected" : ""}
            onClick={() =>
              void navigate(() => {
                setProject("unassigned");
                setSelected("");
              })
            }
          >
            No project
          </button>
          {snapshot.projects.map((p) => (
            <button
              key={p.id}
              className={project === p.id ? "selected" : ""}
              onClick={() =>
                void navigate(() => {
                  setProject(p.id);
                  setSelected("");
                })
              }
            >
              {p.name}
              <span>
                {planning.items.filter((i) => i.projectId === p.id).length}
              </span>
            </button>
          ))}
          <button onClick={createProject}>+ Add a new project</button>
        </nav>
        <h3>Daily cards</h3>
        <nav aria-label="Daily cards">
          {days.slice(0, 30).map((d) => (
            <button
              key={d}
              className={project === "day" && day === d ? "selected" : ""}
              onClick={() =>
                void navigate(() => {
                  setDay(d);
                  setProject("day");
                  setSelected("");
                })
              }
            >
              {dayLabel(d)}
            </button>
          ))}
        </nav>
        <div className="project-note">
          Projects are optional context. Each card records where you put your
          attention.
        </div>
      </aside>
      <section className="chat-list daily-plan" aria-label="Plan items">
        <div className="section-heading">
          <div>
            <span className="eyebrow">
              {project === "day" ? "Daily card" : "Broader context"}
            </span>
            <h2>
              {project === "day"
                ? day === localPlanDay()
                  ? "Today"
                  : dayLabel(day)
                : project === "all"
                  ? "All plan items"
                  : project === "unassigned"
                    ? "No project"
                    : snapshot.projects.find((p) => p.id === project)?.name}
            </h2>
          </div>
          <button
            onClick={() => {
              setReview(null);
              setCard({ name: "Pasted card", markdown: example(day) });
              show("import");
            }}
          >
            Import card
          </button>
        </div>
        <div className="plan-date">
          <label>
            Day
            <input
              type="date"
              value={day}
              min="1900-01-01"
              max="9999-12-31"
              onChange={(e) => {
                const value = e.target.value;
                if (value)
                  void navigate(() => {
                    setDay(value);
                    setProject("day");
                    setSelected("");
                  });
              }}
            />
          </label>
          <div>
            <button
              aria-label="Previous planning day"
              onClick={() =>
                void navigate(() => {
                  setDay(nextPlanDay(day, -1));
                  setProject("day");
                  setSelected("");
                })
              }
            >
              ‹
            </button>
            <button
              aria-label="Next planning day"
              onClick={() =>
                void navigate(() => {
                  setDay(nextPlanDay(day));
                  setProject("day");
                  setSelected("");
                })
              }
            >
              ›
            </button>
          </div>
        </div>
        <div className="plan-source">
          <small>
            {project === "day"
              ? `${dayLabel(day)} · ${todayEntries.length} items`
              : `${visible.length} plan items across days`}
          </small>
          {planning.imports.some((i) => i.day === day) && (
            <button onClick={() => show("original")}>View card</button>
          )}
        </div>
        {project === "day"
          ? planCategories.map((c) => (
              <section
                className="plan-category"
                key={c}
                aria-label={`${c} plan items`}
              >
                <div className="plan-category-title">
                  <h3>{c}</h3>
                  <small>
                    {todayEntries.filter((e) => e.category === c).length}
                  </small>
                </div>
                <p className="plan-category-caption">
                  {categoryDescription[c]}
                </p>
                {todayEntries
                  .filter((e) => e.category === c)
                  .map((e) =>
                    row(planning.items.find((i) => i.id === e.itemId)!),
                  )}
                <button
                  className="plan-add"
                  onClick={() => {
                    setCategory(c);
                    setName("");
                    show("add");
                  }}
                >
                  + Add item
                </button>
              </section>
            ))
          : visible.map(row)}
        {project === "day" && (
          <p className="plan-summary">
            {todayEntries.filter((e) => e.workedOn).length} of{" "}
            {todayEntries.length} items worked on this day
          </p>
        )}
        {notice && (
          <p role="status" className="saved plan-notice">
            {notice}
          </p>
        )}
      </section>
      <section className="details plan-details" aria-label="Plan item details">
        {item ? (
          <>
            <span className="eyebrow">Plan item</span>
            <h2>{item.name}</h2>
            <small>
              {entry?.category ?? "Not scheduled on this day"} · {dayLabel(day)}
            </small>
            <div className="plan-actions">
              {entry ? (
                <button
                  className={entry.workedOn ? "plan-worked" : "plan-primary"}
                  aria-pressed={entry.workedOn}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      {
                        type: "setPlanWorkedOn",
                        id: item.id,
                        day,
                        workedOn: !entry.workedOn,
                      },
                      entry.workedOn
                        ? "Worked-on mark removed"
                        : "Worked on this day",
                    )
                  }
                >
                  {entry.workedOn ? "✓ Worked on this day" : "Mark worked on"}
                </button>
              ) : (
                <button
                  onClick={() => {
                    setTargetDay(day);
                    setCategory("Coding");
                    show("schedule");
                  }}
                >
                  Schedule on this day
                </button>
              )}
              <button
                onClick={() => {
                  setTargetDay(nextPlanDay(day));
                  setCategory(entry?.category ?? "Coding");
                  show("schedule");
                }}
              >
                Carry forward
              </button>
            </div>
            <section className="plan-detail-section">
              <h3>Planning context</h3>
              <label>
                Project · optional
                <select
                  aria-label="Plan item project"
                  value={item.projectId ?? ""}
                  disabled={busy}
                  onChange={(e) =>
                    void run({
                      type: "updatePlanItem",
                      id: item.id,
                      patch: { projectId: e.target.value || null },
                    })
                  }
                >
                  <option value="">No project assigned</option>
                  {snapshot.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted">
                Choose the broader goal this work belongs to.
              </p>
              {entry && (
                <label>
                  Category for this day
                  <select
                    value={entry.category}
                    disabled={busy}
                    onChange={(e) =>
                      void run({
                        type: "schedulePlanItem",
                        id: item.id,
                        day,
                        category: e.target.value as PlanCategory,
                      })
                    }
                  >
                    {planCategories.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
              )}
            </section>
            <section className="plan-detail-section">
              <div className="section-heading">
                <h3>
                  Linked chats <small>{item.chatIds.length}</small>
                </h3>
                <button
                  onClick={() => {
                    setChatIds(item.chatIds);
                    show("link");
                  }}
                >
                  Link chat
                </button>
              </div>
              {snapshot.chats
                .filter((c) => item.chatIds.includes(c.id))
                .map((c) => (
                  <div
                    key={c.id}
                    className={`plan-chat ${!c.archived && ["waiting", "error"].includes(effectiveState(c)) ? "plan-attention" : ""}`}
                  >
                    <button
                      className="plan-chat-open"
                      onClick={() => openChat(c.id)}
                    >
                      <strong>{displayName(c)}</strong>
                      <small>
                        {c.archived ? "Archived · " : ""}
                        {c.lifecycle === "ended" ? "Session ended · " : ""}
                        {c.provider} · {age(c.lastEventAt)}
                      </small>
                      <Status chat={c} />
                      {c.preview && (
                        <div className="plan-chat-preview">
                          {displayPreview(c).slice(0, 240)}
                        </div>
                      )}
                    </button>
                    <button
                      aria-label={`Unlink chat ${displayName(c)}`}
                      disabled={busy}
                      onClick={() =>
                        void run({
                          type: "setPlanChats",
                          id: item.id,
                          chatIds: item.chatIds.filter((id) => id !== c.id),
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
              {!item.chatIds.length && (
                <p className="muted">
                  Link a conversation when it is relevant.
                </p>
              )}
              <p className="plan-category-caption">
                Chat activity is separate from your planning progress.
              </p>
            </section>
            <section className="plan-detail-section">
              <div className="section-heading">
                <h3>Your notes</h3>
                {!noteEditing && (
                  <button
                    onClick={() => {
                      setNote(item.notes);
                      setNoteEditing(true);
                    }}
                  >
                    Edit notes
                  </button>
                )}
              </div>
              {noteEditing ? (
                <>
                  <textarea
                    ref={notesRef}
                    aria-label="Plan item notes"
                    value={note}
                    onChange={(e) => {
                      setNote(e.target.value);
                      noteRef.current = e.target.value;
                      dirty.current = true;
                      setNotice("Unsaved notes");
                    }}
                    onBlur={() => void flush()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void flush().then((saved) => {
                          if (saved) setNoteEditing(false);
                        });
                      }
                    }}
                  />
                  <button
                    onClick={() =>
                      void flush().then((saved) => {
                        if (saved) setNoteEditing(false);
                      })
                    }
                  >
                    Done
                  </button>
                </>
              ) : (
                <div
                  className="plan-notes"
                  onClick={() => {
                    setNote(item.notes);
                    setNoteEditing(true);
                  }}
                >
                  <MarkdownPreview
                    text={item.notes || "Add notes in Markdown…"}
                  />
                </div>
              )}
            </section>
            <section className="plan-detail-section">
              <h3>On your cards</h3>
              <div className="plan-history">
                {planning.entries
                  .filter((e) => e.itemId === item.id)
                  .map((e) => (
                    <button
                      key={e.day}
                      onClick={() =>
                        void navigate(() => {
                          setDay(e.day);
                          setProject("day");
                        })
                      }
                    >
                      {dayLabel(e.day)}
                      {e.workedOn ? " · worked on" : ""}
                    </button>
                  ))}
              </div>
              {entry && (
                <button
                  className="plan-remove"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      { type: "removePlanEntry", id: item.id, day },
                      "Removed from this day; notes and chats retained",
                    )
                  }
                >
                  Remove from this day
                </button>
              )}
            </section>
          </>
        ) : (
          <div className="empty">
            <h2>Select a plan item</h2>
            <p>
              Import your card or add broad areas of work. Project assignments
              and chat links are optional.
            </p>
          </div>
        )}
      </section>
      {modal && (
        <Modal
          title={
            {
              add: "Add a plan item",
              link: "Link existing chats",
              import: "Import daily card",
              original: "Original daily card",
              inbox: "Plan inbox",
              schedule: "Carry or schedule this item",
            }[modal]
          }
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          {modal === "add" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  { type: "createPlanItem", day, category, name },
                  "Plan item added",
                ).then((ok) => {
                  if (ok) {
                    setNoteEditing(false);
                    setSelected("");
                    setModal(null);
                  }
                });
              }}
            >
              <p>
                {category} · {dayLabel(day)}
              </p>
              <label>
                Plan item name
                <input
                  required
                  maxLength={200}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="An area of work or a specific task"
                  autoFocus
                />
              </label>
              <button disabled={busy}>Add item</button>
            </form>
          )}
          {modal === "schedule" && item && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  {
                    type: "schedulePlanItem",
                    id: item.id,
                    day: targetDay,
                    category,
                  },
                  "Scheduled; notes and chat links retained",
                ).then((ok) => {
                  if (ok) setModal(null);
                });
              }}
            >
              <p>{item.name}</p>
              <label>
                Planning day
                <input
                  type="date"
                  required
                  min="1900-01-01"
                  max="9999-12-31"
                  value={targetDay}
                  onChange={(e) => setTargetDay(e.target.value)}
                />
              </label>
              <label>
                Category
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as PlanCategory)}
                >
                  {planCategories.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <button disabled={busy}>Schedule item</button>
            </form>
          )}
          {modal === "link" && item && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  { type: "setPlanChats", id: item.id, chatIds },
                  "Chat links saved",
                ).then((ok) => {
                  if (ok) setModal(null);
                });
              }}
            >
              <p>
                Link chats to {item.name}. Their existing project assignments
                stay intact.
              </p>
              <div className="plan-chat-picker">
                {snapshot.chats.map((c) => (
                  <label key={c.id}>
                    <input
                      type="checkbox"
                      checked={chatIds.includes(c.id)}
                      onChange={(e) =>
                        setChatIds(
                          e.target.checked
                            ? [...chatIds, c.id]
                            : chatIds.filter((id) => id !== c.id),
                        )
                      }
                    />
                    <span>
                      {displayName(c)}
                      <small>
                        {c.provider}
                        {c.archived ? " · Archived" : ""}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
              {!snapshot.chats.length && (
                <p>
                  No chats yet. Existing provider chats appear here after they
                  are observed.
                </p>
              )}
              <button disabled={busy}>Save links</button>
            </form>
          )}
          {modal === "original" &&
            planning.imports
              .filter((i) => i.day === day)
              .map((i) => (
                <section key={i.id}>
                  <h3>{i.sourceName}</h3>
                  <small>
                    Imported {new Date(i.importedAt).toLocaleString()}
                  </small>
                  <pre className="plan-card-source">{i.markdown}</pre>
                </section>
              ))}
          {modal === "inbox" && (
            <>
              <p>
                Save transcribed Markdown cards to this folder, then review them
                here.
              </p>
              <div className="plan-inbox-path">
                <code>{planning.inbox.path}</code>
                <button
                  onClick={() => void window.deck.copy(planning.inbox.path)}
                >
                  Copy folder path
                </button>
              </div>
              {planning.inbox.error && (
                <p role="alert">{planning.inbox.error}</p>
              )}
              {planning.inbox.files.map((f) => (
                <div className="plan-inbox-file" key={f.name}>
                  <strong>{f.name}</strong>
                  {f.error && <p role="alert">{f.error}</p>}
                  <button disabled={!!f.error} onClick={() => loadCard(f)}>
                    Review card {f.name}
                  </button>
                </div>
              ))}
              {!planning.inbox.files.length && (
                <p>
                  No cards waiting. Imported files stay on disk and are skipped
                  on later scans.
                </p>
              )}
            </>
          )}
          {modal === "import" && (
            <>
              {!review ? (
                <>
                  <label>
                    Choose a Markdown card
                    <input
                      type="file"
                      accept=".md,.markdown,text/markdown,text/plain"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        if (file.size > 100000) {
                          setModalError("File exceeds 100 KB");
                          return;
                        }
                        void file
                          .text()
                          .then((markdown) => {
                            setCard({ name: file.name, markdown });
                            setModalError("");
                          })
                          .catch((e) => setModalError(message(e)));
                      }}
                    />
                  </label>
                  <label>
                    Card transcription
                    <textarea
                      aria-label="Card transcription"
                      value={card.markdown}
                      onChange={(e) =>
                        setCard({ ...card, markdown: e.target.value })
                      }
                    />
                  </label>
                  <button
                    onClick={() => {
                      try {
                        const parsed = parseDailyPlan(card.markdown);
                        setReview(parsed);
                        setConnections(parsed.items.map(() => null));
                        setModalError("");
                      } catch (e) {
                        setModalError(message(e));
                      }
                    }}
                  >
                    Review items
                  </button>
                </>
              ) : (
                <>
                  <p>
                    {dayLabel(review.day)} · {card.name}
                  </p>
                  <p>
                    Choose existing work to keep its notes and chats, or create
                    a new item. Project links start empty.
                  </p>
                  {review.items.map((r, index) => (
                    <div className="plan-import-row" key={index}>
                      <strong>{r.name}</strong>
                      <small>{r.category}</small>
                      <label>
                        Connect {r.name}
                        <select
                          aria-label={`Connect ${r.name}`}
                          value={connections[index] ?? ""}
                          onChange={(e) =>
                            setConnections(
                              connections.map((id, n) =>
                                n === index ? e.target.value || null : id,
                              ),
                            )
                          }
                        >
                          <option value="">Create a new plan item</option>
                          {planning.items.map((i) => (
                            <option key={i.id} value={i.id}>
                              Continue: {i.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  ))}
                  <div className="plan-actions">
                    <button disabled={busy} onClick={() => setReview(null)}>
                      Edit transcription
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (busy) return;
                        setBusy(true);
                        void (async () => {
                          if (!(await flush()))
                            throw new Error(
                              "Save your notes before importing the card",
                            );
                          await mutate({
                            type: "importDailyPlan",
                            sourceName: card.name,
                            markdown: card.markdown,
                            itemIds: connections,
                          });
                        })()
                          .then(() => {
                            setNoteEditing(false);
                            setDay(review.day);
                            setProject("day");
                            setSelected("");
                            setModal(null);
                            setNotice("Daily card imported");
                          })
                          .catch((e) => setModalError(message(e)))
                          .finally(() => setBusy(false));
                      }}
                    >
                      Import day plan
                    </button>
                  </div>
                </>
              )}
              {modalError && <p role="alert">{modalError}</p>}
            </>
          )}
        </Modal>
      )}
    </main>
  );
});
