import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Command, Settings as WorkspaceSettings } from "../shared/types";
import { jiraBaseUrl } from "../shared/validation";
import type { EditorHandle } from "./ChatEditor";
import { message } from "./components";

export default forwardRef<EditorHandle, { settings: WorkspaceSettings; mutate: (command: Command) => Promise<void> }>(function Settings({ settings, mutate }, ref) {
  const [value, setValue] = useState(settings.jiraBaseUrl);
  const [status, setStatus] = useState("Saved");
  const [error, setError] = useState("");
  const draft = useRef(value);
  const saved = useRef(value);
  const flight = useRef<Promise<boolean> | null>(null);
  const flush = useCallback(async (): Promise<boolean> => {
    while (true) {
      if (flight.current) { if (!(await flight.current)) return false; continue; }
      if (draft.current === saved.current) { setStatus("Saved"); setError(""); return true; }
      let next: string;
      try { next = jiraBaseUrl.parse(draft.current.trim()); }
      catch (e) { setError(message(e)); setStatus("Not saved"); return false; }
      const submitted = draft.current;
      setStatus("Saving…"); setError("");
      const operation = mutate({ type: "updateSettings", jiraBaseUrl: next }).then(() => {
        saved.current = next;
        if (draft.current === submitted) { draft.current = next; setValue(next); }
        setStatus(draft.current === saved.current ? "Saved" : "Unsaved changes");
        return true;
      }).catch(e => { setError(message(e)); setStatus("Not saved"); return false; }).finally(() => { flight.current = null; });
      flight.current = operation;
      if (!(await operation)) return false;
    }
  }, [mutate]);
  useImperativeHandle(ref, () => ({ flush }), [flush]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (flight.current || draft.current !== saved.current) { event.preventDefault(); event.returnValue = ""; void flush(); } };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [flush]);
  return <main className="settings-page">
    <div className="page-heading"><span className="eyebrow">Workspace</span><h2>Settings</h2><p className="muted">Ticket links</p></div>
    <form onSubmit={e => { e.preventDefault(); void flush(); }}>
      <h3>Jira</h3>
      <label>Jira base URL<input type="text" inputMode="url" autoComplete="off" maxLength={2000} value={value} placeholder="https://your-team.atlassian.net" onChange={e => { draft.current = e.target.value; setValue(e.target.value); setStatus("Unsaved changes"); setError(""); }} /></label>
      <p className="muted">Include any Jira path prefix, such as https://company.example/jira.</p>
      <div className="settings-save"><button className="primary" type="submit">Save settings</button><span role="status">{status}</span></div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
    <div className="ticket-example"><h3>Ticket number example</h3><p><strong>DECK-42</strong> opens:</p><code>{saved.current ? `${saved.current}/browse/DECK-42` : "Set a Jira base URL to open ticket numbers."}</code><p className="muted">Pasted full ticket URLs keep their own address.</p></div>
  </main>;
});
