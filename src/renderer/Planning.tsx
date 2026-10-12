import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { Command, Snapshot, Chat } from "../shared/types";
import {
  categoryDescription,
  localPlanDay,
  nextPlanDay,
  nextBusinessDay,
  parseDailyPlan,
  planCategories,
  validPlanDay,
  type PlanCategory,
  type PlanEntry,
} from "../shared/planning";
import { parseTicket } from "../shared/tickets";
import { attentionReason } from "../shared/status";
import {
  displayName,
  providerLabel,
  message,
  age,
  Status,
  Modal,
} from "./components";
import MarkdownPreview from "./MarkdownPreview";
import Icon from "./Icon";
import { TaskTickets, TaskLinks, LatestRound } from "./TaskContext";
import { NewChatList, NewChatContext } from "./NewChats";
import { recentUnlinkedChats } from "../shared/new-chats";
export interface PlanningHandle {
  flush: () => Promise<boolean>;
  selectTask: (id: string) => void;
}
const dayLabel = (day: string) =>
  new Date(day + "T12:00:00Z").toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const newTask = () => ({
  name: "",
  category: "Coding" as PlanCategory,
  ticket: "",
  notes: "",
  query: "",
  picked: "",
  continueName: "",
  continueCategory: "Coding" as PlanCategory,
});
interface ReviewDraft {
  card: string;
  sourceName: string;
  reviewing: boolean;
  names: string[];
  itemIds: (string | null)[];
  reference: string;
}
const newReview = (): ReviewDraft => ({
  card: "",
  sourceName: "Pasted card",
  reviewing: false,
  names: [],
  itemIds: [],
  reference: "",
});
function readDraft<T>(value: string | undefined, fallback: T): T {
  try {
    return value ? { ...fallback, ...JSON.parse(value) } : fallback;
  } catch {
    return fallback;
  }
}
const Planning = forwardRef<
  PlanningHandle,
  {
    snapshot: Snapshot;
    mutate: (c: Command) => Promise<void>;
    openChat: (id: string) => void;
    configureJira: () => void;
  }
