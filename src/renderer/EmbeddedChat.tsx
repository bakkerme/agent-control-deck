import { useEffect, useRef, useState } from "react";
import type { EmbeddedChat, EmbeddedCommand, EmbeddedReply, EmbeddedRequest } from "../shared/embedded-chat";
import { message } from "./components";
function Decision({ request, decide }: { request: EmbeddedRequest; decide: (allow: boolean, answers?: Record<string, string>) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false);
  const submit = async (allow: boolean) => { setBusy(true); try { await decide(allow, allow && request.questions ? answers : undefined); } finally { setBusy(false); } };
  return <section className="embedded-request" aria-label={`Request ${request.tool}`}>
    <strong>{request.questions ? "Your answer is needed" : `Allow ${request.tool} once?`}</strong>
    <pre>{request.input}</pre>
    {request.questions?.map(q => <label key={q.question}>{q.question}
      <input aria-label={q.question} value={answers[q.question] ?? ""} maxLength={4000} onChange={e => setAnswers({ ...answers, [q.question]: e.target.value })} />
      <small>{q.options.map(o => `${o.label}${o.description ? `: ${o.description}` : ""}`).join(" · ")}{q.multiSelect ? " (Multiple answers allowed)" : ""}</small>
    </label>)}
    <div className="plan-actions">
      <button disabled={busy} onClick={() => void submit(false)}>Deny</button>
      <button disabled={busy || request.questions?.some(q => !answers[q.question]?.trim())} onClick={() => void submit(true)}>{request.questions ? "Send answers" : "Allow once"}</button>
    </div>
  </section>;
}
export default function EmbeddedConversation({ taskId, chatId }: { taskId?: string; chatId?: string }) {
  const [status, setStatus] = useState<EmbeddedReply | null>(null), [chats, setChats] = useState<EmbeddedChat[]>([]),
    [selected, setSelected] = useState(""), [creating, setCreating] = useState(false), [name, setName] = useState("Claude Agent chat"),
    [cwd, setCwd] = useState(""), [text, setText] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const revision = useRef(0);
  const pendingSend = useRef<{ chatId: string; text: string; sendId: string } | null>(null);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const current = ++revision.current;
      try {
        const result = await window.deck.embedded({ type: "status" });
        if (!alive || current !== revision.current) return;
        setStatus(result);
        if (result.enabled) {
          const list = chatId ? await window.deck.embedded({ type: "read", chatId }) : await window.deck.embedded({ type: "list", taskId: taskId! });
          if (list.chat) list.chats = [list.chat];
          if (!alive || current !== revision.current) return;
          setChats(list.chats ?? []);
          setSelected(previous => list.chats?.some(c => c.chatId === previous) ? previous : list.chats?.[0]?.chatId || "");
        }
      } catch (e) { if (alive) setError(message(e)); }
    };
    const schedule = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void refresh(); }, 80); };
    void refresh();
    const off = window.deck.onChanged(schedule);
    // Re-read durable state after missed notifications or a renderer reload.
    const poll = setInterval(schedule, 2000);
    return () => { alive = false; off(); clearInterval(poll); clearTimeout(timer); };
  }, [taskId, chatId]);
  const call = async (command: EmbeddedCommand) => {
    setError(""); setBusy(true);
    try {
      const result = await window.deck.embedded(command);
      if (result.chat) {
        const chat = result.chat;
        setChats(old => [...old.filter(c => c.chatId !== chat.chatId), chat]);
        // A delayed send/decision acknowledgement belongs to its original chat;
        // it must not undo a selection made while that request was in flight.
        if (command.type === "create") setSelected(chat.chatId);
      }
      return true;
    } catch (e) { setError(message(e)); return false; } finally { setBusy(false); }
  };
  if (!status?.enabled) return null;
  const chat = chats.find(c => c.chatId === selected);
  return <section className="plan-detail-section embedded-conversation" aria-label="Embedded conversation">
    <div className="section-heading"><h3>Conversation <small>Experimental · Claude Agent</small></h3>{taskId && <button disabled={busy} onClick={() => setCreating(!creating)}>New embedded chat</button>}</div>
    {!status.configured && <p className="muted">{status.diagnostic ?? "Configure authentication in the desktop backend environment and restart."}</p>}
    <small>{status.authMode === "openrouter" ? `Authentication: OpenRouter · ${status.model} · DeepSeek integration unverified` : status.authMode === "api-key" ? "Authentication: API key from desktop launch environment · API billing" : "Authentication: existing Claude Code sign-in · inherited API keys are excluded"}. Project settings and skills are disabled for this slice.</small>
    {creating && taskId && <form aria-label="New embedded chat" onSubmit={e => { e.preventDefault(); void call({ type: "create", taskId, name, cwd }).then(ok => { if (ok) setCreating(false); }); }}>
      <label>Chat name<input required maxLength={200} value={name} onChange={e => setName(e.target.value)} /></label>
      <label>Working directory<input required placeholder="Absolute local folder path" maxLength={4000} value={cwd} onChange={e => setCwd(e.target.value)} /></label>
      <small>Tools run in this local folder. Each tool call asks for approval. Project settings, skills, hooks and MCP are not loaded. Authentication follows the mode shown above.</small>
      <button disabled={busy}>Create embedded chat</button>
    </form>}
    {!!chats.length && <label>Embedded chat<select aria-label="Embedded chat" value={selected} onChange={e => { setSelected(e.target.value); setError(""); setText(""); }}>{chats.map(c => <option value={c.chatId} key={c.chatId}>{c.name} · {c.state}</option>)}</select></label>}
    {chat && <>
      <small>{chat.cwd} · {chat.state}{chat.provider ? ` · ${chat.provider}${chat.model ? ` / ${chat.model}` : ""}` : ""}{chat.sessionId ? " · Session saved for resume" : " · New session"}</small>
      <div className="embedded-transcript" role="log" aria-label="Conversation messages" aria-live="polite">
        {!chat.events.length && <p className="muted">Start a conversation for this task.</p>}
        {chat.events.map(event => <article key={event.id} className={`embedded-event embedded-${event.kind}`}><small>{event.kind} · {new Date(event.at).toLocaleTimeString()}</small>{event.kind === "tool" ? <details><summary>{event.text.split("\n")[0]}</summary><pre>{event.text}</pre></details> : <p>{event.text}</p>}</article>)}
      </div>
      {chat.requests.map(request => <Decision key={request.id} request={request} decide={async (allow, answers) => { await call({ type: "decide", chatId: chat.chatId, requestId: request.id, allow, answers }); }} />)}
      <form onSubmit={e => { e.preventDefault(); const pending = pendingSend.current;
        const sendId = pending?.chatId === chat.chatId && pending.text === text ? pending.sendId : crypto.randomUUID();
        pendingSend.current = { chatId: chat.chatId, text, sendId };
        void call({ type: "send", chatId: chat.chatId, text, sendId }).then(ok => { if (ok) { pendingSend.current = null; setText(""); } }); }}>
        <label>Message<textarea aria-label="Message to Claude Agent" value={text} maxLength={30000} onChange={e => setText(e.target.value)} disabled={busy || chat.active} /></label>
        <div className="plan-actions"><button disabled={busy || chat.active || !status.configured || !text.trim()}>Send message</button>{chat.active && <button type="button" disabled={busy} onClick={() => void call({ type: "cancel", chatId: chat.chatId })}>Cancel turn</button>}</div>
      </form>
      <small>Latest 500 entries shown; each entry is capped at 30,000 characters. Cancelling cannot undo tool side effects. Tools may survive app or host failures; verify uncertain effects before sending again.</small>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
