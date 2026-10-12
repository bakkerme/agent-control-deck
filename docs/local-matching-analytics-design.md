# Local matching and analytics design

Status: full design, 2026-10-12. A first local desktop backend and aggregate
analytics subset are now implemented; see the [MVP guide](local-matching-mvp.md)
for the shipped behavior and verification limits. Review labels, saved replay
evidence and policy import below remain proposals.

## First product trial

Use Kai first on the work PC's **Intel Core i7-11850H, 64 GB RAM**, with CPU
inference. This corrects the earlier approximate hardware description. Keep Vela
as an explicit alternative if Kai's delay or resource use becomes inconvenient.
Measure the actual machine; the Mac's 666 ms median cannot establish its speed.

Keep the model resident in a dedicated matching worker. Run requests in the
background, one at a time, with a configurable CPU thread budget (start with four;
compare two and four on the work PC). Never load Python or run model inference in
the renderer or the Electron main thread. Separate model installation/startup time
from warm request time. Load only the selected model, rather than keeping Kai and
Vela resident together. Changing models creates a new recorded configuration.

Use the same pinned, reviewed model revisions as the harness, with verified assets
in app-owned data and an isolated managed Python runtime. Do not depend on the
work PC's PATH Python or install into its global environment. Setup/download is
explicit and shows progress; inference is offline after setup. Native packaging of
the runtime remains a separate validation step, not something the current harness
has proven. Keep local model files and confidential evidence out of Git.

Local matching should not inherit the current cloud backend's 12-second request
cooldown. Keep cloud scheduling unchanged. For local work, coalesce updates for
one second, keep at most one pending assessment per chat, and replace pending work
with its newest evidence. A result must still pass the existing freshness check
before applying. Cache unchanged links and abstentions across restart, including
model revision, adapter, policy and candidate context in the fingerprint. Preserve
manual links and dismissals. Round-robin pending chats so an active chat cannot
starve the rest. Observe queue age and superseded requests to identify overload.
Bound the pending queue (initially 64 chats); additional eligible chats stay in
storage for the next scheduling pass, with a deferred count. Do not accumulate
payload copies for every hook event. Persist model/configuration identity, not a
resident worker's transient queue; rebuild current eligible jobs after restart.

Initial local policies should be explicitly marked **synthetic starting policies**:

| Model | Task score | Margin | Context score | Adapter |
| --- | ---: | ---: | ---: | --- |
| Kai | 0.50 | 0.10 | 0.25 | Concise v3 |
| Vela | 0.75 | 0.50 | 0 | Concise v3 |

These reproduce the existing calibration-selected synthetic experiments; the
desktop's current cloud policy remains separate. Use model scores as threshold
inputs, not guarantees of correctness. Policy changes get an identity and effective
time; do not silently retune them from usage or switch models on individual requests.

For the trial, a link appearing a few seconds after an exchange is acceptable if
the app stays responsive. A provisional investigation trigger is warm end-to-end
p95 above five seconds or a queue that regularly fails to drain. This is a prompt
to inspect timings and try Vela, not a product release gate. Also test while voice
transcription and normal work are active. Measure long inputs and many candidates,
not just the short synthetic cases. Keep the existing candidate cap; report length
or capacity failures without silently dropping candidates.

## What to measure

Store analytics in the current workspace on that PC, with demo data isolated.
No telemetry service, automatic upload or provider-storage scraping is needed.

