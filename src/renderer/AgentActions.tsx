import React, { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../shared/types";
import type { AgentRequest, AgentResponse } from "../shared/interactions";
import { age, message, providerLabel } from "./components";

const api = window.deck;
function Identity({ request }: { request: AgentRequest }) {
  const remaining = Math.max(1, Math.ceil((Date.parse(request.expiresAt) - Date.now()) / 60_000));
  return <div className="request-identity"><strong>{providerLabel(request.provider)} · {request.projectName || request.sourceName}</strong>
    <small>{request.chatName || request.sessionId} · Waiting · {age(request.createdAt)}</small>
    <small>Returns to agent in {remaining}m</small></div>;
}
function Permission({ request, close, busy, error, retry, respond }: {
  request: AgentRequest; close(): void; busy: boolean; error?: string; retry(): void; respond(response: AgentResponse): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dismiss = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const open = () => {
      if (document.querySelector("dialog[open]")) { timer = setTimeout(open,250); return; }
      dialog.current?.showModal();
      dismiss.current?.focus(); // Never default keyboard focus to an approval.
    };
    open();
    return () => clearTimeout(timer);
  }, []);
  const input = JSON.parse(request.input) as Record<string,unknown>;
  const command = typeof input.command === "string" ? input.command : request.input;
  return <dialog ref={dialog} className="permission-spotlight" aria-label="Permission request" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <div className="request-heading"><Identity request={request} /><button ref={dismiss} autoFocus disabled={busy} onClick={close}>Keep waiting</button></div>
    <h2>Allow {request.toolName === "Bash" ? "this command" : request.toolName}?</h2>
    {request.description && <p>{request.description}</p>}
    {request.cwd && <p className="request-path">In <code>{request.cwd}</code></p>}
    <pre className="request-input">{command}</pre>
    {command !== request.input && <details><summary>Full request</summary><pre className="request-input">{request.input}</pre></details>}
    <div className="permission-buttons">
      <button className="primary" disabled={busy} onClick={() => respond({ id: request.id, kind: "permission", decision: "allow" })}>{busy ? "Sending…" : "Allow once"}</button>
      <button disabled={busy} onClick={() => respond({ id: request.id, kind: "permission", decision: "deny" })}>Deny</button>
    </div>
    <small>Applies to this request only. Returning a decision does not confirm the tool ran.</small>
    {error && <div className="request-error" role="alert">{error} <button disabled={busy} onClick={retry}>Retry</button></div>}
  </dialog>;
}

function Question({ request, busy, error, retry, respond }: {
  request: AgentRequest; busy: boolean; error?: string; retry(): void; respond(response: AgentResponse): void;
}) {
  const [answers,setAnswers] = useState<(string | string[])[]>(request.questions.map(q => q.multiSelect ? [] : ""));
  const [custom,setCustom] = useState<Record<number,string>>({});
  const single = request.questions.length === 1 && !request.questions[0].multiSelect;
  const change = (index: number, value: string | string[]) => setAnswers(old => old.map((a,i) => i === index ? value : a));
  const values = answers.map((answer,i) => custom[i]?.trim() || answer);
  const valid = values.every(value => Array.isArray(value) ? value.length > 0 : !!value.trim());
  return <section className="question-request" aria-label="Agent question">
    <Identity request={request} />
    <form onSubmit={event => { event.preventDefault(); if (valid && !busy) respond({ id: request.id, kind: "question", answers: values }); }}>
      {request.questions.map((question,index) => <fieldset key={question.question} disabled={busy}>
        <legend>{question.question}</legend>
        <div className="question-choices">{question.options.map(option => single ?
          <button key={option.label} type="button" className={answers[0] === option.label ? "selected" : ""} disabled={busy} onClick={() => { setCustom({}); change(0,option.label); respond({ id: request.id, kind: "question", answers: [option.label] }); }}>
            <span>{option.label}<small>{option.description}</small></span><span aria-hidden="true">→</span>
          </button> : <label key={option.label} className="question-option"><input type={question.multiSelect ? "checkbox" : "radio"} name={`question-${request.id}-${index}`} checked={Array.isArray(answers[index]) ? answers[index].includes(option.label) : answers[index] === option.label}
            onChange={event => { setCustom(old => ({ ...old, [index]: "" })); change(index, question.multiSelect ? event.target.checked ? [...answers[index] as string[],option.label] : (answers[index] as string[]).filter(label => label !== option.label) : option.label); }} />
            <span>{option.label}<small>{option.description}</small></span></label>)}</div>
        <label>Your own answer<input maxLength={4000} value={custom[index] ?? ""} onChange={event => setCustom(old => ({ ...old, [index]: event.target.value }))} /></label>
      </fieldset>)}
      <button className="primary" disabled={busy || !valid}>{busy ? "Sending…" : "Send answer"}</button>
      {single && <small className="question-hint">Choosing an option sends your answer.</small>}
    </form>
    {error && <div className="request-error" role="alert">{error} <button disabled={busy} onClick={() => valid ? respond({ id:request.id,kind:"question",answers:values }) : retry()}>Retry</button></div>}
  </section>;
}

