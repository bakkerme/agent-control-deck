# Local matching MVP: Windows-first trial

The desktop now supports **Local CPU model** alongside OpenRouter and direct Bedrock.
Start with Kai; switch explicitly to Vela if delay or resource use is inconvenient.
Matching stays off until enabled. Existing links and dismissals are preserved.

## Run on native Windows x64

Use Node 24+ and npm in PowerShell when building from this checkout:

```powershell
npm ci
npm run build
npm start
```

Alternatively, extract the supplied source ZIP, open PowerShell in its
`agent-control-deck` folder and run the bundled launcher:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1
```

It checks Node, installs dependencies, builds and starts the desktop. Node 24+ must
already be installed. The source ZIP contains no dependencies, models, credentials
or local data. It is a source distribution, not a prebuilt Windows executable.

On Windows, `npm run package` builds an unpacked app and `npm run dist` creates its
ZIP distribution. The package includes setup/worker scripts and uses Electron's
embedded Node for setup; packaged-app users need no separate Node or Python install.

In **Settings → AI chat matching**:

1. Choose **Local CPU model**, **Kai**, and **4 CPU threads**.
2. Click **Download local model**. This saves the selection with linking off,
   installs an app-owned managed Python 3.13 environment and CPU Torch dependencies,
   and downloads the pinned checkpoint through HF CLI. Progress appears in Settings.
   Allow several minutes and several GB of disk space.
3. Click **Test local model**. It verifies and loads the model and sends a synthetic
   request. The process stays resident. No API key or GPU is needed, and inference
   is offline after setup.
4. Enable **automatic chat links** and save. Try it alongside normal work and voice
   transcription. Observe queue delay, resource use and actual correction effort.
5. If needed, try two threads, or choose **Vela**, download/test it and enable again.
   Only one model is resident; there is no silent per-request model fallback.

Assets, environments, caches and `setup.log` are under
`<data directory>/local-matching/`. Setup does not change system Python or PATH.
Closing the app, changing matching settings or switching workspace stops only its
owned inference/setup processes. Windows cleanup targets that process PID and its
descendants, never observed agents. Workplace network restrictions may prevent
runtime/package/model downloads. Failed HF downloads resume against their pinned
revision on retry. Unregistered or different cached checkpoints are preserved and
rejected rather than overwritten.

## Matching behavior

Local matching coalesces updates for one second and processes one request at a time,
with at most 64 pending chats. Additional chats remain in storage for another pass.
Unchanged assessments, including abstentions, are cached across restart. New evidence
or configuration changes trigger another assessment. Stale responses never apply to
edited task/chat context. Cloud backends retain the existing 12-second cooldown.

The adapter is **Concise v3**, with synthetic starting thresholds:

| Model | Task | Margin | Context |
| --- | ---: | ---: | ---: |
| Kai | 0.50 | 0.10 | 0.25 |
| Vela | 0.75 | 0.50 | 0 |

These are not guarantees of work accuracy. Revisions/policies are shared with the
harness through `src/shared/local-models.json`. Excessive token length is rejected;
the app does not drop candidates to make a request fit. Errors pause matching;
test the model or save settings to retry. Protocol inputs/outputs and timeouts are
bounded. Raw inference errors that might echo chat content are discarded.

## Local performance and feedback

Settings shows rolling 24-hour/7-day/30-day counts and configuration-specific timing:

- Distinct chats, assessments, applied links, abstentions and errors.
- Warm model median/p95, queue p95, delay since queued p95 and peak worker RAM.
- Automatic link removals, manual additions and links restored by Undo.
- Recent outcomes without copying chat/task text into analytics.

Model percentiles exclude the first request after each worker load. Startup appears
separately in readiness; “since queued” includes loading when needed. Queue time
begins when the matcher queues current evidence, not at the provider's original
prompt submission. CPU milliseconds are retained in aggregate exports. RSS is worker
process RAM sampled every 20 ms, including runtime, model and activations.

An automatic link refused by current planning state is `not-applied`, not a successful
link. Removals are feedback, not confirmed errors. Accuracy, precision and recall
remain **unavailable**: explicit labels/review are not in this MVP. Feedback currently
uses action counts, without per-attempt correction labels. Saved replay evidence,
review and policy import remain later steps in the [full design](local-matching-analytics-design.md).

Retention is 30 days and up to 10,000 assessments/10,000 feedback events. Clearing
analytics preserves links, dismissals, chat data and matcher caches. Collection
failures show incomplete coverage rather than rolling back user actions.

## Export and work AI

**Export summary JSON** and **Export summary report** create local aggregate
downloads. They omit chat/task IDs, content, titles, notes, tickets, paths, exact
per-event timestamps and credentials. HTML renders the same JSON without scripts.
No telemetry is sent automatically. Exports still describe configuration and usage;
keep them on the work PC when required.

Your work AI can inspect exports and modify the versioned local adapter/policy in
this checkout. Use the [portable evaluation harness](local-decision-eval.md) and
reviewed local examples before tuning thresholds; summary counts alone cannot
establish accuracy. This MVP does not export confidential chat examples or
automatically apply AI-authored changes. Keep calibration and holdout separate.

## Verification limits

Real resident Kai/Vela requests have been exercised on Mac Apple Silicon, with
verified checkpoints and four requests per model. Tests cover Windows paths and
environment isolation, resident reuse, local linking, freshness, cache preservation,
migration and feedback. Headless UI tests cover settings persistence and export.
Existing CI checks and packaging run on Windows; fixture checks without downloads
do not prove native Windows model installation or inference.

Native Windows x64 setup, download, inference, resource use during work and offline
operation still need a trial on the Intel Core i7-11850H. A few reversible mistakes
do not prevent a trial: judge useful matches against correction effort and delay.
The Mac-to-Windows package attempt stopped because node-gyp cannot cross-compile
the required native SQLite module; build/package on Windows instead.