| Question | Recorded evidence | Display |
| --- | --- | --- |
| Does matching feel slow? | Evidence-ready, enqueue, start, model-finish and apply times; monotonic durations within the running process | Queue wait, inference and end-to-end p50/p95; sample count |
| Is startup the problem? | Worker start/load/first-request durations; restarts | Cold startup separately from warm requests |
| Is the CPU busy? | Worker CPU milliseconds, thread budget, sampled worker process RSS | CPU time per request, active time per hour, peak RAM; sampling method |
| Does workload affect speed? | Input token/character counts, eligible candidate count, truncation flags | Timing by input-size/candidate-count bands |
| Is it doing useful work? | Linked, no-match, uncertain, missing-context, error, stale and superseded outcomes | Distinct chats assessed, applied links, abstentions by reason |
| Do links need correction? | Explicit review labels; remove/relink/Undo actions | Reviewed quality and observed corrections as separate measures |
| Does it miss useful links? | Reviewed abstentions and their original candidate set | Missed matches among reviewed abstentions |
| Are scores useful? | Full option distribution and context score, frozen configuration, explicit label | Accuracy by score band and Brier score on definite labels |

Count distinct chats alongside attempts. A busy chat producing twenty assessments
is not twenty independent quality examples. Warm timings are measured requests
only; connection tests, startup, skipped/cache-hit work and errors have separate
counts. Show unavailable metrics as unavailable, not zero. Record sampling coverage
and any dropped analytics events. Percentiles need counts and the chosen time window.

Do not label automatic links “accepted” just because the user left them alone.
Call them **applied links** until explicitly reviewed. Remaining linked is a useful
usage observation, not proof of accuracy. A manual link following an abstention
is a possible missed match only when that task was eligible at the original attempt.

## Feedback without turning every link into a form

Keep normal sparkle rows, remove, relink and Undo interactions. Record their
provenance in the background. Removing a link records **removed**, not automatically
**wrong**: the conversation may have changed scope, the card may have changed, or
the user may be cleaning up old work. Removing then relinking records the sequence
without guessing intent. Archiving a chat or deleting a task is not negative feedback.

Add an optional review list under matching settings. For an applied link, allow
“Correct”, “Wrong — choose another task”, “No matching task”, “Several tasks fit”
and “Skip review”. For an abstention, allow choosing an eligible task, “No matching
task”, “Several tasks fit”, “Too little context” and “Skip review”. A review label
describes the saved evidence at that attempt. Review does not change a live link;
an ordinary link-edit action remains separate. Revising a review records a new
revision; Undo reverses the associated user action without deleting its history.

Keep the same task meaning used in the suite: broad attention areas. Distinguish
“several tasks fit” from “none fit”, and distinguish both from missing context.
Allow a scope-change annotation so a legitimate later move does not condemn the
earlier assessment. Without a saved snapshot, show “Earlier evidence unavailable”;
do not present today's edited chat as the original model input.

Offer a small optional random review sample across applied links **and abstentions**
(for example three per day). Keep random reviews separate from user-selected error
reviews. Always show review coverage and selection method; a review set concentrated
on mistakes cannot estimate general precision. Recall is available only for an
explicitly labelled set containing genuine matches and no-match cases, not from
passive correction counts. Review counts are diagnostics, not a zero-error target.

## Settings view

Keep this under **Settings → AI chat matching → Local performance and feedback**,
with a seven-day default and Today/7 days/30 days filters. Avoid adding a permanent
dashboard to Today. The compact summary contains:

1. Selected model, readiness and policy version; “Switch to Vela” in model settings.
2. Typical delay / p95, queue wait, model time, startup time and peak model RAM.
3. Chats assessed, links applied, abstentions, removals and explicit corrections.
4. “Reviewed: N of M eligible assessments”; confirmed correct/incorrect counts and
   missed reviewed matches. Show “Not enough reviewed examples” where appropriate.
5. An expandable recent-decisions list with outcome, scores, timing, review status
   and optional saved evidence. It can be filtered to errors, slow requests,
   corrections and uncertain assessments.
6. “Export summary”, “Export reviewed examples for this PC”, retention settings and
   “Clear analytics”. Clearing analytics does not delete task links, chat history,
   dismissals, matcher cache or user notes.

Group comparisons by model revision, prompt adapter, policy and thread budget.
Show periods separately when configurations differ. Kai and Vela used on different
days can describe resource use, but do not constitute a controlled quality comparison.
Use the same frozen reviewed inputs in offline replay for that comparison.

