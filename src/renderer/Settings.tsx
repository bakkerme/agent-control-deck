import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Command, Settings as WorkspaceSettings, LinkRule } from "../shared/types";
import { jiraBaseUrl, linkRulesSchema } from "../shared/validation";
import type { EditorHandle } from "./ChatEditor";
import { message } from "./components";
import { z } from "zod";

export default forwardRef<EditorHandle, { settings: WorkspaceSettings; mutate: (command: Command) => Promise<void> }>(function Settings({ settings, mutate }, ref) {
  const [value, setValue] = useState(settings);
  const [status, setStatus] = useState("Saved");
  const [error, setError] = useState("");
  const draft = useRef(value);
  const saved = useRef(value);
  const flight = useRef<Promise<boolean> | null>(null);
  const flush = useCallback(async (): Promise<boolean> => {
    while (true) {
      if (flight.current) { if (!(await flight.current)) return false; continue; }
      if (JSON.stringify(draft.current) === JSON.stringify(saved.current)) { setStatus("Saved"); setError(""); return true; }
      let next: WorkspaceSettings;
      try { next = { jiraBaseUrl: jiraBaseUrl.parse(draft.current.jiraBaseUrl.trim()), linkRules: linkRulesSchema.parse(draft.current.linkRules) }; }
      catch (e) {
        setError(e instanceof z.ZodError ? e.issues.map(issue => `${typeof issue.path[0] === "number" ? `Rule ${issue.path[0] + 1}: ` : ""}${issue.message}`).join("; ") : message(e));
        setStatus("Not saved"); return false;
      }
      const submitted = draft.current;
      setStatus("Saving…"); setError("");
      const operation = mutate({ type: "updateSettings", ...next }).then(() => {
        saved.current = next;
        if (draft.current === submitted) { draft.current = next; setValue(next); }
        setStatus(JSON.stringify(draft.current) === JSON.stringify(saved.current) ? "Saved" : "Unsaved changes");
        return true;
      }).catch(e => { setError(message(e)); setStatus("Not saved"); return false; }).finally(() => { flight.current = null; });
      flight.current = operation;
      if (!(await operation)) return false;
    }
  }, [mutate]);
  useImperativeHandle(ref, () => ({ flush }), [flush]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (flight.current || JSON.stringify(draft.current) !== JSON.stringify(saved.current)) { event.preventDefault(); event.returnValue = ""; void flush(); } };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [flush]);
  const edit = (next: WorkspaceSettings) => { draft.current = next; setValue(next); setStatus("Unsaved changes"); setError(""); };
  const editRule = (index: number, patch: Partial<LinkRule>) => edit({ ...draft.current, linkRules: draft.current.linkRules.map((rule, i) => i === index ? { ...rule, ...patch } : rule) });
  return <main className="settings-page">
    <div className="page-heading"><span className="eyebrow">Workspace</span><h2>Settings</h2><p className="muted">Links and ticket shortcuts</p></div>
    <form onSubmit={e => { e.preventDefault(); void flush(); }}>
      <section className="link-rule-settings" aria-label="Link categories">
        <div className="link-rules-heading"><h3>Link categories</h3><button type="button" disabled={value.linkRules.length >= 50} onClick={() => edit({ ...draft.current, linkRules: [...draft.current.linkRules, { domain: "", pathPrefix: "", category: "" }] })}>Add category rule</button></div>
        <p className="muted">Collect web links from assistant responses. Match an exact domain, optionally narrow it by path, and choose any category name. The most specific path wins; unmatched links appear under Other. Changes also apply to saved links.</p>
        {value.linkRules.map((rule, index) => <div className="link-rule" key={index}>
          <label>Domain<input aria-label={`Rule ${index + 1} domain`} value={rule.domain} maxLength={253} autoComplete="off" spellCheck={false} placeholder="team.example.com" onChange={e => editRule(index, { domain: e.target.value })} /></label>
          <label>Path prefix (optional)<input aria-label={`Rule ${index + 1} path prefix`} value={rule.pathPrefix} maxLength={1000} autoComplete="off" spellCheck={false} placeholder="/wiki" onChange={e => editRule(index, { pathPrefix: e.target.value })} /></label>
          <label>Category<input aria-label={`Rule ${index + 1} category`} value={rule.category} maxLength={100} placeholder="Documents" onChange={e => editRule(index, { category: e.target.value })} /></label>
          <button className="remove-link-rule" type="button" aria-label={`Remove rule ${index + 1}`} onClick={() => edit({ ...draft.current, linkRules: draft.current.linkRules.filter((_, i) => i !== index) })}>Remove</button>
        </div>)}
        {!value.linkRules.length && <p className="muted">No rules yet. Detected links are still collected under Other.</p>}
      </section>
      <h3>Jira</h3>
      <label>Jira base URL<input type="text" inputMode="url" autoComplete="off" maxLength={2000} value={value.jiraBaseUrl} placeholder="https://your-team.atlassian.net" onChange={e => edit({ ...draft.current, jiraBaseUrl: e.target.value })} /></label>
      <p className="muted">Include any Jira path prefix, such as https://company.example/jira.</p>
      <div className="settings-save"><button className="primary" type="submit">Save settings</button><span role="status">{status}</span></div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
    <div className="ticket-example"><h3>Ticket number example</h3><p><strong>DECK-42</strong> opens:</p><code>{saved.current.jiraBaseUrl ? `${saved.current.jiraBaseUrl}/browse/DECK-42` : "Set a Jira base URL to open ticket numbers."}</code><p className="muted">Pasted full ticket URLs keep their own address.</p></div>
  </main>;
});