>(function Planning({ snapshot, mutate, openChat, configureJira }, ref) {
  const { planning } = snapshot;
  const scope = snapshot.demo ? "demo" : "live";
  const initialDay = localStorage.getItem(`planning-day-${scope}`);
  const [day, setDay] = useState(
    initialDay && validPlanDay(initialDay) ? initialDay : localPlanDay(),
  );
  const [view, setView] = useState<"day" | "all" | "attention">("day"),
    [selected, setSelected] = useState(""),
    [search, setSearch] = useState("");
  const [panel, setPanel] = useState<"task" | "create" | "import" | "card" | "new-chat">(
    "task",
  );
  const [creator, setCreator] = useState(() =>
    readDraft(planning.drafts["task-create"], newTask()),
  );
  const [reviewDraft, setReviewDraft] = useState(() =>
    readDraft(planning.drafts["card-review"], newReview()),
  );
  const [notesEdit, setNotesEdit] = useState(false),
    [notesText, setNotesText] = useState("");
  const [wrapEdit, setWrapEdit] = useState(false),
    [wrapText, setWrapText] = useState("");
  const [rename, setRename] = useState<string | null>(null),
    [expanded, setExpanded] = useState<string | null>(null);
  const [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<"move" | "chats" | "last-day" | null>(
      null,
    ),
    [removeDay, setRemoveDay] = useState(""),
    [targetDay, setTargetDay] = useState(nextBusinessDay(day)),
    [targetCategory, setTargetCategory] = useState<PlanCategory>("Coding");
  const [chatChoices, setChatChoices] = useState<string[]>([]),
    [chatSearch, setChatSearch] = useState("");
  const [attentionChat, setAttentionChat] = useState("");
  const [newChatId, setNewChatId] = useState("");
  const [discardReview, setDiscardReview] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null),
    [dropTarget, setDropTarget] = useState<{
      category: PlanCategory;
      beforeId: string | null;
    } | null>(null);
  const panelRef = useRef<HTMLElement>(null),
    lock = useRef(false),
    draftQueue = useRef(new Map<string, string | null>()),
    draftFlight = useRef<Promise<boolean> | null>(null),
    draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    createdBefore = useRef<Set<string> | null>(null);
  const flush = useCallback((): Promise<boolean> => {
    clearTimeout(draftTimer.current);
    if (draftFlight.current) return draftFlight.current;
    const operation = (async () => {
      while (draftQueue.current.size) {
        const [key, value] = draftQueue.current.entries().next().value!;
        draftQueue.current.delete(key);
        try {
          await mutate({ type: "savePlanDraft", key, value });
        } catch (e) {
          if (!draftQueue.current.has(key)) draftQueue.current.set(key, value);
          setError(message(e));
          return false;
        }
      }
      return true;
    })().finally(() => {
      if (draftFlight.current === operation) draftFlight.current = null;
    });
    draftFlight.current = operation;
    return operation;
  }, [mutate]);
  const draft = (key: string, value: string | null) => {
    draftQueue.current.set(key, value);
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => void flush(), 300);
  };
  useImperativeHandle(
    ref,
    () => ({
      flush,
      selectTask: (id: string) => {
        setSelected(id);
        setView("all");
        setSearch("");
        setPanel("task");
        setNotesEdit(false);
        setRename(null);
        setExpanded(null);
      },
    }),
    [flush],
  );
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (draftQueue.current.size || draftFlight.current) {
        event.preventDefault();
        event.returnValue = "";
        void flush();
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => {
      clearTimeout(draftTimer.current);
      window.removeEventListener("beforeunload", guard);
    };
  }, [flush]);
  useEffect(() => {
    localStorage.setItem(`planning-day-${scope}`, day);
  }, [day, scope]);
  useEffect(() => {
    if (createdBefore.current) {
      const item = planning.items.find(
        (i) => !createdBefore.current!.has(i.id),
      );
      if (item) {
        setSelected(item.id);
        createdBefore.current = null;
      }
    }
  }, [planning.items]);
  const run = async (command: Command, text = "Saved"): Promise<boolean> => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      if (!(await flush())) return false;
      await mutate(command);
      setNotice(text);
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const allEntries = planning.entries
    .filter((e) => e.day === day)
    .sort((a, b) => a.position - b.position);
  const current =
    planning.items.find((i) => i.id === selected) ||
    planning.items.find((i) => i.id === allEntries[0]?.itemId) ||
    (view === "all" ? planning.items[0] : undefined);
  const entry = current && allEntries.find((e) => e.itemId === current.id);
  useEffect(() => {
    panelRef.current?.scrollTo(0, 0);
  }, [panel, current?.id, view, attentionChat, newChatId, day]);
  const nameOf = (id: string) =>
    (view !== "all" && allEntries.find((e) => e.itemId === id)?.name) ||
    planning.items.find((i) => i.id === id)?.name ||
    "Task";
  const shown = (
    view === "all"
      ? planning.items
      : allEntries.map((e) => planning.items.find((i) => i.id === e.itemId)!)
  ).filter(
    (i) =>
      i &&
      `${nameOf(i.id)} ${i.notes} ${i.tickets.map((t) => t.key + " " + t.note).join(" ")} ${planning.entries
        .filter((e) => e.itemId === i.id)
        .map((e) => e.name)
        .join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const attention = snapshot.chats.filter(
    (c) => !c.archived && attentionReason(c),
  );
  const newChats = recentUnlinkedChats(snapshot.chats, planning.items);
  const newChat = newChats.find((chat) => chat.id === newChatId);
  const changeDay = async (value: string) => {
    if (!validPlanDay(value) || !(await flush())) return;
    setDay(value);
    setView("day");
    setSelected("");
    setPanel("task");
    setNotesEdit(false);
    setRename(null);
    setWrapEdit(false);
    setExpanded(null);
  };
  const selectTask = async (id: string) => {
    if (!(await flush())) return;
    setSelected(id);
    setPanel("task");
    setNotesEdit(false);
    setRename(null);
    setExpanded(null);
  };
  const showPanel = async (next: typeof panel) => {
    if (!(await flush())) return;
    setPanel(next);
    setNotesEdit(false);
    setRename(null);
    setError("");
    panelRef.current?.scrollTo(0, 0);
  };
  const selectNewChat = async (id: string) => {
    if (!(await flush())) return;
    setNewChatId(id);
    setAttentionChat("");
    setPanel("new-chat");
    setNotesEdit(false);
    setRename(null);
    setError("");
  };
  const selectLinkedTask = (id: string) => {
    setSelected(id);
    setView("all");
    setSearch("");
    setPanel("task");
    setExpanded(null);
  };
  const createFromChat = (name: string, category: PlanCategory, chatId: string) => {
    createdBefore.current = new Set(planning.items.map((item) => item.id));
    void run({ type: "createPlanItem", day, name, category, chatIds: [chatId] }, "Task created with chat linked; removed from New")
      .then((ok) => {
        if (ok) {
          setPanel("task");
          setView("day");
          setSearch("");
        } else createdBefore.current = null;
      });
  };
  const updateCreator = (patch: Partial<typeof creator>) => {
    const next = { ...creator, ...patch };
    setCreator(next);
    draft("task-create", JSON.stringify(next));
  };
  const updateReview = (patch: Partial<ReviewDraft>) => {
    const next = { ...reviewDraft, ...patch };
    setReviewDraft(next);
    draft("card-review", JSON.stringify(next));
  };
  const cardReview = (() => {
    try {
      return reviewDraft.reviewing ? parseDailyPlan(reviewDraft.card) : null;
    } catch {
      return null;
    }
  })();
  const previousDays = [
    ...new Set(
      planning.entries
        .map((e) => e.day)
        .concat(
          Object.keys(planning.wrapups),
          planning.imports.map((i) => i.day),
        ),
    ),
  ]
    .filter((d) => d < (cardReview?.day || day))
    .sort()
    .reverse();
  const reference = previousDays.includes(reviewDraft.reference)
    ? reviewDraft.reference
    : previousDays[0];
  const requestLabel = (c: Chat) =>
    c.state === "waiting"
      ? c.latestRound?.requestKind === "approval"
        ? "Approval needed"
        : c.latestRound?.requestKind === "question"
          ? "Question"
          : "Needs input"
      : attentionReason(c) || "";
  const taskRow = (id: string) => {
    const item = planning.items.find((i) => i.id === id)!,
      e = allEntries.find((e) => e.itemId === id),
      waiting = snapshot.chats.filter(
        (c) =>
          item.chatIds.includes(c.id) && c.state === "waiting" && !c.archived,
      );
    return (
      <button
        key={id}
        type="button"
        data-task-card={id}
        className={`plan-row ${panel !== "new-chat" && current?.id === id ? "selected" : ""} ${waiting.length ? "plan-attention" : ""} ${dragging === id ? "dragging" : ""} ${dropTarget?.beforeId === id ? "drop-before" : ""}`}
        aria-label={`Select task ${nameOf(id)}`}
        aria-pressed={panel !== "new-chat" && current?.id === id}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
        title={
          view === "day"
            ? "Drag to reorder or change category · Alt+arrow keys"
            : ""
        }
        onClick={() => {
          if (Date.now() < suppressClick.current) return;
          void selectTask(id);
        }}
        onPointerDown={(event) => startDrag(event, id)}
        onKeyDown={(event) => {
          if (
            !event.altKey ||
            view !== "day" ||
            !e ||
            !event.key.startsWith("Arrow")
          )
            return;
          event.preventDefault();
          const peers = allEntries.filter((row) => row.category === e.category),
            index = peers.findIndex((row) => row.itemId === id);
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            const offset = event.key === "ArrowLeft" ? -1 : 1,
              category =
                planCategories[planCategories.indexOf(e.category) + offset];
            if (category)
              void run(
                { type: "reorderPlanEntry", id, day, category, beforeId: null },
                "Card moved",
              );
          } else {
            const offset = event.key === "ArrowUp" ? -1 : 1;
            if (index + offset < 0 || index + offset >= peers.length) return;
            void run(
              {
                type: "reorderPlanEntry",
                id,
                day,
                category: e.category,
                beforeId:
                  offset < 0
                    ? peers[index - 1].itemId
                    : peers[index + 2]?.itemId || null,
              },
              "Card reordered",
            );
          }
        }}
      >
        <span
          className={`plan-work-mark ${e?.workedOn ? "worked" : ""}`}
          aria-hidden="true"
        >
          {e?.workedOn ? "✓" : ""}
        </span>
        <span>
          <strong>{nameOf(id)}</strong>
          <small>
            {item.tickets.map((t) => t.key).join(" · ") || "No ticket linked"}
            {item.chatIds.length ? ` · ${item.chatIds.length} chats` : ""}
          </small>
          {waiting.length > 0 && (
            <small className="plan-needs-input">
              {waiting.map(requestLabel).join(" · ")}
            </small>
          )}
        </span>
      </button>
    );
  };
  const drag = useRef<{
      id: string;
      x: number;
      y: number;
      active: boolean;
      pointer: number;
      clientX: number;
      clientY: number;
      list: HTMLElement;
      frame?: number;
      timer?: ReturnType<typeof setTimeout>;
      category?: PlanCategory;
      beforeId?: string | null;
    } | null>(null),
    suppressClick = useRef(0);
  useEffect(
    () => () => {
      clearTimeout(drag.current?.timer);
      if (drag.current?.frame !== undefined)
        cancelAnimationFrame(drag.current.frame);
    },
    [],
  );
  function startDrag(event: React.PointerEvent, id: string) {
    if (view !== "day" || busy || event.button !== 0) return;
    const list = event.currentTarget.closest<HTMLElement>(".daily-plan");
    if (!list) return;
    const value = {
      id,
      x: event.clientX,
      y: event.clientY,
      active: false,
      pointer: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      list,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    drag.current = value;
    if (event.pointerType !== "mouse")
      value.timer = setTimeout(() => {
        if (drag.current === value) {
          value.active = true;
          setDragging(id);
        }
      }, 350);
  }
  function pointerMove(event: React.PointerEvent) {
    const value = drag.current;
    if (!value || value.pointer !== event.pointerId) return;
    value.clientX = event.clientX;
    value.clientY = event.clientY;
    const distance = Math.hypot(
      event.clientX - value.x,
      event.clientY - value.y,
    );
    if (!value.active) {
      if (event.pointerType !== "mouse") {
        if (distance > 8) {
          clearTimeout(value.timer);
          drag.current = null;
        }
        return;
      }
      if (distance < 6) return;
      value.active = true;
      setDragging(value.id);
    }
    if (!event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    updateDragTarget(value);
    if (value.frame === undefined) scrollDrag(value);
  }
  function updateDragTarget(value: NonNullable<typeof drag.current>) {
    const rect = value.list.getBoundingClientRect();
    const inside =
      value.clientX >= rect.left &&
      value.clientX < rect.right &&
      value.clientY >= rect.top &&
      value.clientY < rect.bottom;
    const target = inside
        ? document.elementFromPoint(value.clientX, value.clientY)
        : null,
      group = target?.closest<HTMLElement>("[data-card-category]");
    if (!group || !value.list.contains(group)) {
      value.category = undefined;
      value.beforeId = undefined;
      setDropTarget(null);
      return;
    }
    const row = target?.closest<HTMLElement>("[data-task-card]"),
      category = group.dataset.cardCategory as PlanCategory;
    let beforeId = row?.dataset.taskCard || null;
    if (
      row &&
      value.clientY >
        row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2
    ) {
      const peers = allEntries.filter((e) => e.category === category),
        index = peers.findIndex((e) => e.itemId === beforeId);
      beforeId = peers[index + 1]?.itemId || null;
    }
    value.category = category;
    value.beforeId = beforeId;
    setDropTarget({ category, beforeId });
  }
  function scrollDrag(value: NonNullable<typeof drag.current>) {
    value.frame = requestAnimationFrame(() => {
      value.frame = undefined;
      if (drag.current !== value || !value.active) return;
      const rect = value.list.getBoundingClientRect();
      if (
        value.clientX >= rect.left &&
        value.clientX < rect.right &&
        value.clientY >= rect.top &&
        value.clientY < rect.bottom
      ) {
        const direction =
          value.clientY < rect.top + 35
            ? -1
            : value.clientY > rect.bottom - 35
              ? 1
              : 0;
        const before = value.list.scrollTop;
        value.list.scrollTop += direction * 10;
        if (value.list.scrollTop !== before) updateDragTarget(value);
      }
      scrollDrag(value);
    });
  }
  function finishDrag(event: React.PointerEvent, cancel = false) {
    const value = drag.current;
    if (!value || value.pointer !== event.pointerId) return;
    clearTimeout(value.timer);
    if (value.frame !== undefined) cancelAnimationFrame(value.frame);
    if (value.active && !cancel) {
      value.clientX = event.clientX;
      value.clientY = event.clientY;
      updateDragTarget(value);
    }
    drag.current = null;
    setDragging(null);
    setDropTarget(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (value.active) {
      suppressClick.current = Date.now() + 500;
      if (!cancel && value.category && value.beforeId !== value.id)
        void run(
          {
            type: "reorderPlanEntry",
            id: value.id,
            day,
            category: value.category,
            beforeId: value.beforeId || null,
          },
          "Card moved",
        );
    }
  }
  const renderCard = (cardDay: string, includeBack = true) => (
    <>
      <section className="card-front" aria-label="Card front">
        <h3>Plan · {dayLabel(cardDay)}</h3>
        {planCategories.map((category) => (
          <section key={category}>
            <h3>{category}</h3>
            {planning.entries
              .filter((e) => e.day === cardDay && e.category === category)
              .sort((a, b) => a.position - b.position)
              .map((e) => (
                <div className="card-entry" key={e.itemId}>
                  <strong>{e.name}</strong>
                  {e.note && <MarkdownPreview text={e.note} />}
                </div>
              ))}
          </section>
        ))}
        {!planning.entries.some((e) => e.day === cardDay) && (
          <small>No tasks saved on this day.</small>
        )}
      </section>
      {includeBack && (
        <section
          className="plan-detail-section card-back"
          aria-label="Card back"
        >
          <h3>Wrap-up · {dayLabel(cardDay)}</h3>
          <MarkdownPreview
            text={
              planning.wrapups[cardDay] ||
              "No wrap-up saved. Your physical card can stay the source."
            }
          />
        </section>
      )}
    </>
  );
  let detail: React.ReactNode;
  if (panel === "create") {
    const matches = planning.items
        .filter((i) =>
          `${i.name} ${planning.entries
            .filter((e) => e.itemId === i.id)
            .map((e) => e.name)
            .join(" ")} ${i.tickets.map((t) => t.key).join(" ")}`
            .toLowerCase()
            .includes(creator.query.toLowerCase()),
        )
        .sort(
          (a, b) =>
            Number(allEntries.some((e) => e.itemId === a.id)) -
              Number(allEntries.some((e) => e.itemId === b.id)) ||
            b.updatedAt.localeCompare(a.updatedAt),
        )
        .slice(0, 3),
      picked = planning.items.find((i) => i.id === creator.picked);
    detail = (
      <div className="task-composer">
        <div className="section-heading">
          <h2>Add task to card</h2>
          <button
            aria-label="Close task form"
            onClick={() => void showPanel("task")}
          >
            <Icon name="x" />
          </button>
        </div>
        <small>{dayLabel(day)}</small>
        <section className="plan-detail-section">
          <h3>Continue an existing task</h3>
          <label>
            Search existing tasks
            <input
              type="search"
              autoFocus
              value={creator.query}
              onChange={(e) => updateCreator({ query: e.target.value })}
              placeholder="Search tasks or tickets"
            />
          </label>
          <div aria-live="polite">
            {matches.map((i) => (
              <button
                key={i.id}
                className="existing-task-choice"
                disabled={busy || allEntries.some((e) => e.itemId === i.id)}
                onClick={() =>
                  updateCreator({
                    picked: i.id,
                    continueName: i.name,
                    continueCategory:
                      planning.entries.filter((e) => e.itemId === i.id).at(-1)
                        ?.category || "Coding",
                  })
                }
              >
                <strong>{i.name}</strong>
                <small>
                  {allEntries.some((e) => e.itemId === i.id)
                    ? "Already on this day"
                    : `${i.chatIds.length} chats · ${i.tickets.length} tickets · ${i.links.length} saved links`}
                </small>
              </button>
            ))}
            {!matches.length && <small>No matching existing tasks.</small>}
          </div>
          {picked && !allEntries.some((e) => e.itemId === picked.id) && (
            <div>
              <label>
                Title on this card
                <input
                  required
                  maxLength={200}
                  value={creator.continueName}
                  onChange={(e) =>
                    updateCreator({ continueName: e.target.value })
                  }
                />
              </label>
              <label>
                Category on this card
                <select
                  value={creator.continueCategory}
                  onChange={(e) =>
                    updateCreator({
                      continueCategory: e.target.value as PlanCategory,
                    })
                  }
                >
                  {planCategories.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <small>
                Existing notes, tickets, links, and chats stay with the task.
                Earlier cards keep their titles.
              </small>
              <div className="plan-actions">
                <button
                  className="primary"
                  disabled={busy || !creator.continueName.trim()}
                  onClick={() =>
                    void run(
                      {
                        type: "schedulePlanItem",
                        id: picked.id,
                        day,
                        category: creator.continueCategory,
                        name: creator.continueName,
                      },
                      "Continued on this card",
                    ).then((ok) => {
                      if (ok) {
                        setSelected(picked.id);
                        setPanel("task");
                      }
                    })
                  }
                >
                  Continue on this card
                </button>
              </div>
            </div>
          )}
        </section>
        <section className="plan-detail-section">
          <h3>Create a new task</h3>
          <form
            aria-label="Create a new task"
            onSubmit={(event) => {
              event.preventDefault();
              let tickets = [] as {
                key: string;
                status: string;
                note: string;
              }[];
              try {
                if (creator.ticket.trim()) {
                  const parsed = parseTicket(creator.ticket);
                  tickets = [
                    {
                      key: parsed.jiraUrl || parsed.jiraKey,
                      status: "",
                      note: "",
                    },
                  ];
                }
              } catch (e) {
                setError(message(e));
                return;
              }
              createdBefore.current = new Set(planning.items.map((i) => i.id));
              void run(
                {
                  type: "createPlanItem",
                  day,
                  name: creator.name,
                  category: creator.category,
                  notes: creator.notes,
                  tickets,
                },
                "Task created on this card",
              ).then((ok) => {
                if (ok) {
                  setCreator(newTask());
                  setPanel("task");
                  setSearch("");
                  setView("day");
                } else createdBefore.current = null;
              });
            }}
          >
            <label>
              Task name
              <input
                required
                maxLength={200}
                value={creator.name}
                onChange={(e) => updateCreator({ name: e.target.value })}
                placeholder="What will you work on?"
              />
            </label>
            <label>
              Task category
              <select
                aria-label="Task category"
                value={creator.category}
                onChange={(e) =>
                  updateCreator({ category: e.target.value as PlanCategory })
                }
              >
                {planCategories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              Link ticket (optional)
              <input
                maxLength={2000}
                value={creator.ticket}
                onChange={(e) => updateCreator({ ticket: e.target.value })}
                placeholder="Ticket number or URL"
              />
            </label>
            <label>
              Notes (optional)
              <textarea
                maxLength={100000}
                value={creator.notes}
                onChange={(e) => updateCreator({ notes: e.target.value })}
                placeholder="Write Markdown…"
              />
            </label>
            <div className="plan-actions">
              <button className="primary" disabled={busy}>
                Create task
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setCreator(newTask());
                  draft("task-create", null);
                  void showPanel("task");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      </div>
    );
  } else if (panel === "import") {
    detail = !cardReview ? (
      <div>
        <div className="section-heading">
          <h2>Import card</h2>
          <button className="quiet" onClick={() => void showPanel("task")}>
            Back to Today
          </button>
        </div>
        <label>
          Card text
          <textarea
            className="card-transcription"
            aria-label="Card text"
            value={reviewDraft.card}
            maxLength={100000}
            onChange={(e) =>
              updateReview({ card: e.target.value, reviewing: false })
            }
            placeholder="Paste YAML or Markdown from Claude…"
          />
        </label>
        <label>
          Or upload a file
          <input
            type="file"
            accept=".yaml,.yml,.md,.markdown,text/plain,text/markdown"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 100000) {
                setError("File exceeds 100 KB");
                return;
              }
              void file
                .text()
                .then((card) => {
                  updateReview({
                    card,
                    sourceName: file.name,
                    reviewing: false,
                  });
                  setError("");
                })
                .catch((e) => setError(message(e)));
            }}
          />
        </label>
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            try {
              const parsed = parseDailyPlan(reviewDraft.card);
              updateReview({
                reviewing: true,
                names: parsed.items.map((i) => i.name),
                itemIds: parsed.items.map(() => null),
                reference: previousDays[0] || "",
              });
              setError("");
            } catch (e) {
              setError(message(e));
            }
          }}
        >
          Review card
        </button>
      </div>
    ) : (
      <div className="card-import-review" aria-label="Daily card review">
        <div className="section-heading">
          <h2>Review {dayLabel(cardReview.day)}</h2>
          <button className="quiet" onClick={() => void showPanel("task")}>
            Back to Today
          </button>
        </div>
        <small>
          {reviewDraft.sourceName} · {cardReview.items.length} entries
        </small>
        <p className="muted">
          Keep the wording from this card. Choose existing context where the
          work continues.
        </p>
        {cardReview.items.map((row, index) => (
          <div className="plan-import-row" key={index}>
            <small>{row.category}</small>
            <label>
              Title on this card
              <input
                aria-label={`Title on card ${index + 1}`}
                required
                maxLength={200}
                value={reviewDraft.names[index] ?? row.name}
                onChange={(e) =>
                  updateReview({
                    names: cardReview.items.map((r, n) =>
                      n === index
                        ? e.target.value
                        : (reviewDraft.names[n] ?? r.name),
                    ),
                  })
                }
              />
            </label>
            {[...row.tickets, ...row.related].map((ticket, n) => (
              <small className="import-ticket" key={n}>
                {[ticket.key, ticket.status, ticket.note]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            ))}
            {row.note && <MarkdownPreview text={row.note} />}
            <label>
              Task context
              <select
                aria-label={`Task context ${index + 1}`}
                value={reviewDraft.itemIds[index] || ""}
                onChange={(e) =>
                  updateReview({
                    itemIds: cardReview.items.map((_, n) =>
                      n === index
                        ? e.target.value || null
                        : reviewDraft.itemIds[n] || null,
                    ),
                  })
                }
              >
                <option value="">New task</option>
                {planning.items.map((i) => (
                  <option key={i.id} value={i.id}>
                    Continue: {i.name}
                  </option>
                ))}
              </select>
            </label>
            {reviewDraft.itemIds[index] && (
              <details>
                <summary>Existing task context</summary>
                {(() => {
                  const item = planning.items.find(
                    (i) => i.id === reviewDraft.itemIds[index],
                  );
                  return item ? (
                    <>
                      <small>
                        {item.chatIds.length} chats ·{" "}
                        {item.tickets.map((t) => t.key).join(" · ") ||
                          "No tickets"}{" "}
                        · {item.links.length} saved links
                      </small>
                      <MarkdownPreview text={item.notes} />
                    </>
                  ) : (
                    <small>
                      This task was removed; choose another context.
                    </small>
                  );
                })()}
              </details>
            )}
          </div>
        ))}
        <div className="plan-actions">
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(
                {
                  type: "importDailyPlan",
                  card: reviewDraft.card,
                  sourceName: reviewDraft.sourceName,
                  itemIds: reviewDraft.itemIds,
                  names: reviewDraft.names,
                },
                "Card imported",
              ).then((ok) => {
                if (ok) {
                  setDay(cardReview.day);
                  setSelected(
                    reviewDraft.itemIds.find((id): id is string => !!id) || "",
                  );
                  setView("day");
                  setPanel("task");
                  setReviewDraft(newReview());
                  setExpanded(null);
                  setSearch("");
                }
              })
            }
          >
            Import card
          </button>
          <button
            disabled={busy}
            onClick={() => updateReview({ reviewing: false })}
          >
            Edit transcription
          </button>
          <button disabled={busy} onClick={() => setDiscardReview(true)}>
            Cancel
          </button>
        </div>
        {discardReview && (
          <div className="discard-review" role="alert">
            <strong>Discard this card review?</strong>
            <div className="plan-actions">
              <button onClick={() => setDiscardReview(false)}>
                Keep reviewing
              </button>
              <button
                onClick={() => {
                  setReviewDraft(newReview());
                  draft("card-review", null);
                  setDiscardReview(false);
                  void showPanel("task");
                }}
              >
                Discard review
              </button>
            </div>
          </div>
        )}
      </div>
    );
  } else if (panel === "card") {
    detail = (
      <div className="daily-card">
        <div className="section-heading">
          <h2>Daily card · {dayLabel(day)}</h2>
          <button className="quiet" onClick={() => void showPanel("task")}>
            Back to tasks
          </button>
        </div>
        {renderCard(day, false)}
        <section
          className="plan-detail-section card-back"
          aria-label="Card back"
        >
          <h3>Wrap-up notes</h3>
          {wrapEdit ? (
            <div>
              <textarea
                aria-label="Day wrap-up"
                autoFocus
                maxLength={100000}
                value={wrapText}
                onChange={(e) => {
                  setWrapText(e.target.value);
                  draft(`wrap:${day}`, e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setWrapEdit(false);
                    draft(`wrap:${day}`, null);
                  }
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                    e.preventDefault();
                    void run(
                      { type: "setDayWrapup", day, notes: wrapText },
                      "Wrap-up saved",
                    ).then((ok) => {
                      if (ok) setWrapEdit(false);
                    });
                  }
                }}
              />
              <div className="plan-actions">
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(
                      { type: "setDayWrapup", day, notes: wrapText },
                      "Wrap-up saved",
                    ).then((ok) => {
                      if (ok) setWrapEdit(false);
                    })
                  }
                >
                  Save wrap-up
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    setWrapEdit(false);
                    draft(`wrap:${day}`, null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              className="task-note-display"
              aria-label={
                planning.drafts[`wrap:${day}`] !== undefined
                  ? "Resume wrap-up"
                  : "Edit wrap-up"
              }
              onClick={() => {
                setWrapText(
                  planning.drafts[`wrap:${day}`] ?? planning.wrapups[day] ?? "",
                );
                setWrapEdit(true);
              }}
            >
              <MarkdownPreview
                text={planning.wrapups[day] || "Click to write wrap-up notes…"}
              />
              {planning.drafts[`wrap:${day}`] !== undefined && (
                <small>Unsaved draft · click to resume</small>
              )}
            </button>
          )}
          <small>
            Optional. You can keep the back of your physical card as your
            wrap-up.
          </small>
        </section>
        {planning.imports
          .filter((i) => i.day === day)
          .map((i) => (
            <details key={i.id}>
              <summary>Original transcription · {i.sourceName}</summary>
              <pre className="plan-card-source">{i.card}</pre>
            </details>
          ))}
      </div>
    );
  } else if (panel === "new-chat") {
    detail = newChat ? <NewChatContext key={newChat.id} chat={newChat} snapshot={snapshot}
      day={day} busy={busy} save={run} selectTask={selectLinkedTask} create={createFromChat} openChat={openChat} /> : (
      <div className="empty"><h2>Chat no longer available</h2><p>Select another chat or task.</p></div>
    );
  } else if (view === "attention") {
    const chat = attention.find((c) => c.id === attentionChat) || attention[0];
    detail = chat ? (
      <>
        <h2>{displayName(chat)}</h2>
        <LatestRound chat={chat} fullHistory={() => openChat(chat.id)} />
      </>
    ) : (
      <div className="empty">
        <h2>Nothing needs attention</h2>
        <p>New requests will appear here when observed.</p>
      </div>
    );
  } else if (current) {
    detail = (
      <div key={current.id}>
        <small>
          Task ·{" "}
          {entry ? `${entry.category} · ${dayLabel(day)}` : "Not on this day"}
        </small>
        <div className="task-name-heading">
          {rename !== null ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  entry
                    ? {
                        type: "updatePlanEntry",
                        id: current.id,
                        day,
                        name: rename,
                      }
                    : {
                        type: "updatePlanItem",
                        id: current.id,
                        patch: { name: rename },
                      },
                  "Task renamed",
                ).then((ok) => {
                  if (ok) setRename(null);
                });
              }}
            >
              <label>
                Task name
                <input
                  aria-label="Rename task name"
                  autoFocus
                  required
                  maxLength={200}
                  value={rename}
                  onChange={(e) => setRename(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setRename(null);
                  }}
                />
              </label>
              <button disabled={busy}>Save name</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setRename(null)}
              >
                Cancel
              </button>
            </form>
          ) : (
            <>
              <h2>{nameOf(current.id)}</h2>
              <button
                className="rename-task"
                aria-label="Rename task"
                title="Rename task"
                onClick={() => setRename(nameOf(current.id))}
              >
                <Icon name="pencil" />
              </button>
            </>
          )}
        </div>
        <div className="plan-actions">
          {entry ? (
            <>
              <button
                className={entry.workedOn ? "plan-worked" : "primary"}
                aria-pressed={entry.workedOn}
                disabled={busy}
                onClick={() =>
                  void run(
                    {
                      type: "setPlanWorkedOn",
                      id: current.id,
                      day,
                      workedOn: !entry.workedOn,
                    },
                    entry.workedOn
                      ? "Marked as not done"
                      : "Marked as done on this day",
                  )
                }
              >
                {entry.workedOn ? "✓ Done" : "Mark as done"}
              </button>
              <button
                className="quiet"
                disabled={busy}
                onClick={() => {
                  setTargetDay(nextBusinessDay(day));
                  setTargetCategory(entry.category);
                  setModal("move");
                  setError("");
                }}
              >
                Move to another day
              </button>
            </>
          ) : (
            <button
              disabled={busy}
              onClick={() => {
                updateCreator({
                  picked: current.id,
                  continueName: current.name,
                  continueCategory:
                    planning.entries
                      .filter((e) => e.itemId === current.id)
                      .at(-1)?.category || "Coding",
                });
                void showPanel("create");
              }}
            >
              Continue on this day
            </button>
          )}
        </div>
        {entry && (
          <label className="task-day-category">
            Category for this day
            <select
              value={entry.category}
              disabled={busy}
              onChange={(e) =>
                void run(
                  {
                    type: "updatePlanEntry",
                    id: current.id,
                    day,
                    category: e.target.value as PlanCategory,
                  },
                  "Category changed",
                )
              }
            >
              {planCategories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        )}
        {entry?.note && entry.note !== current.notes && (
          <section className="plan-detail-section">
            <h3>On this card</h3>
            <MarkdownPreview text={entry.note} />
          </section>
        )}
        <TaskTickets
          key={`tickets:${current.id}`}
          item={current}
          settings={snapshot.settings}
          save={run}
          busy={busy}
          drafts={planning.drafts}
          onDraft={draft}
          configureJira={configureJira}
        />
        <TaskLinks
          key={`links:${current.id}`}
          item={current}
          links={snapshot.links}
          chats={snapshot.chats}
          settings={snapshot.settings}
          save={run}
          busy={busy}
          drafts={planning.drafts}
          onDraft={draft}
        />
        <section className="plan-detail-section" aria-label="Linked chats">
          <div className="section-heading">
            <h3>Linked chats</h3>
            <button
              className="context-plus"
              aria-label="Link chat"
              title="Link chat"
              disabled={busy}
              onClick={() => {
                setChatChoices(current.chatIds);
                setChatSearch("");
                setModal("chats");
              }}
            >
              +
            </button>
          </div>
          {snapshot.chats
            .filter((c) => current.chatIds.includes(c.id))
            .map((c) => (
              <div
                className={`task-linked-chat ${c.state === "waiting" ? "needs-input" : ""}`}
                key={c.id}
              >
                <div className="task-context-row">
                  <button
                    className="task-chat-open"
                    aria-expanded={expanded === c.id}
                    onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                  >
                    <span className="task-chat-title"><strong>{displayName(c)}</strong>
                      {current.automaticChatIds?.includes(c.id) && <span className="task-ai-badge" role="img" aria-label="Linked automatically by AI" title="Linked automatically by AI"><Icon name="sparkles" /></span>}
                    </span>
                    <small>
                      {snapshot.projects.find((p) => p.id === c.repoProjectId)
                        ?.name || "No repository"}{" "}
                      · {providerLabel(c.provider)} · Last event{" "}
                      {age(c.lastEventAt)}
                    </small>
                    <Status chat={c} />
                    {c.state === "waiting" && (
                      <small className="plan-needs-input">
                        {requestLabel(c)}
                      </small>
                    )}
                  </button>
                  <div className="context-row-tools">
                    <button
                      aria-label={`Remove linked chat ${displayName(c)}`}
                      title="Remove from task"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          {
                            type: "setPlanChats",
                            id: current.id,
                            chatIds: current.chatIds.filter(
                              (id) => id !== c.id,
                            ),
                          },
                          "Chat removed from task",
                        )
                      }
                    >
                      <Icon name="x" />
                    </button>
                  </div>
                </div>
                {expanded === c.id && (
                  <LatestRound chat={c} fullHistory={() => openChat(c.id)} />
                )}
              </div>
            ))}
          {!current.chatIds.length && <small>No chat linked yet.</small>}
        </section>
        <section className="plan-detail-section" aria-label="Task notes">
          <h3>Notes</h3>
          {notesEdit ? (
            <div>
              <textarea
                aria-label="Task notes"
                autoFocus
                maxLength={100000}
                value={notesText}
                onChange={(e) => {
                  setNotesText(e.target.value);
                  draft(`notes:${current.id}`, e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setNotesEdit(false);
                    draft(`notes:${current.id}`, null);
                  }
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                    e.preventDefault();
                    void run(
                      {
                        type: "updatePlanItem",
                        id: current.id,
                        patch: { notes: notesText },
                      },
                      "Notes saved",
                    ).then((ok) => {
                      if (ok) setNotesEdit(false);
                    });
                  }
                }}
              />
              <div className="plan-actions">
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(
                      {
                        type: "updatePlanItem",
                        id: current.id,
                        patch: { notes: notesText },
                      },
                      "Notes saved",
                    ).then((ok) => {
                      if (ok) setNotesEdit(false);
                    })
                  }
                >
                  Save notes
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    setNotesEdit(false);
                    draft(`notes:${current.id}`, null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div
              className="task-note-display"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("button")) return;
                setNotesText(
                  planning.drafts[`notes:${current.id}`] ?? current.notes,
                );
                setNotesEdit(true);
              }}
            >
              <button
                className="task-note-edit"
                aria-label="Edit task notes"
                title="Edit notes"
                onClick={() => {
                  setNotesText(
                    planning.drafts[`notes:${current.id}`] ?? current.notes,
                  );
                  setNotesEdit(true);
                }}
              >
                <Icon name="pencil" />
              </button>
              <MarkdownPreview
                text={current.notes || "Click to add notes in Markdown…"}
              />
              {planning.drafts[`notes:${current.id}`] !== undefined && (
                <small>Unsaved draft · click to resume</small>
              )}
            </div>
          )}
        </section>
        <section className="plan-detail-section">
          <h3>On your cards</h3>
          <div className="plan-history">
            {planning.entries
              .filter((e) => e.itemId === current.id)
              .map((e) => (
                <span className="task-day-chip" key={e.day}>
                  <button
                    className={e.day === day ? "selected" : ""}
                    onClick={() => {
                      void changeDay(e.day).then(() => setSelected(current.id));
                    }}
                    title={e.name}
                  >
                    {dayLabel(e.day)}
                    {e.workedOn ? " · Done" : ""}
                  </button>
                  <button
                    aria-label={`Remove task from ${e.day}`}
                    title="Remove from this day"
                    disabled={busy}
                    onClick={() => {
                      const count = planning.entries.filter(
                        (row) => row.itemId === current.id,
                      ).length;
                      if (count === 1) {
                        setRemoveDay(e.day);
                        setModal("last-day");
                      } else
                        void run(
                          {
                            type: "removePlanEntry",
                            id: current.id,
                            day: e.day,
                          },
                          "Removed from this day",
                        ).then((ok) => {
                          if (ok && e.day === day) setSelected("");
                        });
                    }}
                  >
                    <Icon name="x" />
                  </button>
                </span>
              ))}
          </div>
        </section>
      </div>
    );
  } else
    detail = (
      <div className="empty">
        <h2>Your daily workspace</h2>
        <p>Add a task or import a dated card.</p>
      </div>
    );
  return (
    <main
      className="today-workspace"
      onPointerMove={pointerMove}
      onPointerUp={(e) => finishDrag(e)}
      onPointerCancel={(e) => finishDrag(e, true)}
    >
      <div className="today-columns">
        <section className="daily-plan" aria-label="Daily tasks">
          <div className="plan-date">
            <h2>
              {view === "all"
                ? "All tasks"
                : view === "attention"
                  ? "Needs attention"
                  : day === localPlanDay()
                    ? "Today"
                    : dayLabel(day)}
            </h2>
            {(view !== "day" || day === localPlanDay()) && (
              <small>{dayLabel(day)}</small>
            )}
          </div>
          <div className="day-navigation">
            <button
              aria-label="Previous planning day"
              onClick={() => void changeDay(nextPlanDay(day, -1))}
            >
              ‹
            </button>
            <input
              type="date"
              aria-label="Plan date"
              min="1900-01-01"
              max="9999-12-31"
              value={day}
              onChange={(e) => void changeDay(e.target.value)}
            />
            <button
              aria-label="Next planning day"
              onClick={() => void changeDay(nextPlanDay(day))}
            >
              ›
            </button>
            {day !== localPlanDay() && (
              <button onClick={() => void changeDay(localPlanDay())}>
                Today
              </button>
            )}
          </div>
          <div className="planning-filter-bar">
            <nav className="planning-views" aria-label="Task views">
              {(
                [
                  ["day", "This day"],
                  ["attention", `Needs attention ${attention.length}`],
                  ["all", "All tasks"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={view === value}
                  className={view === value ? "selected" : ""}
                  onClick={() => {
                    void flush().then((ok) => {
                      if (ok) {
                        setView(value);
                        setPanel("task");
                        setNotesEdit(false);
                        setRename(null);
                      }
                    });
                  }}
                >
                  {label}
                </button>
              ))}
            </nav>
            <button className="planning-import" disabled={busy} onClick={() => void showPanel("import")}>
              {panel === "import" ? "Import / review card" : reviewDraft.card ? "Resume card review" : "Import card"}
            </button>
          </div>
          {panel !== "import" && <NewChatList chats={newChats} snapshot={snapshot}
            selected={panel === "new-chat" ? newChatId : ""} select={(id) => void selectNewChat(id)} />}
          {panel === "import" && cardReview ? (
            <div className="previous-card-reference">
              <h3>Previous card</h3>
              {previousDays.length ? (
                <>
                  <label>
                    Reference card
                    <select
                      value={reference}
                      onChange={(e) =>
                        updateReview({ reference: e.target.value })
                      }
                    >
                      {previousDays.map((d) => (
                        <option key={d} value={d}>
                          {dayLabel(d)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {renderCard(reference)}
                </>
              ) : (
                <small>
                  No earlier saved card. Your physical card can be the
                  reference.
                </small>
              )}
            </div>
          ) : view === "attention" ? (
            <>
              <label>
                Search requests
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              {attention
                .filter((c) =>
                  `${displayName(c)} ${c.latestRound?.request || c.preview}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((c) => (
                  <button
                    key={c.id}
                    className={`plan-row ${c.id === attentionChat ? "selected" : ""}`}
                    onClick={() => setAttentionChat(c.id)}
                  >
                    <span>
                      <strong>{displayName(c)}</strong>
                      <small>
                        {requestLabel(c)} · {providerLabel(c.provider)}
                      </small>
                    </span>
                  </button>
                ))}
            </>
          ) : (
            <>
              <label className="task-search">
                <span className="sr-only">Search tasks</span>
                <input
                  type="search"
                  aria-label="Search tasks"
                  value={search}
                  placeholder="Search tasks, tickets, or notes"
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              {view === "day" && (
                <div className="plan-source">
                  <small>
                    Daily card
                    {planning.imports.filter((i) => i.day === day).length
                      ? ` · ${planning.imports.filter((i) => i.day === day).length} imports`
                      : ""}
                  </small>
                  <button
                    className="quiet"
                    onClick={() => void showPanel("card")}
                  >
                    View card
                  </button>
                </div>
              )}
              {view === "day" ? (
                planCategories.map((category) => (
                  <section
                    className={`plan-category ${dropTarget?.category === category && !dropTarget.beforeId ? "drop-category" : ""}`}
                    data-card-category={category}
                    key={category}
                  >
                    <div className="plan-category-title">
                      <h3>{category}</h3>
                      <small>
                        {
                          shown.filter(
                            (i) =>
                              allEntries.find((e) => e.itemId === i.id)
                                ?.category === category,
                          ).length
                        }
                      </small>
                    </div>
                    <p className="plan-category-caption">
                      {categoryDescription[category]}
                    </p>
                    {shown
                      .filter(
                        (i) =>
                          allEntries.find((e) => e.itemId === i.id)
                            ?.category === category,
                      )
                      .map((i) => taskRow(i.id))}
                  </section>
                ))
              ) : (
                <>
                  {shown.map((i) => taskRow(i.id))}
                  {!shown.length && <small>No matching tasks.</small>}
                </>
              )}
              <div className="plan-add-row">
                <button
                  className="quiet"
                  onClick={() => void showPanel("create")}
                >
                  + Add task
                </button>
              </div>
              {view === "day" && (
                <>
                  <p className="plan-summary">
                    {allEntries.filter((e) => e.workedOn).length} of{" "}
                    {allEntries.length} tasks done on this day
                  </p>
                  <button
                    className="quiet"
                    onClick={() => {
                      setWrapText(
                        planning.drafts[`wrap:${day}`] ??
                          planning.wrapups[day] ??
                          "",
                      );
                      setWrapEdit(true);
                      void showPanel("card");
                    }}
                  >
                    Wrap up day
                  </button>
                </>
              )}
            </>
          )}
        </section>
        <section
          className="plan-details"
          ref={panelRef}
          aria-label="Task workspace"
        >
          {detail}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
      </div>
      <footer className="planning-footer" aria-live="polite">
        <span>
          {notice || "Read-only agent observations · Task completion is manual"}
        </span>
        {planning.undoId && (
          <button
            className="quiet"
            disabled={busy}
            onClick={() =>
              void run(
                { type: "undoPlanning", undoId: planning.undoId! },
                "Undid the last planning change",
              )
            }
          >
            Undo
          </button>
        )}
      </footer>
      {modal === "move" && current && (
        <Modal
          title="Move to another day"
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                {
                  type: "reschedulePlanItem",
                  id: current.id,
                  fromDay: day,
                  day: targetDay,
                  category: targetCategory,
                },
                "Task moved; context retained",
              ).then((ok) => {
                if (ok) {
                  setModal(null);
                  setDay(targetDay);
                  setSelected(current.id);
                }
              });
            }}
          >
            <strong>{nameOf(current.id)}</strong>
            <div className="plan-actions">
              {[1, 3, 5].map((n) => (
                <button
                  type="button"
                  key={n}
                  onClick={() => setTargetDay(nextBusinessDay(day, n))}
                >
                  {n === 1 ? "Next business day" : `+${n} business days`}
                </button>
              ))}
            </div>
            <small>
              Business days are Monday–Friday. Choose any date below.
            </small>
            <label>
              Day
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
                value={targetCategory}
                onChange={(e) =>
                  setTargetCategory(e.target.value as PlanCategory)
                }
              >
                {planCategories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <p>
              Moves this task off {dayLabel(day)}. Notes, tickets, chats, and
              links stay with it. The done mark is reset on the destination day.
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="plan-actions">
              <button className="primary" disabled={busy}>
                Move to day
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "chats" && current && (
        <Modal
          title="Link chats"
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          <label>
            Search chats to link
            <input
              autoFocus
              type="search"
              value={chatSearch}
              onChange={(e) => setChatSearch(e.target.value)}
            />
          </label>
          <div className="plan-chat-picker">
            {snapshot.chats
              .filter((c) =>
                `${displayName(c)} ${providerLabel(c.provider)} ${snapshot.projects.find((p) => p.id === c.repoProjectId)?.name || ""}`
                  .toLowerCase()
                  .includes(chatSearch.toLowerCase()),
              )
              .sort((a, b) =>
                (b.lastEventAt || b.createdAt).localeCompare(
                  a.lastEventAt || a.createdAt,
                ),
              )
              .map((c) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={chatChoices.includes(c.id)}
                    onChange={(e) =>
                      setChatChoices(
                        e.target.checked
                          ? [...chatChoices, c.id]
                          : chatChoices.filter((id) => id !== c.id),
                      )
                    }
                  />
                  <span>
                    {displayName(c)}
                    <small>
                      {providerLabel(c.provider)}
                      {c.archived ? " · Archived" : ""}
                    </small>
                  </span>
                </label>
              ))}
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="plan-actions">
            <button
              disabled={busy}
              onClick={() =>
                void run(
                  {
                    type: "setPlanChats",
                    id: current.id,
                    chatIds: chatChoices,
                  },
                  "Chats linked",
                ).then((ok) => {
                  if (ok) setModal(null);
                })
              }
            >
              Save links
            </button>
            <button disabled={busy} onClick={() => setModal(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
      {modal === "last-day" && current && (
        <Modal
          title="Remove this task?"
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          <p>
            This is the final card containing{" "}
            <strong>{nameOf(current.id)}</strong>. Removing it also removes the
            task's notes, tickets, saved links, and chat associations.
          </p>
          <p>
            The original chats, tickets, and linked pages remain. Undo can
            restore the task.
          </p>
          <div className="plan-actions">
            <button
              data-initial-focus
              autoFocus
              disabled={busy}
              onClick={() => setModal(null)}
            >
              Cancel
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void run(
                  {
                    type: "removePlanEntry",
                    id: current.id,
                    day: removeDay,
                    confirmLast: true,
                  },
                  "Final card removed; task removed",
                ).then((ok) => {
                  if (ok) {
                    setModal(null);
                    setSelected("");
                  }
                })
              }
            >
              Remove task
            </button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
    </main>
  );
});
export default Planning;