## Two data levels

**Metrics history (default when local matching is enabled):** bounded assessment
and feedback records. Includes model/configuration identity, scores, opaque local
chat/task references, lengths, timings and outcome codes. No prompt, response,
title, notes, repository path, ticket text, free-text reason or credentials in these
records. Error codes are allowlisted categories, not raw exception/provider bodies.
Normal app storage already holds current chat/task content; metrics need not copy it.

**Save replay evidence (explicit local option):** immutable copies of exactly the
bounded input and candidate descriptions given to the model, including the original
eligible/dismissed context. This can contain work details. Save before inference;
keep labels outside the model request. Record input truncation and model-side length
errors. Do not collect complete transcripts or extra files. Disabling the option
stops new snapshots; clearing snapshots is separate from clearing metrics.

Use an initial retention of 30 days or 10,000 assessments, whichever limit is reached
first. Limit optional snapshots to 2,000 entries and 64 MiB, with per-entry bounds.
Expire older evidence independently of metrics and disclose when evidence has expired.
Raw samples used for p95 must cover the same displayed retained window; do not mix
an all-time count with a retained-window percentile. Keep summaries available while
the model is unloaded. Diagnostics collection can be disabled without disabling links.

### Summary export

A versioned JSON summary plus a readable HTML report, generated on demand. Include
model/revision/adapter/policy, app/runtime versions, OS/architecture, manually supplied
CPU description, thread budget, date range, aggregate timing/resource/outcome bands,
review coverage and reviewed quality. No stable chat/task IDs, content fingerprints,
exact event timestamps, file paths, hostname, titles, tickets, source payloads or
free-text labels. Example schema identity: `local_matching_summary.v1`.

The exporter builds this from an allowlisted aggregate DTO, not by removing fields
from raw database rows. Hardware/version/usage aggregates still describe the
installation; the user decides whether any export can leave the work PC. There is
no automatic transfer. A JSON fixture should contain a version and explicit
provenance so example data cannot be confused with live workplace observations.

### Work AI handoff

Export reviewed, saved snapshots locally as `decision_dataset.v1` with provenance
`anonymized-work` only if they have actually been anonymized; otherwise use a new
explicit `private-work` provenance supported by the loader. Do not mislabel raw
work content. Preserve ordered candidates, question adapter/version, original
eligibility context, definite/no-match/ambiguous/missing labels, and source group.
Review labels never go into a model request. Export into a user-chosen local folder;
there is no cloud AI invocation from the analytics screen.

The work AI can then use this workflow on the work PC:

1. Inspect score bands, slow cases and reviewed mistakes. Include successful matches
   and no-matches, not just corrections, when assessing a change.
2. Create a genuinely new calibration/holdout split by conversation group and plan
   family. Keep related attempts/paraphrases and near-duplicate evidence together.
   Exclude preservation-only cases from inference-quality counts. Reserve holdout
   before prompt/threshold selection; do not pretend previously tuned cases are new.
3. Replay Kai and Vela on identical inputs with the portable harness. Start with
   existing adapters, then change one factor (thresholds, wording or threads) at a time.
4. Select thresholds on calibration and evaluate the frozen choice on holdout.
   Save a report, explicit review counts and immutable configuration identity.
5. Import a reviewed local policy explicitly, validating model revision, adapter,
   finite threshold bounds and supported schema. Unsupported prompt changes require
   a matching app adapter update; do not execute arbitrary code from a policy file.

The current loader only accepts `synthetic` and `anonymized-work`; implementing the
private export requires adding `private-work` validation and keeping all such files
out of Git. Reuse the current harness rather than building a second evaluation engine.
Do not auto-promote work-AI changes into live linking.

## Integration points and data lifecycle