export default function AgentActions({ snapshot, update, children }: { snapshot: Snapshot; update(snapshot: Snapshot): void; children: React.ReactNode }) {
  const requests = snapshot.requests;
  const permissions = requests.filter(r => r.kind === "permission");
  const questions = requests.filter(r => r.kind === "question");
  const [spotlight,setSpotlight] = useState("");
  const [selected,setSelected] = useState("");
  const [busy,setBusy] = useState<Record<string,boolean>>({});
  const [errors,setErrors] = useState<Record<string,string>>({});
  const [feedback,setFeedback] = useState("");
  const known = useRef(new Set<string>());
  const lastResponse = useRef(new Map<string,AgentResponse>());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    const arrived = permissions.filter(r => !known.current.has(r.id));
    known.current = new Set(permissions.map(r => r.id));
    if (spotlight && !permissions.some(r => r.id === spotlight)) setSpotlight("");
    else if (arrived.length && !spotlight) setSpotlight(arrived[0].id);
  }, [permissions,spotlight]);
  useEffect(() => {
    const ids = new Set(requests.map(r => r.id));
    for (const id of lastResponse.current.keys()) if (!ids.has(id)) lastResponse.current.delete(id);
    setErrors(old => Object.fromEntries(Object.entries(old).filter(([id]) => ids.has(id))));
    setBusy(old => Object.fromEntries(Object.entries(old).filter(([id]) => ids.has(id))));
  }, [requests]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const active = permissions.find(r => r.id === spotlight);
  const question = questions.find(r => r.id === selected) ?? questions[0];
  const flash = (text: string) => { setFeedback(text); clearTimeout(timer.current); timer.current = setTimeout(() => setFeedback(""),2600); };
  const respond = async (response: AgentResponse) => {
    if (inFlight.current.has(response.id)) return;
    inFlight.current.add(response.id); lastResponse.current.set(response.id,response);
    setBusy(old => ({ ...old,[response.id]: true })); setErrors(old => ({ ...old,[response.id]: "" }));
    try {
      update(await api.respond(response));
      if (response.kind === "permission") setSpotlight("");
      flash(response.kind === "question" ? "Answer sent" : response.decision === "allow" ? "Allowed" : response.decision === "deny" ? "Denied" : "Returned to agent");
    } catch (e) {
      const text = message(e);
      setErrors(old => ({ ...old,[response.id]: text }));
      try { const next = await api.load(); update(next); if (!next.requests.some(r => r.id === response.id)) flash("Request is no longer waiting. Continue in the agent."); } catch { /* Retain the draft and allow retry. */ }
    } finally { inFlight.current.delete(response.id); setBusy(old => ({ ...old,[response.id]: false })); }
  };
  const retry = (id: string) => { const response = lastResponse.current.get(id); if (response) void respond(response); };
  return <>
    {(requests.length > 0 || feedback) && <div className={`agent-alert ${requests.length ? "" : "resolved"}`}>
      <div><strong>{permissions.length ? `${permissions.length} permission request${permissions.length === 1 ? "" : "s"} waiting` : questions.length ? `${questions.length} question${questions.length === 1 ? "" : "s"} waiting` : "No requests waiting"}</strong>
        {permissions[0] && <small>{providerLabel(permissions[0].provider)} · {permissions[0].chatName || permissions[0].sourceName}{questions.length ? ` · ${questions.length} question${questions.length === 1 ? "" : "s"} in the dock` : ""}</small>}</div>
      <span role="status" aria-live="polite">{feedback}</span>
      {permissions.length > 0 && <button className="primary" onClick={() => setSpotlight(permissions[0].id)}>Review permission</button>}
    </div>}
    <div className={`action-workspace ${questions.length ? "with-questions" : ""}`}><div className="action-content">{children}</div>
      {questions.length > 0 && <aside className="question-dock" aria-label="Questions">
        <div className="section-heading"><h2>Questions</h2><small>{questions.length} waiting</small></div>
        {questions.length > 1 && <nav aria-label="Waiting questions">{questions.map(r => <button key={r.id} className={r.id === question?.id ? "selected" : ""} onClick={() => setSelected(r.id)}>{providerLabel(r.provider)} · {r.chatName || r.sessionId}</button>)}</nav>}
        {questions.map(r => <div key={r.id} hidden={r.id !== question?.id}><Question request={r} busy={!!busy[r.id]} error={errors[r.id]} retry={() => retry(r.id)} respond={response => void respond(response)} /></div>)}
      </aside>}
    </div>
    {active && <Permission key={active.id} request={active} close={() => setSpotlight("")} busy={!!busy[active.id]} error={errors[active.id]} retry={() => retry(active.id)} respond={response => void respond(response)} />}
  </>;
}
