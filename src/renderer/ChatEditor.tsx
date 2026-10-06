import { useCallback, useEffect, useLayoutEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import type { Chat, Activity, Project, Command, State, Settings } from "../shared/types";
import { states } from "../shared/types";
import { parseTicket, resolveTicketUrl } from "../shared/tickets";
import { providerLabel, displayName, automaticName, displayPreview, message, age, Status } from "./components";
import MarkdownPreview from "./MarkdownPreview";
import Icon from "./Icon";
const api = window.deck;
type Editable = Partial<Pick<Chat, "name" | "notes" | "jiraKey" | "jiraUrl" | "projectId" | "state" | "lifecycle">>;
export interface EditorHandle { flush: () => Promise<boolean>; }
const ChatEditor = forwardRef<EditorHandle, {
  chat: Chat; projects: Project[]; activities: Activity[]; settings: Settings;
  mutate: (c: Command) => Promise<void>; archive: () => void; renameProject: (id: string) => void; createProject: () => void; report: (s: string) => void; configureJira: () => void;
}>(function ChatEditor({ chat, projects, activities, settings, mutate, archive, renameProject, createProject, report, configureJira }, ref) {
  const [draft, setDraft] = useState(chat);
  const [saving, setSaving] = useState("Saved");
  const [error, setError] = useState("");
  const [notesEditing, setNotesEditing] = useState(false);
  const [ticketEditing, setTicketEditing] = useState(false);
  const [ticketInput, setTicketInput] = useState(chat.jiraUrl || chat.jiraKey);
  const [ticketError, setTicketError] = useState("");
  const [ticketSaving, setTicketSaving] = useState(false);
  const pendingTicket = useRef<string | null>(null);
  const notes = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<Editable>({});
  const flight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const flush = useCallback(async (includeTicket = true): Promise<boolean> => {
    clearTimeout(timer.current);
    // Navigation and blur drain the same queue; no write can overtake another.
    while (true) {
      if (flight.current) { if (!(await flight.current)) return false; continue; }
      if (includeTicket && pendingTicket.current !== null) {
        try {
          const patch = parseTicket(pendingTicket.current);
          pending.current = { ...pending.current, ...patch };
          setDraft(d => ({ ...d, ...patch }));
          pendingTicket.current = null;
          setTicketError("");
        } catch {
          setTicketError("Enter a ticket number such as DECK-42, or a complete http:// or https:// URL without credentials.");
          setSaving("Not saved");
          return false;
        }
      }
      if (!Object.keys(pending.current).length) return true;
      const patch = pending.current;
      pending.current = {};
      setSaving("Saving…"); setError("");
      const operation: Promise<boolean> = mutate({ type: "updateChat", id: chat.id, patch })
        .then(() => { if (mounted.current) setSaving(Object.keys(pending.current).length || pendingTicket.current !== null ? "Unsaved changes" : "Saved"); return true; })
        .catch(e => { pending.current = { ...patch, ...pending.current }; if (mounted.current) { setError(message(e)); setSaving("Not saved"); } return false; })
        .finally(() => { if (flight.current === operation) flight.current = null; });
      flight.current = operation;
      if (!(await operation)) return false;
    }
  }, [chat.id, mutate]);
  useImperativeHandle(ref, () => ({ flush }), [flush]);
  useEffect(() => {
    mounted.current = true;
    const guard = (event: BeforeUnloadEvent) => {
      if (flight.current || Object.keys(pending.current).length || pendingTicket.current !== null) {
        event.preventDefault(); event.returnValue = ""; void flush();
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => { mounted.current = false; clearTimeout(timer.current); window.removeEventListener("beforeunload", guard); };
  }, [flush]);
  useLayoutEffect(() => {
    if (notes.current) { notes.current.style.height = "auto"; notes.current.style.height = `${Math.max(240, notes.current.scrollHeight + 2)}px`; }
  }, [notesEditing, draft.notes]);
  useEffect(() => {
    if (pending.current.projectId === undefined && !flight.current)
      setDraft(d => ({ ...d, projectId: chat.projectId, repoProjectId: chat.repoProjectId }));
  }, [chat.projectId, chat.repoProjectId]);
  const edit = (patch: Editable) => {
    setDraft(d => ({ ...d, ...patch })); pending.current = { ...pending.current, ...patch };
    setSaving("Unsaved changes"); setError(""); clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(false), 450);
  };
  const finishNotes = async () => { if (await flush(false)) setNotesEditing(false); };
  const beginTicket = () => { setTicketInput(draft.jiraUrl || draft.jiraKey); setTicketError(""); setTicketEditing(true); };
  const cancelTicket = () => {
    pendingTicket.current = null;
    delete pending.current.jiraKey; delete pending.current.jiraUrl;
    setDraft(d => ({ ...d, jiraKey: chat.jiraKey, jiraUrl: chat.jiraUrl }));
    setTicketEditing(false); setTicketError("");
    if (!error) setSaving(Object.keys(pending.current).length ? "Unsaved changes" : "Saved");
  };
  const saveTicket = async () => {
    pendingTicket.current = ticketInput;
    setTicketSaving(true);
    try { if (await flush()) setTicketEditing(false); } finally { setTicketSaving(false); }
  };
  let ticketDestination = "";
  try { ticketDestination = resolveTicketUrl(draft, settings); } catch { /* Settings action supplies the missing base URL. */ }
  return <section className="details" aria-label="Chat details">
    <div className="eyebrow">{projects.filter(p => p.id === draft.projectId || p.id === chat.repoProjectId).map(p => p.name).join(" · ") || "No project"} / {providerLabel(chat.provider)}{chat.archived && " · Archived"}</div>
    <div className="detail-title">
      <h2>{displayName({ ...chat, name: draft.name })}</h2>
      {ticketEditing ? <form className={`ticket-inline ${ticketInput.includes("://") ? "has-url" : ""}`} aria-label="Edit ticket" onSubmit={e => { e.preventDefault(); void saveTicket(); }}>
        <div className="ticket-input-row">
          <input aria-label="Ticket number or full URL" value={ticketInput} maxLength={2000} placeholder="Ticket or URL" autoFocus autoComplete="off" spellCheck={false} disabled={ticketSaving}
            onFocus={e => e.currentTarget.select()}
            onChange={e => { setTicketInput(e.target.value); pendingTicket.current = e.target.value; setTicketError(""); setSaving("Unsaved changes"); }}
            onKeyDown={e => { if (e.key === "Escape" && !ticketSaving) { e.preventDefault(); cancelTicket(); } }} />
          <button className="ticket-confirm" type="submit" aria-label="Save ticket" title="Save ticket · Enter" disabled={ticketSaving}><Icon name="check" /></button>
          <button className="ticket-cancel" type="button" aria-label="Cancel ticket edit" title="Cancel · Escape" onClick={cancelTicket} disabled={ticketSaving}><Icon name="x" /></button>
        </div>
        {ticketError && <p className="ticket-error" role="alert">{ticketError}</p>}
      </form> : draft.jiraKey || draft.jiraUrl ? <span className="ticket-group">
        <button className="ticket-pill" aria-label={`Open Jira ticket ${draft.jiraKey || "link"}`} title={ticketDestination || "Set the Jira base URL in Settings"} onClick={() => {
          if (!ticketDestination) { configureJira(); return; }
          void flush().then(async ok => { if (ok) await api.openTicket(chat.id); }).catch(e => report(message(e)));
        }}>{draft.jiraKey || "Jira ticket"}</button>
        <button className="ticket-pencil" aria-label="Edit ticket" title="Edit ticket" onClick={beginTicket}><Icon name="pencil" /></button>
      </span> : <button className="add-ticket" onClick={beginTicket}>Add ticket</button>}
    </div>
    <div className="activity-heading"><Status chat={chat} /><span title={chat.lastEventAt ?? chat.updatedAt}>{chat.provider === "manual" ? "Manually reported" : `Last event ${age(chat.lastEventAt)}`}</span></div>
    <section className="organization" aria-label="Chat organization">
      <div className="organization-heading"><h3>Chat organization</h3><button onClick={archive}>{chat.archived ? "Restore chat" : "Archive chat"}</button></div>
      <label>Chat name<input value={draft.name} maxLength={200} placeholder={automaticName(chat)} onChange={e => edit({ name: e.target.value })} onBlur={() => void flush()} /></label>
      {chat.repoProjectId && <div className="repo-project"><small>Repository project · permanent</small><strong>{projects.find(p => p.id === chat.repoProjectId)?.name}</strong></div>}
      <label>{chat.repoProjectId ? "Additional project" : "Project"}<select value={draft.projectId === chat.repoProjectId ? "" : draft.projectId ?? ""} onChange={e => { if (e.target.value === "add-project") createProject(); else edit({ projectId: e.target.value || null }); }} onBlur={() => void flush()}><option value="">{chat.repoProjectId ? "None" : "No project"}</option>{projects.filter(p => p.id !== chat.repoProjectId && (!chat.repoProjectId || p.kind === "custom" || p.id === draft.projectId)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}<option value="add-project">Add a new project</option></select></label>
      <div className="project-actions"><small>{chat.repoProjectId ? "Adding a project keeps this chat in its repository project." : "Group chats by the work they belong to."}</small>{projects.some(p => p.id === draft.projectId && p.kind === "custom") && <button title="Rename this project for all its chats" onClick={() => renameProject(draft.projectId!)}><Icon name="pencil" /> Rename project</button>}</div>
      {chat.provider !== "manual" && <small className="name-hint">Leave the chat name blank to use the first prompt’s title.</small>}
    </section>
    <section className="notes-section" aria-label="Chat notes">
      <div className="notes-heading"><h3>Your notes</h3><button onClick={() => setNotesEditing(true)} aria-label="Edit notes"><Icon name="pencil" /> Edit</button></div>
      {notesEditing ? <div className="notes-editor">
        <textarea ref={notes} aria-label="Notes" autoFocus maxLength={100000} value={draft.notes} placeholder="Write notes in Markdown…" onChange={e => edit({ notes: e.target.value })}
          onBlur={() => void flush(false)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void finishNotes(); } }} />
        <div className="notes-editor-footer"><small>Markdown · Ctrl/Cmd+Enter to finish</small><button onClick={() => void finishNotes()}>Done</button></div>
      </div> : draft.notes ? <div className="rendered-notes" onClick={() => setNotesEditing(true)}><MarkdownPreview text={draft.notes} /></div> : <button className="empty-notes" onClick={() => setNotesEditing(true)}>Add notes in Markdown…</button>}
      <div className="save-row"><span role="status">{saving}</span>{error && <button onClick={() => void flush()}>Retry save</button>}</div>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
    <section className="history" aria-label="Chat activity">
      <h3>Chat activity</h3>
      {chat.preview && <div className="preview"><MarkdownPreview text={displayPreview(chat)} /></div>}
      {activities.length ? <ol>{activities.map(a => <li key={a.id}><span>{a.summary}</span><small title={a.observedAt}>{age(a.observedAt)} · {a.kind}</small></li>)}</ol> : <p className="muted">{chat.provider === "manual" ? "This chat is tracked manually." : "No activity recorded yet."}</p>}
    </section>
    <details className="source-details"><summary>{chat.provider === "manual" ? "Manual status" : "Source identity"}</summary>
      {chat.provider === "manual" && <div className="form-row"><label>Manual state<select value={draft.state} onChange={e => edit({ state: e.target.value as State })}>{states.map(s => <option key={s}>{s}</option>)}</select></label><label>Session<select value={draft.lifecycle} onChange={e => edit({ lifecycle: e.target.value as Chat["lifecycle"] })}><option value="open">Open</option><option value="ended">Ended</option></select></label></div>}
      {chat.externalId && <code>{chat.externalId}</code>}
    </details>
  </section>;
});
export default ChatEditor;
