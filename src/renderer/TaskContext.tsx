import { useState, useEffect, useRef } from "react";
import type { Chat, ChatLink, Command, Settings } from "../shared/types";
import type { PlanItem, PlanLink } from "../shared/planning";
import { linkCategory, linkLabel } from "../shared/links";
import { parseTicket, resolveTicketUrl } from "../shared/tickets";
import { displayName, age, providerLabel, Status, message } from "./components";
import Icon from "./Icon";
import MarkdownPreview from "./MarkdownPreview";
type Save = (c: Command, notice?: string) => Promise<boolean>;
function useEditorDraft<T>(
  key: string,
  drafts: Record<string, string>,
  onDraft: (key: string, value: string | null) => void,
) {
  const [value, setValue] = useState<T | null>(() => {
    try {
      return drafts[key] ? JSON.parse(drafts[key]) : null;
    } catch {
      return null;
    }
  });
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    onDraft(key, value === null ? null : JSON.stringify(value));
  }, [value]);
  return [value, setValue] as const;
}
export function trackedLinks(
  item: PlanItem,
  links: ChatLink[],
  settings: Settings,
): (PlanLink & { saved: boolean; sources: string[] })[] {
  const found = new Map(
    item.links.map((link) => [
      link.url,
      { ...link, saved: true, sources: [] as string[] },
    ]),
  );
  for (const link of links.filter((link) =>
    item.chatIds.includes(link.chatId),
  )) {
    let current = found.get(link.url);
    if (!current) {
      const raw = linkCategory(link.url, settings.linkRules);
      current = {
        ...link,
        category: Object.hasOwn(item.categoryOverrides, raw)
          ? item.categoryOverrides[raw]
          : raw,
        saved: false,
        sources: [],
      };
      found.set(link.url, current);
    }
    if (!current.sources.includes(link.chatId))
      current.sources.push(link.chatId);
  }
  return [...found.values()]
    .filter((link) => !item.hiddenLinks.includes(link.url))
    .sort((a, b) => a.category.localeCompare(b.category));
}
export function TaskTickets({
  item,
  settings,
  save,
  busy,
  configureJira,
  drafts,
  onDraft,
}: {
  item: PlanItem;
  settings: Settings;
  save: Save;
  busy: boolean;
  configureJira: () => void;
  drafts: Record<string, string>;
  onDraft: (key: string, value: string | null) => void;
}) {
  const [edit, setEdit] = useEditorDraft<{
      original: string;
      key: string;
      status: string;
      note: string;
    }>(`tickets:${item.id}`, drafts, onDraft),
    [error, setError] = useState("");
  const submit = async () => {
    if (!edit) return;
    try {
      const parsed = parseTicket(edit.key);
      const key = parsed.jiraUrl || parsed.jiraKey;
      if (!key) throw new Error("Enter a ticket number or URL");
      if (item.tickets.some((t) => t.key === key && t.key !== edit.original))
        throw new Error("This ticket is already linked");
      const ticket = {
          key,
          status: edit.status.trim(),
          note: edit.note.trim(),
        },
        tickets = edit.original
          ? item.tickets.map((t) => (t.key === edit.original ? ticket : t))
          : [...item.tickets, ticket];
      if (
        await save(
          { type: "updatePlanItem", id: item.id, patch: { tickets } },
          "Ticket saved",
        )
      ) {
        setEdit(null);
        setError("");
      }
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <section className="plan-detail-section" aria-label="Linked tickets">
      <div className="section-heading">
        <h3>Linked tickets</h3>
        <button
          className="context-plus"
          aria-label="Link ticket"
          title="Link ticket"
          disabled={busy || !!edit}
          onClick={() => {
            setEdit({ original: "", key: "", status: "", note: "" });
            setError("");
          }}
        >
          +
        </button>
      </div>
      {item.tickets.map((t) => {
        let href = "";
        try {
          href = resolveTicketUrl(
            {
              jiraKey: /^https?:\/\//i.test(t.key) ? "" : t.key,
              jiraUrl: /^https?:\/\//i.test(t.key) ? t.key : "",
            },
            settings,
          );
        } catch {
          /* Configuration is offered on click. */
        }
        return (
          <div key={t.key} className="task-context-row">
            <div>
              {href ? (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    void window.deck
                      .openPlanTicket(item.id, t.key)
                      .catch((e) => setError(message(e)));
                  }}
                >
                  {t.key}
                </a>
              ) : (
                <button
                  className="quiet ticket-link"
                  onClick={configureJira}
                  title="Set the ticket base URL in Settings"
                >
                  {t.key}
                </button>
              )}
              {(t.status || t.note) && (
                <small>{[t.status, t.note].filter(Boolean).join(" · ")}</small>
              )}
            </div>
            <div className="context-row-tools">
              <button
                aria-label={`Edit ticket ${t.key}`}
                title="Edit ticket"
                disabled={busy}
                onClick={() => {
                  setEdit({ ...t, original: t.key });
                  setError("");
                }}
              >
                <Icon name="pencil" />
              </button>
              <button
                aria-label={`Remove ticket ${t.key}`}
                title="Remove from task"
                disabled={busy}
                onClick={() =>
                  void save(
                    {
                      type: "updatePlanItem",
                      id: item.id,
                      patch: {
                        tickets: item.tickets.filter(
                          (row) => row.key !== t.key,
                        ),
                      },
                    },
                    "Ticket removed from task",
                  )
                }
              >
                <Icon name="x" />
              </button>
            </div>
          </div>
        );
      })}
      {!item.tickets.length && !edit && <small>No ticket linked yet.</small>}
      {edit && (
        <form
          className="task-context-edit"
          aria-label="Edit task ticket"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !busy) setEdit(null);
          }}
        >
          <label>
            Ticket number or URL
            <input
              aria-label="Ticket number or URL"
              required
              maxLength={2000}
              autoFocus
              value={edit.key}
              onChange={(e) => setEdit({ ...edit, key: e.target.value })}
            />
          </label>
          <label>
            Status (optional)
            <input
              maxLength={50}
              value={edit.status}
              onChange={(e) => setEdit({ ...edit, status: e.target.value })}
            />
          </label>
          <label>
            Ticket note (optional)
            <input
              maxLength={500}
              value={edit.note}
              onChange={(e) => setEdit({ ...edit, note: e.target.value })}
            />
          </label>
          <div className="plan-actions">
            <button disabled={busy}>Save ticket</button>
            <button type="button" disabled={busy} onClick={() => setEdit(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
export function TaskLinks({
  item,
  links,
  chats,
  settings,
  save,
  busy,
  drafts,
  onDraft,
}: {
  item: PlanItem;
  links: ChatLink[];
  chats: Chat[];
  settings: Settings;
  save: Save;
  busy: boolean;
  drafts: Record<string, string>;
  onDraft: (key: string, value: string | null) => void;
}) {
  const rows = trackedLinks(item, links, settings),
    categories = [
      ...new Set([
        "Other",
        ...settings.linkRules.map((rule) =>
          Object.hasOwn(item.categoryOverrides, rule.category)
            ? item.categoryOverrides[rule.category]
            : rule.category,
        ),
        ...Object.values(item.categoryOverrides),
        ...rows.map((l) => l.category),
        ...item.links.map((l) => l.category),
      ]),
    ];
  const [edit, setEdit] = useEditorDraft<{
      original: string;
      url: string;
      label: string;
      category: string;
      newCategory: string;
    }>(`links:${item.id}`, drafts, onDraft),
    [categoryEdit, setCategoryEdit] = useEditorDraft<{
      original: string;
      name: string;
    }>(`categories:${item.id}`, drafts, onDraft),
    [error, setError] = useState("");
  const submit = async () => {
    if (!edit) return;
    try {
      const parsed = parseTicket(edit.url);
      if (!parsed.jiraUrl)
        throw new Error("Use a complete HTTP or HTTPS URL without credentials");
      const url = parsed.jiraUrl,
        category = (
          edit.category === "new" ? edit.newCategory : edit.category
        ).trim();
      if (!category) throw new Error("Enter a category name");
      if (
        item.links.some(
          (l) =>
            l.url === url &&
            l.url !== edit.original &&
            !item.hiddenLinks.includes(url),
        )
      )
        throw new Error("This URL is already linked");
      const link = { url, label: edit.label.trim(), category };
      if (
        await save(
          {
            type: "updatePlanItem",
            id: item.id,
            patch: {
              links: [
                ...item.links.filter(
                  (l) => l.url !== edit.original && l.url !== url,
                ),
                link,
              ],
              hiddenLinks: [
                ...new Set([
                  ...item.hiddenLinks.filter((hidden) => hidden !== url),
                  ...(edit.original && edit.original !== url
                    ? [edit.original]
                    : []),
                ]),
              ],
            },
          },
          "Link saved",
        )
      ) {
        setEdit(null);
        setError("");
      }
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <section className="plan-detail-section" aria-label="Tracked links">
      <div className="section-heading">
        <h3>Tracked links</h3>
        <button
          className="context-plus"
          aria-label="Link URL"
          title="Link URL"
          disabled={busy || !!edit}
          onClick={() => {
            setEdit({
              original: "",
              url: "",
              label: "",
              category: "Other",
              newCategory: "",
            });
            setError("");
          }}
        >
          +
        </button>
      </div>
      {[...new Set(rows.map((row) => row.category))].map((category) => (
        <div className="task-link-category" key={category}>
          {categoryEdit?.original === category ? (
            <form
              className="category-inline-edit"
              onSubmit={(e) => {
                e.preventDefault();
                const name = categoryEdit.name.trim();
                if (!name) {
                  setError("Enter a category name");
                  return;
                }
                const overrides = Object.fromEntries(
                  Object.entries(item.categoryOverrides).map(([key, value]) => [
                    key,
                    value === category ? name : value,
                  ]),
                );
                void save(
                  {
                    type: "updatePlanItem",
                    id: item.id,
                    patch: {
                      links: item.links.map((l) =>
                        l.category === category ? { ...l, category: name } : l,
                      ),
                      categoryOverrides: { ...overrides, [category]: name },
                    },
                  },
                  "Category renamed",
                ).then((ok) => {
                  if (ok) setCategoryEdit(null);
                });
              }}
            >
              <label>
                Category name
                <input
                  aria-label="Category name"
                  autoFocus
                  required
                  maxLength={100}
                  value={categoryEdit.name}
                  onChange={(e) =>
                    setCategoryEdit({ ...categoryEdit, name: e.target.value })
                  }
                />
              </label>
              <button disabled={busy}>Save</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setCategoryEdit(null)}
              >
                Cancel
              </button>
            </form>
          ) : (
            <button
              className="task-link-label quiet"
              title="Edit category"
              disabled={busy}
              onClick={() => {
                setCategoryEdit({ original: category, name: category });
                setError("");
              }}
            >
              {category}
            </button>
          )}
          <div className="task-link-stack">
            {rows
              .filter((row) => row.category === category)
              .map((link) => (
                <div className="task-context-row" key={link.url}>
                  <a
                    href={link.url}
                    onClick={(e) => {
                      e.preventDefault();
                      void window.deck
                        .openPlanLink(item.id, link.url)
                        .catch((e) => setError(message(e)));
                    }}
                    title={link.url}
                  >
                    {linkLabel(link)}
                  </a>
                  <div className="context-row-tools">
                    <button
                      title="Edit link"
                      aria-label={`Edit link ${linkLabel(link)}`}
                      disabled={busy}
                      onClick={() => {
                        setEdit({
                          original: link.url,
                          url: link.url,
                          label: link.label,
                          category: link.category,
                          newCategory: "",
                        });
                        setError("");
                      }}
                    >
                      <Icon name="pencil" />
                    </button>
                    <button
                      title="Remove from task"
                      aria-label={`Remove link ${linkLabel(link)}`}
                      disabled={busy}
                      onClick={() =>
                        void save(
                          {
                            type: "updatePlanItem",
                            id: item.id,
                            patch: {
                              hiddenLinks: [
                                ...new Set([...item.hiddenLinks, link.url]),
                              ],
                            },
                          },
                          "Link removed from task",
                        )
                      }
                    >
                      <Icon name="x" />
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </div>
      ))}
      {!rows.length && !edit && <small>No tracked links yet.</small>}
      {edit && (
        <form
          className="task-context-edit"
          aria-label="Edit task link"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !busy) setEdit(null);
          }}
        >
          <label>
            URL
            <input
              autoFocus
              required
              maxLength={2000}
              value={edit.url}
              onChange={(e) => setEdit({ ...edit, url: e.target.value })}
            />
          </label>
          <label>
            Label (optional)
            <input
              maxLength={500}
              value={edit.label}
              onChange={(e) => setEdit({ ...edit, label: e.target.value })}
            />
          </label>
          <label>
            Category
            <select
              aria-label="Category"
              value={edit.category}
              onChange={(e) => setEdit({ ...edit, category: e.target.value })}
            >
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
              <option value="new">New category…</option>
            </select>
          </label>
          {edit.category === "new" && (
            <label>
              New category name
              <input
                required
                maxLength={100}
                value={edit.newCategory}
                onChange={(e) =>
                  setEdit({ ...edit, newCategory: e.target.value })
                }
              />
            </label>
          )}
          <div className="plan-actions">
            <button disabled={busy}>Save link</button>
            <button type="button" disabled={busy} onClick={() => setEdit(null)}>
              Cancel
            </button>
          </div>
          {edit.original && (
            <details>
              <summary>Source details</summary>
              <small>
                {rows.find((l) => l.url === edit.original)?.saved
                  ? "Saved on this task"
                  : "Detected from linked chats"}
              </small>
              {rows
                .find((l) => l.url === edit.original)
                ?.sources.map((id) => (
                  <small key={id}>
                    {displayName(chats.find((c) => c.id === id)!)}
                  </small>
                ))}
            </details>
          )}
        </form>
      )}
      {!!item.hiddenLinks.length && (
        <details className="removed-links">
          <summary>Removed links</summary>
          {item.hiddenLinks.map((url) => (
            <div className="task-context-row" key={url}>
              <small>{url}</small>
              <button
                disabled={busy}
                onClick={() =>
                  void save(
                    {
                      type: "updatePlanItem",
                      id: item.id,
                      patch: {
                        hiddenLinks: item.hiddenLinks.filter(
                          (hidden) => hidden !== url,
                        ),
                      },
                    },
                    "Link restored",
                  )
                }
              >
                Restore
              </button>
            </div>
          ))}
        </details>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
export function LatestRound({
  chat,
  fullHistory,
}: {
  chat: Chat;
  fullHistory: () => void;
}) {
  const round = chat.latestRound,
    waiting = chat.state === "waiting",
    kind = waiting ? round?.requestKind : null;
  return (
    <div
      className="latest-round"
      aria-label={`Latest round ${displayName(chat)}`}
    >
      <div className="section-heading">
        <strong>
          {waiting
            ? kind === "approval"
              ? "Approval needed"
              : kind === "question"
                ? "Question"
                : "Needs input"
            : "Latest round"}
        </strong>
        <small>
          {providerLabel(chat.provider)} · Last observation{" "}
          {age(round?.observedAt || chat.lastEventAt)}
        </small>
      </div>
      {waiting && (
        <section aria-label="Input request">
          <h3>
            {kind === "approval"
              ? "Approval request"
              : kind === "question"
                ? "Question for you"
                : "Input needed"}
          </h3>
          {round?.request ? (
            <MarkdownPreview text={round.request} />
          ) : (
            <p className="muted">
              The provider reported that input is needed, but did not include
              the request. Check the original chat.
            </p>
          )}
          <small>Respond in {providerLabel(chat.provider)}.</small>
        </section>
      )}
      {round?.prompt && (
        <section>
          <h3>Latest prompt</h3>
          <MarkdownPreview text={round.prompt} />
        </section>
      )}
      {round?.response && (
        <section>
          <h3>Latest response</h3>
          <MarkdownPreview text={round.response} />
        </section>
      )}
      {!round?.prompt && !round?.response && (
        <p className="muted">
          {chat.preview || "No prompt or response observed yet."}
          {chat.preview && " (Earlier preview; full round was not captured.)"}
        </p>
      )}
      {round?.truncated && (
        <small>
          Long content was capped at 30,000 characters per field. Check the
          original chat for the rest.
        </small>
      )}
      {!!(
        chat.subagents.length ||
        chat.backgroundTasks.length ||
        chat.scheduledChecks.length
      ) && (
        <details>
          <summary>Background observations</summary>
          <Status chat={chat} />
          {chat.subagents.map((agent) => (
            <p key={agent.id}>
              {agent.type || "Subagent"} · {agent.state} · Last observation{" "}
              {age(agent.lastEventAt)}
            </p>
          ))}
          {chat.backgroundTasks.map((task) => (
            <p key={task.id}>
              {task.description || task.type} · {task.status} · Last observation{" "}
              {age(task.lastEventAt)}
            </p>
          ))}
          {chat.scheduledChecks.map((check) => (
            <p key={check.id}>
              {check.schedule} · {check.prompt} · Last observation{" "}
              {age(check.lastEventAt)}
            </p>
          ))}
        </details>
      )}
      <button className="quiet" onClick={fullHistory}>
        View chat history
      </button>
    </div>
  );
}
