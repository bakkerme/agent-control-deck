import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import type { Chat, Activity, Project, Command, State } from "../shared/types";
import { states } from "../shared/types";
import { providerLabel, displayName, automaticName, displayPreview, message, age, Status } from "./components";
import MarkdownPreview from "./MarkdownPreview";
const api = window.deck;

type Editable = Partial<
  Pick<
    Chat,
    | "name"
    | "notes"
    | "jiraKey"
    | "jiraUrl"
    | "projectId"
    | "state"
    | "lifecycle"
  >
>;
export interface EditorHandle {
  flush: () => Promise<boolean>;
}
const ChatEditor = forwardRef<
  EditorHandle,
  {
    chat: Chat;
    projects: Project[];
    activities: Activity[];
    mutate: (c: Command) => Promise<void>;
    archive: () => void;
    report: (s: string) => void;
  }
>(function ChatEditor(
  { chat, projects, activities, mutate, archive, report },
  ref,
) {
  const [draft, setDraft] = useState(chat);
  const [saving, setSaving] = useState("Saved");
  const [error, setError] = useState("");
  const pending = useRef<Editable>({});
  const flight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const flush = useCallback(async (): Promise<boolean> => {
    clearTimeout(timer.current);
    // Every caller drains the same queue. A navigation cannot overtake a write
    // started by an earlier autosave or blur handler.
    while (true) {
      if (flight.current) {
        if (!(await flight.current)) return false;
        continue;
      }
      if (!Object.keys(pending.current).length) return true;
      const patch = pending.current;
      pending.current = {};
      setSaving("Saving…");
      setError("");
      const operation: Promise<boolean> = mutate({
        type: "updateChat",
        id: chat.id,
        patch,
      })
        .then(() => {
          if (mounted.current)
            setSaving(
              Object.keys(pending.current).length ? "Unsaved changes" : "Saved",
            );
          return true;
        })
        .catch((e) => {
          pending.current = { ...patch, ...pending.current };
          if (mounted.current) {
            setError(message(e));
            setSaving("Not saved");
          }
          return false;
        })
        .finally(() => {
          if (flight.current === operation) flight.current = null;
        });
      flight.current = operation;
      if (!(await operation)) return false;
    }
  }, [chat.id, mutate]);
  useImperativeHandle(ref, () => ({ flush }), [flush]);
  useEffect(() => {
    mounted.current = true;
    const guard = (event: BeforeUnloadEvent) => {
      if (flight.current || Object.keys(pending.current).length) {
        event.preventDefault();
        event.returnValue = "";
        void flush();
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      window.removeEventListener("beforeunload", guard);
    };
  }, [flush]);
  const edit = (patch: Editable) => {
    setDraft((d) => ({ ...d, ...patch }));
    pending.current = { ...pending.current, ...patch };
    setSaving("Unsaved changes");
    setError("");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 450);
  };
  return (
    <section className="details" aria-label="Chat details">
      <div className="section-heading">
        <div>
          <span className="eyebrow">
            {providerLabel(chat.provider)} {chat.archived && " · Archived"}
          </span>
          <h2>{displayName(chat)}</h2>
        </div>
        <button onClick={archive}>
          {chat.archived ? "Restore chat" : "Archive chat"}
        </button>
      </div>
      <div className="activity-heading">
        <Status chat={chat} />
        <span title={chat.lastEventAt ?? chat.updatedAt}>
          {chat.provider === "manual"
            ? "Manually reported"
            : `Last reported ${age(chat.lastEventAt)}`}
        </span>
      </div>
      <label>
        Chat name
        <input
          value={draft.name}
          maxLength={200}
          placeholder={automaticName(chat)}
          onChange={(e) => edit({ name: e.target.value })}
          onBlur={() => void flush()}
        />
      </label>
      {chat.provider !== "manual" && (
        <small>
          Names apply only here. Leave blank to use a title derived from the first prompt.
        </small>
      )}
      <label>
        Project
        <select
          value={draft.projectId ?? ""}
          onChange={(e) => edit({ projectId: e.target.value || null })}
        >
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {chat.provider === "manual" && (
        <div className="form-row">
          <label>
            Manual state
            <select
              value={draft.state}
              onChange={(e) => edit({ state: e.target.value as State })}
            >
              {states.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Session
            <select
              value={draft.lifecycle}
              onChange={(e) =>
                edit({ lifecycle: e.target.value as Chat["lifecycle"] })
              }
            >
              <option value="open">Open</option>
              <option value="ended">Ended</option>
            </select>
          </label>
        </div>
      )}
      <label>
        Notes
        <textarea
          aria-label="Notes"
          rows={8}
          maxLength={100000}
          value={draft.notes}
          placeholder="Context, decisions, and what to do next…"
          onChange={(e) => edit({ notes: e.target.value })}
          onBlur={() => void flush()}
        />
      </label>
      <div className="form-row">
        <label>
          Jira key
          <input
            value={draft.jiraKey}
            maxLength={100}
            placeholder="PROJ-123"
            onChange={(e) => edit({ jiraKey: e.target.value })}
            onBlur={() => void flush()}
          />
        </label>
        <label>
          Jira URL
          <input
            value={draft.jiraUrl}
            maxLength={2000}
            placeholder="https://…/browse/PROJ-123"
            onChange={(e) => edit({ jiraUrl: e.target.value })}
            onBlur={() => void flush()}
          />
        </label>
      </div>
      <div className="save-row">
        <span role="status">{saving}</span>
        {chat.jiraUrl && (
          <button
            onClick={() =>
              void flush()
                .then(async (ok) => {
                  if (ok) await api.openTicket(chat.id);
                })
                .catch((e) => report(message(e)))
            }
          >
            Open Jira ticket
          </button>
        )}
        {error && <button onClick={() => void flush()}>Retry save</button>}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {chat.preview && (
        <div className="preview">
          <h3>Latest preview</h3>
          <MarkdownPreview text={displayPreview(chat)} />
        </div>
      )}
      <div className="history">
        <h3>Recent activity</h3>
        {activities.length ? (
          <ol>
            {activities.map((a) => (
              <li key={a.id}>
                <span>{a.summary}</span>
                <small title={a.observedAt}>
                  {age(a.observedAt)} · {a.kind}
                </small>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">
            {chat.provider === "manual"
              ? "This chat is tracked manually."
              : "No activity recorded yet."}
          </p>
        )}
      </div>
      {chat.externalId && (
        <details>
          <summary>Source identity</summary>
          <code>{chat.externalId}</code>
        </details>
      )}
    </section>
  );
});


export default ChatEditor;