| Area | Proposed change |
| --- | --- |
| `src/main/chat-matcher.ts` | Backend-neutral asynchronous request adapter; bounded local queue; collect timing/scores/outcome, including freshness discards and whether `linkAutomatically` actually succeeded |
| New main-process worker manager | Start/stop only the owned inference worker, verify pinned assets, reuse resident CPU model, bounded protocol, handle cancellation/crash/timeout; never control observed agent processes |
| `src/main/store.ts` | Next schema migration with backup; add bounded assessment, feedback and optional snapshot tables |
| `src/main/planning-store.ts` | Emit provenance-aware remove/relink/Undo events after committed user changes; analytics history stays outside planning Undo snapshots |
| `src/shared/matching-settings.ts` | Local model choice, readiness, policy, thread budget and evidence retention; no API-key requirement for local matching |
| Shared/preload/runtime contracts | Typed summary, paginated history, review commands and explicit export; sender/input validation, no renderer filesystem or shell access |
| `src/renderer/MatchingSettings.tsx` | Compact analytics and review view, separate local model readiness from cloud connection status |
| `scripts/chat-task-eval/` | Shared adapter/policy identity, private reviewed-data import, same frozen-policy scoring |

Proposed records:

- `matching_assessments`: attempt ID, local chat reference, input fingerprint, config
  identity, eligible task IDs, task/no-match/context scores, monotonic durations,
  input-size counts, resource samples, decision, actual application outcome and
  bounded error code. An applied link retains its originating attempt ID even if
  its historical assessment later expires.
- `matching_feedback`: event ID, attempt/link reference where known, action/review
  kind, chosen local task, label revision, Undo reference and observation time.
  Unknown provenance stays unknown; never attach an edit to the latest unrelated
  assessment just because it shares a chat ID.
- `matching_evidence`: attempt ID, bounded immutable payload, original local
  eligibility context, digest, byte size and expiry. Absent/expired evidence is an
  explicit state.

Keep `ai_match_attempts` as the current per-chat deduplication cache rather than
replacing it with history. A model request and an actually applied link are different
events; a stale response or refused `linkAutomatically` must not count as an applied
link. Preserve existing Undo and pair dismissals. Switching model/policy invalidates
assessment fingerprints for eligible unlinked chats, never existing links.

Write required link provenance in the link transaction. Optional diagnostics are
best effort after commit: collection failure cannot roll back a valid user action,
stop hook ingestion or silently invent an observation. Expose degraded collection
and missing coverage; do not accumulate an unbounded retry queue. Database failure
still preserves the existing app's normal error behavior. Keep review revisions
and feedback transactional, and separate demo/live workspaces. Deletion and expiry
must preserve live user-owned planning state.

## Delivery and verification

Build the resident local backend and bounded analytics together for the first work
PC trial; add richer replay/review after timing and basic provenance work reliably.
The smallest useful release contains local Kai/Vela selection, startup/readiness,
queue/model/end-to-end timing, outcome counts, link-edit provenance, and aggregate
JSON/HTML export. Exact quality percentages require explicit review labels; show
them as unavailable until that part is implemented.

Validate stale responses, changing settings, cache identity, queue coalescing and
fairness, cancellation, worker loss and bounded input/output. Validate labels and
feedback across remove/relink/Undo, rejected link application, task deletion,
retention, restart and scope changes. Seed exports with distinctive private strings
and assert they cannot appear in metrics records or aggregate exports. Test schema
migrations against existing cache/link/dismissal/Undo data; never reset databases.
Headless renderer checks cover filters, unavailable metrics, review and exports.

Use `npm run check` for implementation changes; IPC/lifecycle additions also need
the opt-in Electron suite, and bundled runtimes/models or native dependency changes
need packaging checks. Validate native Windows installation, resident CPU inference,
resource use under normal work/transcription, offline operation after setup and
cleanup of the owned worker. Until that happens, Mac fixtures demonstrate only
their own environment. A few wrong reversible links do not prevent trial use:
judge useful links against correction effort and observed performance.
