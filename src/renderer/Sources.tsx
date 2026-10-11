import React, { useState } from "react";
import type { Snapshot, Command, Source } from "../shared/types";
import { providerLabel, message, age, Modal } from "./components";
const api = window.deck;

export default function Sources({
  snapshot,
  mutate,
  report,
}: {
  snapshot: Snapshot;
  mutate: (c: Command) => Promise<void>;
  report: (s: string) => void;
}) {
  const [selected, setSelected] = useState("");
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);
  const [formError, setFormError] = useState("");
  const source =
    snapshot.sources.find((s) => s.id === selected) ?? snapshot.sources[0];
  const setup = source && snapshot.setups[source.id];
  const submitSource = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await mutate({
        type: "createSource",
        name: String(form.get("name")),
        provider: form.get("provider") as Source["provider"],
        environment: form.get("environment") as Source["environment"],
      });
      setAdding(false);
    } catch (e) {
      setFormError(message(e));
    }
  };
  return (
    <section className="sources-page" aria-label="Live sources">
      <div className="section-heading">
        <div>
          <h2>Live sources</h2>
          <p className="muted">
            Hook events start monitoring. Existing chat history is not imported.
          </p>
        </div>
        <button className="primary" onClick={() => setAdding(true)}>
          Add source
        </button>
      </div>
      {snapshot.demo && (
        <p className="notice">
          Demo sources are samples. Restart without --demo before configuring
          real hooks.
        </p>
      )}
      {!source ? (
        <div className="empty">
          <h3>Connect Codex, Claude Code, or Cursor</h3>
          <p>
            Add a source for each provider and environment. Configuration is
            explicit; your existing hooks are never replaced.
          </p>
          <button onClick={() => setAdding(true)}>Add your first source</button>
        </div>
      ) : (
        <div className="source-layout">
          <nav aria-label="Sources">
            {snapshot.sources.map((s) => (
              <button
                key={s.id}
                className={
                  s.id === source.id ? "selected source-item" : "source-item"
                }
                onClick={() => {
                  setSelected(s.id);
                  setCopied(false);
                }}
              >
                <strong>{s.name}</strong>
                <small>
                  {providerLabel(s.provider)} · {s.environment}
                  {!s.enabled && " · Paused"}
                </small>
              </button>
            ))}
          </nav>
          <section key={source.id} className="source-detail">
            <div className="section-heading">
              <h3>{source.name}</h3>
              <button
                onClick={() =>
                  void mutate({
                    type: "updateSource",
                    id: source.id,
                    enabled: !source.enabled,
                  }).catch((e) => report(message(e)))
                }
              >
                {source.enabled ? "Pause ingestion" : "Resume ingestion"}
              </button>
            </div>
            <p>
              {source.accepted} accepted · {source.rejected} rejected · Last
              received: {age(source.lastEventAt)}
            </p>
            {!source.enabled && (
              <p className="notice">
                Ingestion is paused. Hook files remain queued until resumed (up
                to 1,000 pending events; seven-day expiry).
              </p>
            )}
            {source.error && (
              <p className="error" role="alert">
                {source.error}
              </p>
            )}
            <h3>1. Configure the hooks</h3>
            <p>{setup.instructions}</p>
            <p>
              Merge into <code>{setup.configFile}</code>. Preserve other
              settings and hooks.
            </p>
            <textarea
              className="config"
              aria-label="Hook configuration"
              readOnly
              rows={12}
              value={setup.config}
            />
            <button
              onClick={() =>
                void api
                  .copy(setup.config)
                  .then(() => setCopied(true))
                  .catch((e) => report(message(e)))
              }
            >
              {copied ? "Copied configuration" : "Copy configuration"}
            </button>
            <h3>2. Verify ingestion</h3>
            <p>
              The local test checks the inbox reader only. To verify HTTP from
              the provider environment, paste the test command below and send
              its JSON input. Then submit a real prompt in an existing provider
              chat to verify hook installation.
            </p>
            <button
              disabled={!source.enabled}
              onClick={() =>
                void mutate({ type: "testSource", id: source.id }).catch((e) =>
                  report(message(e)),
                )
              }
            >
              Send diagnostic event
            </button>
            <p>HTTP test command (reads JSON from stdin):</p>
            <textarea
              className="config"
              aria-label="HTTP test command"
              readOnly
              rows={3}
              value={setup.testCommand}
            />
            <p>
              Test input:{" "}
              <code>
                {JSON.stringify(
                  source.provider === "cursor"
                    ? {
                        hook_event_name: "beforeSubmitPrompt",
                        conversation_id: `http-diagnostic-${source.id}`,
                        prompt: "Diagnostic chat — HTTP receiver test",
                      }
                    : {
                        hook_event_name: "UserPromptSubmit",
                        session_id: `http-diagnostic-${source.id}`,
                        prompt: "Diagnostic chat — HTTP receiver test",
                      },
                )}
              </code>
              . Finish input with Ctrl+D in Bash or Ctrl+Z then Enter in Windows
              Command Prompt.
            </p>
            <h3>3. Add repository path aliases</h3>
            <p>
              Use paths exactly as the provider reports them. Add aliases to
              group Windows and WSL locations into one repository. These
              mappings establish repository context for observed chats. Task
              links are managed separately in Today.
            </p>
            <form
              className="mapping-form"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = new FormData(form);
                void mutate({
                  type: "addWorkspace",
                  sourceId: source.id,
                  projectId: String(data.get("project")),
                  path: String(data.get("path")),
                })
                  .then(() => form.reset())
                  .catch((e) => report(message(e)));
              }}
            >
              <label>
                Workspace path
                <input
                  name="path"
                  required
                  placeholder={
                    source.environment === "wsl"
                      ? "/home/me/src/project"
                      : "/absolute/path/to/project"
                  }
                />
              </label>
              <label>
                Repository
                <select name="project" required>
                  {snapshot.projects
                    .filter((p) => p.kind === "repo")
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
              <button
                disabled={!snapshot.projects.some((p) => p.kind === "repo")}
              >
                Add alias
              </button>
            </form>
            {!snapshot.projects.some((p) => p.kind === "repo") && (
              <p>
                Let the first real event discover a repository, then add other
                paths for that repository here.
              </p>
            )}
            <ul className="mappings">
              {snapshot.workspaces
                .filter((w) => w.sourceId === source.id)
                .map((w) => (
                  <li key={w.id}>
                    <span>
                      <code>{w.path}</code> →{" "}
                      {
                        snapshot.projects.find((p) => p.id === w.projectId)
                          ?.name
                      }
                    </span>
                    <small>Permanent</small>
                  </li>
                ))}
            </ul>
            <details>
              <summary>Local files and limits</summary>
              <p>
                HTTP receiver: <code>{setup.endpoint}</code>
              </p>
              <p>
                Inbox: <code>{setup.inbox}</code>
              </p>
              <p>
                No PowerShell or Bash collector scripts are generated. Accepted
                HTTP events are queued locally before processing, limited to 256
                KiB each, and removed after ingestion. The app must be running
                to receive events; events sent while it is closed are not
                captured. Configuration contains a private token for this
                source. Remove old deck command hooks when replacing them with
                this configuration.
              </p>
            </details>
          </section>
        </div>
      )}
      {adding && (
        <Modal title="Add source" close={() => setAdding(false)}>
          <form onSubmit={submitSource}>
            {formError && (
              <p className="error" role="alert">
                {formError}
              </p>
            )}
            <label>
              Source name
              <input
                autoFocus
                name="name"
                required
                maxLength={200}
                placeholder="Work Claude · Ubuntu"
              />
            </label>
            <label>
              Provider
              <select name="provider">
                <option value="claude">Claude Code</option>
                <option value="cursor">Cursor</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label>
              Environment
              <select name="environment">
                <option value="native">Native macOS / Windows</option>
                <option value="wsl">WSL (configure on the Windows app)</option>
              </select>
            </label>
            <button className="primary">Create source</button>
          </form>
        </Modal>
      )}
    </section>
  );
}
