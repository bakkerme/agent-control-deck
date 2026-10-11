import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { saveMatchingSchema, type MatchingConfig, type MatchingStatus } from "../shared/matching-settings";
import type { EditorHandle } from "./ChatEditor";
import { message } from "./components";

export default forwardRef<EditorHandle, { matching: MatchingStatus }>(function MatchingSettings({ matching }, ref) {
  const [config, setConfig] = useState(matching.config), [key, setKey] = useState("");
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState("");
  const draft = useRef<MatchingConfig>(config), saved = useRef<MatchingConfig>(config), keyDraft = useRef("");
  const flight = useRef<Promise<boolean> | null>(null);
  const keyStored = matching.config.backend === config.backend && matching.keyStored;
  const service = config.backend === "bedrock" ? "Bedrock" : "OpenRouter";
  useEffect(() => {
    if (JSON.stringify(draft.current) === JSON.stringify(saved.current)) {
      saved.current = matching.config; draft.current = matching.config; setConfig(matching.config);
    }
  }, [matching.config]);
  const flush = useCallback(async (force = false): Promise<boolean> => {
    if (flight.current) return flight.current;
    if (!force && !keyDraft.current && JSON.stringify(draft.current) === JSON.stringify(saved.current)) return true;
    const submitted = draft.current, submittedKey = keyDraft.current;
    let input;
    try { input = saveMatchingSchema.parse({ config: submitted, ...(submittedKey.trim() ? { apiKey: submittedKey } : {}) }); }
    catch { setError("Check the model, region, provider and API key. The key must contain no spaces or newlines."); return false; }
    setBusy(true); setError(""); setNotice("");
    const operation = window.deck.saveMatching(input).then(() => {
      saved.current = input.config;
      if (draft.current === submitted) { draft.current = input.config; setConfig(input.config); }
      if (keyDraft.current === submittedKey) { keyDraft.current = ""; setKey(""); }
      setNotice("AI settings saved"); return true;
    }).catch(e => { setError(message(e)); return false; }).finally(() => { flight.current = null; setBusy(false); });
    flight.current = operation;
    return operation;
  }, []);
  useImperativeHandle(ref, () => ({ flush }), [flush]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (flight.current || keyDraft.current || JSON.stringify(draft.current) !== JSON.stringify(saved.current)) {
        event.preventDefault(); event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  const edit = (patch: Partial<MatchingConfig>) => { const next = { ...draft.current, ...patch }; draft.current = next; setConfig(next); setNotice(""); };
  const test = async () => {
    if (!(await flush())) return;
    setBusy(true); setError(""); setNotice("Testing connection…");
    try { await window.deck.testMatchingConnection(); setNotice("Connection verified"); }
    catch (e) { setError(message(e)); setNotice(""); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      await window.deck.removeMatchingKey();
      const next = { ...saved.current, enabled: false };
      saved.current = next; draft.current = next; setConfig(next); keyDraft.current = ""; setKey("");
      setNotice("Key removed; automatic linking is off");
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  return <section className="matching-settings" aria-label="AI chat matching">
    <h3>AI chat matching</h3>
    <p className="muted">Automatically link relevant chats to today's tasks. AI-added links have a sparkle; use × to dismiss an incorrect match. Existing links stay where you put them.</p>
    <form onSubmit={event => { event.preventDefault(); void flush(true); }}>
      <label>AI service<select aria-label="AI service" value={config.backend} disabled={busy} onChange={event => {
        keyDraft.current = ""; setKey(""); edit({ backend: event.target.value as MatchingConfig["backend"], enabled: false });
      }}><option value="openrouter">OpenRouter</option><option value="bedrock">Amazon Bedrock (direct)</option></select></label>
      <label>{service} API key<input type="password" aria-label={`${service} API key`} autoComplete="new-password" spellCheck={false} maxLength={16384} value={key} disabled={busy || !matching.secureStorageAvailable} placeholder={keyStored ? "Key saved — enter a replacement" : "Paste your API key"} onChange={event => { keyDraft.current = event.target.value; setKey(event.target.value); setNotice(""); }} /></label>
      <p className="muted">{keyStored ? "A key is saved securely on this computer. It is never shown again." : "The key is encrypted using your operating system's secure storage."} Each service has its own saved key.</p>
      {config.backend === "bedrock" && <p className="muted">Use a Bedrock API key or bearer token, not an AWS access key ID. Expired tokens must be replaced here. AWS profile/SSO authentication is not supported.</p>}
      {!matching.secureStorageAvailable && <p className="error" role="alert">Secure key storage is unavailable. Saving a key and automatic matching are disabled.</p>}
      <label className="matching-toggle"><input type="checkbox" checked={config.enabled} disabled={busy || !matching.secureStorageAvailable || matching.demo} onChange={event => edit({ enabled: event.target.checked })} />Enable automatic chat links</label>
      <p className="muted">When enabled, sends bounded chat titles, repository names, the latest observed exchange, and today's task titles, notes and ticket keys to {service}. Uncertain matches stay unassigned. At most five matching requests per minute.</p>
      {matching.demo && <p className="muted">Automatic matching is paused in demo mode. Demo credentials and settings are separate.</p>}
      <details className="matching-advanced"><summary>Model and routing</summary>
        {config.backend === "bedrock" ? <>
          <label>AWS region<input value={config.bedrockRegion} maxLength={40} disabled={busy} onChange={event => edit({ bedrockRegion: event.target.value })} /></label>
          <label>Bedrock model / inference profile<input value={config.bedrockModel} maxLength={200} disabled={busy} onChange={event => edit({ bedrockModel: event.target.value })} /></label>
          <p className="muted">Calls Bedrock Runtime directly. Luna defaults to the global inference profile from Sydney (ap-southeast-2). Inference can run outside Australia. Use a profile your AWS account and region allow. Requests never fall back to OpenRouter.</p>
        </> : <>
        <label>Model<input value={config.model} maxLength={200} disabled={busy} onChange={event => edit({ model: event.target.value })} /></label>
        <label>OpenRouter provider<input value={config.provider} maxLength={200} disabled={busy} onChange={event => edit({ provider: event.target.value })} /></label>
        <p className="muted">Luna uses the Bedrock endpoint by default. Requests stay on the selected provider.</p>
        </>}
      </details>
      <div className="matching-actions"><button type="submit" className="primary" disabled={busy}>Save AI settings</button>
        <button type="button" disabled={busy || matching.running || !matching.secureStorageAvailable || (!keyStored && !key.trim())} onClick={() => void test()}>Test connection</button>
        <button type="button" disabled={busy || !keyStored} onClick={() => void remove()}>Remove saved key</button>
      </div>
      <div role="status">{notice || (matching.running ? "Matching a chat…" : !matching.config.enabled ? "Automatic linking is off" : matching.error || matching.demo || !matching.secureStorageAvailable || !matching.keyStored ? "Automatic linking is paused" : "Automatic linking is on")}</div>
      {(error || matching.error) && <p className="error" role="alert">{error || matching.error} Save AI settings or test the connection to retry.</p>}
    </form>
  </section>;
});
