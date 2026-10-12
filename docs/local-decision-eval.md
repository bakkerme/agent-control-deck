# Local decision-model evaluation

The proposed Kai-first desktop trial, Vela fallback, local performance history,
feedback and work-PC replay workflow are in the
[local matching analytics design](local-matching-analytics-design.md). The
[desktop MVP](local-matching-mvp.md) implements the initial local backend and
aggregate history; the portable runner remains a separate evaluation tool.

Start with Kai's original CPU FP32 runtime and the existing matching policy. Measure
quality before quantization, native packaging, or desktop integration. This harness
does not read a desktop database, inspect provider files, change links. Cloud requests are only made when Jev is explicitly selected. All cases are synthetic; it is separate from the Python bridge.

## One portable script: download, evaluate, report

Build the single-file distribution once in the checkout:

```sh
npm run bundle:matching:local
```

Copy **`test-results/local-decision-test.mjs`** to any folder on the test computer.
It embeds the fixtures, scoring policy, validation library, Python worker and
download helper. The test computer needs Node 24+; it needs neither this repository,
`npm install`, an activated venv nor a preinstalled Python. Run the same command in
PowerShell, macOS Terminal or a Linux shell:

```sh
node local-decision-test.mjs
```

The default performs the whole experiment:

1. Reuse pinned uv 0.11.30 or download its checksum-verified official installer.
   A new uv copy, managed Python 3.13 and caches stay under the working directory;
   the installer does not change shell profiles or global Python.
2. Create separate environments for Kai and Julia. Julia requires Transformers
   5.0.x while Kai uses 5.19.0. Top-level packages are pinned; actual transitive
   package versions are recorded in `environment.json`. Windows/Linux install
   CPU PyTorch wheels from the official CPU index, avoiding CUDA dependencies.
3. Use `hf download` to download these exact revisions, or reverify cached files:
   - `vllm-sr/Decision-2.0-Kai-0.6B@cc7f30cda9e7c7b28c5f71ef33f01e09385f1c4b`
   - `SupersonicLabs/Julia-1@a85b127321d580d65176c89ced8273f305745d85`
4. Evaluate both sequentially on CPU FP32, with four threads, one warmup and
   three measured repetitions: 60 inference trials and nine local preservation
   skips per model. No desktop data is read and no cloud model is called.
5. Save a self-contained `report.html`, `report.json`, installed packages, exact
   requests, raw results and logs in `local-decision-test-data/runs/<timestamp>/`.
   The final console output gives the report path. Open the HTML in any browser.

The initial public model downloads total approximately 2.2 GB. Allow additional
space for Python, package caches and environments; several GB of free RAM and disk
are needed. Interrupted HF downloads resume against the same pinned revision.
Models with existing provenance are checked before reuse. Unregistered nonempty
model directories are preserved and rejected; select another `--work-dir`.
Each model's custom Python runtime executes locally after file verification.

Useful options (same on all three operating systems):

```sh
node local-decision-test.mjs --dry-run
node local-decision-test.mjs --models julia --case ticket-over-repository --repeat 1
node local-decision-test.mjs --threads 2,4,8
node local-decision-test.mjs --suite stress --repeat 1 --timeout 1800
node local-decision-test.mjs --work-dir "folder with spaces"
```

For the already-downloaded Kai in this checkout, use `--work-dir local-models`.
That retains its verified checkpoint and creates the separate portable environments
alongside it. The manually created `.venv-local-matching` is independent.

`--dry-run` is offline and writes nothing. The portable script runs live by default;
the original `npm run eval:matching:local` command below still defaults to dry run.
Exit code **0** means every case passed, **1** means the evaluation completed with
quality failures, and **2** means setup/download/runtime errors or incomplete work.
Quality failures are benchmark results. A model failure does not prevent the next
model from running; incomplete trials, errors and partial checkpoints remain in the
report. The whole-worker timeout applies to each model/thread evaluation; setup and
downloads have their own 30-minute step limits.

The portable prompt is `chat_task_decision.portable.v1`. Both models receive the
same compact candidate descriptions, preserving titles, notes, daily notes and
ticket keys. This differs from the original Kai-only adapter's JSON descriptions,
so compare runs with the same prompt version. The default matching and context
thresholds remain unchanged. Julia uses its published PyTorch CPU path with strict
encoding, no request caches, `marker_only_head=false`, an 8192-token input limit,
a 512-token question head and a 48-token per-option limit. It supports 2–20 options,
including `no_match`; the larger stress cases exceed that limit and are recorded as
errors. The harness never silently truncates a candidate list to make it fit.

OS support is macOS **Apple Silicon**, Windows **x64**, and Linux where the pinned
CPU wheels are available. Modern PyTorch does not publish native Intel macOS wheels;
this script reports that limitation rather than selecting an unsupported version.
Real inference and cold Python/uv bootstrap have been exercised on Apple Silicon.
Windows executable/installer paths and failure handling have automated coverage;
native Windows/Linux runs are still needed before claiming those environments are
verified. Build with `node scripts/chat-task-eval/build-local-bundle.mjs OUTPUT_PATH`
to choose another destination. Generated distributions and benchmark data stay out
of Git.

The first portable smoke run on the Apple M3 Pro (36 GiB RAM, four threads, three
repetitions) completed 120 measured requests without runtime errors. Kai's warm
median/p95 was 648/786 ms and sampled peak RSS was 3.35 GiB; Julia's was 72/80 ms
and 1.24 GiB. Labelled top-choice accuracy was 100% for Kai and 18.75% for Julia.
Both abstained on every request under the unchanged policy, so both runs correctly
exit with quality failure, not success. These measurements apply to this synthetic
adapter and machine; they do not establish performance on the Intel work PC.

## Vela, GLiNER and the live Jev reference

Build the updated portable file, then run the two additional local models:

```sh
npm run bundle:matching:local
node test-results/local-decision-test.mjs --models vela,gliner --timeout 1800
```

Vela is pinned to `d6f03aa9baca4f9017fa8f8e9c2764d3bed3f409`; GLiNER2.5-Decide
is pinned to `9d1bfb848cd16d93ee56ccbc59cd92bf0f284d90`. Vela uses its published
`Vela2.system_one` PyTorch CPU runtime. Its duplicate ONNX weights are excluded from
the HF CLI download and that selection is recorded in provenance. GLiNER uses
`gliner2[local]==2.1.0`, native multiclass softmax, and the public return-all-labels
configuration (`multi_label=true`, `class_act=softmax`, `cls_threshold=0`). All native
probabilities and GLiNER's original result are retained without renormalization.
GLiNER's input word cap is `None`, which disables truncation. These models add roughly
3 GB of checkpoint downloads, plus dependencies. Each gets its own Python environment.

For the paid remote reference, put `OPENROUTER_API_KEY=...` in an ignored `.env.local`
file beside the script, or set that environment variable in the launching terminal.
Do not put credentials in command arguments or reports. Explicitly select Jev:

```sh
node test-results/local-decision-test.mjs --models jev
node test-results/local-decision-test.mjs --models vela,gliner,jev --adapter concise --timeout 1800
```

The default remains Kai and Julia with no cloud calls. Selecting `jev` sends only
synthetic evidence and choice questions to OpenRouter's `/api/v1/systemone`, using
`typesafe/jev-1.13`. It is the decision model, not the Jev Router. The response's
actual version, provider, request ID, token counts and reported cost are retained.
Jev runs once per case by default (`--jev-repeat 1`), without billed warmups or
retries. HTTP, identity and response failures stop that remote run with a partial
checkpoint. A Jev-only run needs no Python installation. Remote latency includes
HTTP time; server warm state and memory use are unavailable. Credentials are removed
from every local child environment. `--env-file PATH` selects another environment file.

`--adapter legacy` reproduces the original compact prompt. `--adapter concise`
uses `chat_task_decision.concise.v3`: shorter questions and separate request, answer
and context fields (empty answer fields omitted), preserving the same chat evidence and candidate descriptions.
The dataset, labels, task threshold 0.90, margin 0.20 and context threshold 0.90 stay
fixed. Keep the two prompt versions as separate experiments. Prompt edits made after
examining this suite are diagnostics, not held-out accuracy evidence.

## d3-edge addition

The portable script also supports `--models d3-edge`. It is pinned to
`vllm-sr/d3-edge@18d61df78684675463af9ae732872478845c5a79`, with Transformers
5.17.0 and its own isolated environment. The full published manifest is verified,
including the sharded backbone, readout and runtime files. The checkpoint is roughly
1.2 GB. For a direct comparison, run both existing adapters:

```sh
node test-results/local-decision-test.mjs --models d3-edge --adapter legacy --timeout 1800
node test-results/local-decision-test.mjs --models d3-edge --adapter concise --timeout 1800
```

Both commands use the same fixtures, labels, task/margin thresholds and experimental
context gate as the previous runs. No suite redesign or calibration is included.
The published loader fixes the backbone to BF16 and the readout to FP32 and refuses
an FP32 cast. The worker preserves those numerics on CPU and records them explicitly;
the earlier models use FP32. Optional GPU kernels are omitted because the runtime
rejects them on CPU. This is a text-only experiment; vision/video support is not
qualified. See the [published d3-edge runtime](https://huggingface.co/vllm-sr/d3-edge/blob/18d61df78684675463af9ae732872478845c5a79/modeling_d3.py).

## October 11 comparison results

All five local models completed inference on the Apple M3 Pro using both original
and concise.v3 adapters, with no measured-request runtime errors. Local runs used
four CPU threads and three repetitions; Jev used one paid request per case per
experiment. The smoke set has 20 inference cases, 16 definite ranking labels and
14 expected links. The three local preservation cases remain separate.

| Model | Original labelled ranking | Concise labelled ranking | Concise median | Concise peak RSS | Concise accepted correct links |
| --- | --- | --- | --- | --- | --- |
| Kai | 100% | 93.75% | 528 ms | 3.26 GiB | 0/14 |
| Julia | 18.75% | 50% | 55 ms | 1.18 GiB | 0/14 |
| Vela | 87.5% | 87.5% | 80 ms | 5.90 GiB | 0/14 |
| GLiNER | 93.75% | 93.75% | 408 ms | 3.76 GiB | 0/14 |
| d3-edge | 18.75% | 62.5% | 3277 ms | 1.46 GiB | 0/14 |
| Jev | 100% | 100% | 547 ms including HTTP | unavailable | 13/14 |

All original runs accepted zero links. The existing context gate blocked every
Kai, GLiNER and Jev request, and 19/20 Vela cases; Julia also ranked poorly. The concise Jev trial
returned `typesafe/jev-1.13-20260917` from TypeSafe and passed 22/23 total cases,
including preservation skips. Its one missed link was `incidental-response-mention`:
the task probability was 1.0, but context confidence was below 0.90. There were no
wrong accepted links. The three Jev diagnostic trials (original, preliminary
concise.v2 and corrected concise.v3) reported **$0.001838046 total** for 60 requests.

The first concise.v2 Vela run failed at warmup because the adapter supplied an
empty named answer field. That retained failure is in
`local-models/runs/2026-10-11T10-24-00-361Z-58109/`; concise.v3 omits empty answer
fields and completed successfully. Original results and preliminary diagnostics
remain intact. The combined HTML/JSON evidence is generated in
`test-results/decision-comparison/`, with source paths and SHA-256 fingerprints.

d3-edge completed all 120 measured requests without errors or changed decisions
between repetitions. The original adapter had a 3978 ms median, 4252 ms p95 and
1.60 GiB peak RSS; concise.v3 had a 3277 ms median, 3506 ms p95 and 1.46 GiB peak.
The experimental context gate blocked every request in both adapters. Task ranking
also remained below Kai, Vela and GLiNER. The published CPU reference kernels were
used; no GPU was required. Original long-input requests took about 18.5 seconds,
and the first two isolated concise long-input repetitions took 16.7 and 16.9 seconds.
The final concise long-input repetition overlapped startup of the separate routing
control; its timing is retained with that limitation.
A separate isolated check, with no warmup, took 17.1 seconds and retained the same
task probabilities at
`local-models/runs/2026-10-11T11-03-36-812Z-71309/report.json`.

A separate simple damaged-item support-routing control chose the expected returns
department with probability 0.997436. That control is retained in
`test-results/d3-edge-control/`; it establishes that the loaded runtime can answer
a basic choice, not that it is calibrated or suitable for task matching. d3-edge
does not improve the current automatic-link outcome. Its smaller memory footprint
comes with substantially slower CPU inference on this machine.

These trials support CPU feasibility, especially Vela's speed. None of the local
adapters met the current automatic-link policy. Do not lower gates to make this
observed suite pass and describe that as validation: collect separately labelled
representative examples for calibration and hold out a fresh evaluation set. The
shorter adapter was developed after observing failures; its scores are diagnostic.
Native Windows/i7 performance and a native application runtime remain untested.

## j33-jev: local CPU experiment

The portable runner also accepts `--models j33-jev`, separate from `--models jev`
(the hosted TypeSafe reference). The selected public checkpoint is
[`J33-AI/j33-jev`](https://huggingface.co/J33-AI/j33-jev), pinned to
`34a0eda32b69ffc72f0e33a9acf2b8bdfa07fcc9`. It contains 271,597,852 FP32 parameters
and the published `GemmaJev.predict` runtime. Its required EmbeddingGemma 2
configuration/tokenizer assets are pinned separately to
`google/embeddinggemma-2@914f7f89142e33e77833254d9c9b90c3cef7303b` and inventoried
alongside the fine-tuned weights. HF CLI downloads only the specified base assets.
The published processor needs torchvision even for text-only requests; the
runner pins `torchvision==0.29.1` alongside Torch 2.14.1 and selects CPU wheels
for both packages on Windows/Linux.

The CPU adapter constructs the encoder from that configuration, then calls the
published strict fine-tuned weight loader with `vision=False`, `head="none"` and
`device="cpu"`. This avoids fetching base weights that the native loader would
immediately replace. Published processing, predictions and fitted temperatures
remain intact. The native state input has a 4,000-character cap; longer evidence
is truncated by the published runtime. Raw results record the input state length
and whether it exceeds that cap.

```sh
npm run bundle:matching:local
node test-results/local-decision-test.mjs --models j33-jev --adapter concise --dataset synthetic-v1 --split calibration --work-dir local-models --repeat 1 --timeout 1800
node test-results/local-decision-test.mjs --analyze-report CALIBRATION_REPORT.json --analysis-out test-results/j33-calibration
node test-results/local-decision-test.mjs --calibrate-report CALIBRATION_REPORT.json --policy-out test-results/j33-policy.json --min-precision .8 --min-links 5
node test-results/local-decision-test.mjs --models j33-jev --adapter concise --dataset synthetic-v1 --split holdout --policy test-results/j33-policy.json --work-dir local-models --repeat 1 --timeout 1800
```

Use the report path printed by the run and fresh output paths. Threshold selection
uses the calibration half only; the held-out half uses that frozen policy. The
80%/five-case targets are exploratory choices for the reversible linking feature.

The 2026-10-12 Mac CPU trial completed all 40 measured requests, with one warmup
and one measured repetition per case and four threads. Calibration selected task
score 0.65, margin 0.50 and context score 0.50, producing five correct links and
one wrong link on its 20 cases. Held-out evaluation with that frozen policy
produced two correct links out of eight genuine matches and five wrong links:
four clear no-match cases plus a CSV-export chat attached to appointment scheduling.
The accepted-link precision was 28.6%; the exploratory target was missed. No
thresholds were retuned against held-out answers.

Held-out median/p95 latency was 227/242 ms and sampled peak RSS was 2.39 GiB
(2.47 GiB on calibration). No input state exceeded the native 4,000-character cap.
The [local comparison report](../test-results/j33-decision-evaluation/analysis.html)
retains source fingerprints and compares the same held-out cases against Kai
(eight correct, one wrong) and Vela (seven correct, one wrong). This model runs
comfortably on the tested Mac CPU, but matching was weaker on this synthetic
suite. Windows i7 performance and representative work accuracy remain untested.

## Crivo-150M: local CPU experiment

The portable runner accepts `--models crivo-150m`, pinned to
`tardellirs/crivo-150m@fc61cafa75ca423d29160a9d31163d0a3155cb67`.
The checkpoint has 149,610,241 FP32 parameters (about 599 MB of weights), with
a ModernBERT encoder and option-marker readout. The adapter calls the published
`Crivo.answer` on CPU, preserves its native probabilities, and uses the strict
checkpoint loader. No base weights or GPU packages are needed. The tokenizer,
configuration, weights and native Python code are inventoried and verified before
loading. Its native 32,768-token limit raises an error rather than truncating.

The [model card](https://huggingface.co/tardellirs/crivo-150m) describes training on
benchmark-source train/dev splits and benchmark request formats, with checks for
test-item contamination. It also acknowledges format sensitivity and an optimistic
smart-home result from reused templates. Those claims do not establish performance
on our chat-matching task; we use the existing synthetic partitions unchanged.
The weights are CC BY-NC 4.0, unlike the Apache-licensed Kai/Vela alternatives.
The card's public benchmark timing uses an A100, not a CPU.

```sh
npm run bundle:matching:local
node test-results/local-decision-test.mjs --models crivo-150m --adapter concise --dataset synthetic-v1 --split calibration --work-dir local-models --repeat 1 --timeout 1800
node test-results/local-decision-test.mjs --analyze-report CALIBRATION_REPORT.json --analysis-out test-results/crivo-calibration
node test-results/local-decision-test.mjs --calibrate-report CALIBRATION_REPORT.json --policy-out test-results/crivo-policy.json --min-precision .8 --min-links 5
node test-results/local-decision-test.mjs --models crivo-150m --adapter concise --dataset synthetic-v1 --split holdout --policy test-results/crivo-policy.json --work-dir local-models --repeat 1 --timeout 1800
node test-results/local-decision-test.mjs --evaluate-report HOLDOUT_REPORT.json --policy test-results/crivo-policy.json --analysis-out test-results/crivo-holdout
```

Use fresh output paths and substitute each printed report path. Select thresholds
only on calibration; if no policy meets the exploratory targets, inspect the
calibration tradeoffs before choosing any different target. Do not use held-out
answers to tune thresholds.

The 2026-10-12 Mac CPU trial returned valid answers for all 40 measured requests,
with four threads, one warmup and one measured repetition per case. Calibration
selected task score 0.50, margin 0.20 and context score 0 (context gate disabled):
six correct links and one wrong link, 85.7% precision. Frozen holdout linked four
of eight genuine matches with two wrong links, 66.7% precision, missing the
exploratory sample target. One wrong link followed a stale transcript title; the
other chose scheduling for a chat covering both scheduling and audit. Nine of ten
clear no-matches and the missing-context case remained unlinked. Of four missed
genuine matches, three were classified as no_match and one ranked correctly but
failed the margin gate. No thresholds were retuned after holdout.

Held-out median/p95 CPU latency was 146/148 ms; peak sampled process RSS was
1.87 GiB (1.55 GiB on calibration). That is smaller and faster than Kai in these
runs, but Kai linked eight genuine matches with one wrong link on the same cases.
The [Crivo comparison report](../test-results/crivo-decision-evaluation/analysis.html)
retains all source fingerprints, frozen policies and case decisions. These results
support runtime feasibility on the tested Mac, not Windows i7 performance or
representative private-work accuracy.

## Independent metrics and calibration workflow

The original fixtures, prompt adapters and 0.90/0.20/0.90 baseline gates remain
unchanged. New reports include independent diagnostics for task ranking, missing
context and accepted links. Ranking and context responses are validated separately:
an invalid context answer does not erase a valid task ranking, or vice versa.
Linking and calibration still require valid answers to both questions. Context
metrics include missing-context recall, false blocking of sufficient context,
label coverage, invalid answers and Brier score. Link precision is unavailable when
no links are accepted. Gate blocker counts overlap and expose all failed gates.

The original regression fixtures have separate context annotations: only
`sparse-context` and `local-repository-only` lack a work subject. Clear unrelated
work and clear overlapping subjects have sufficient context. Annotations apply
only to exact known fixture bytes; unknown labels stay unavailable. The original
fixture fingerprint remains
`48e8e4fe59208341cb8063d40ab7d1bb31f9348341ea1ce8587bf3d3b04f3d04`.

Analyze an existing report offline, with no model installation or paid calls:

```sh
node local-decision-test.mjs --analyze-report path/to/report.json --analysis-out matching-eval-data/analysis
```

The analysis preserves the source report and writes new `analysis.html` and
`analysis.json` files. It reports the fixed policy and a context-disabled ablation
side by side. The ablation is diagnostic and does not change application behavior.
Original Kai's context gate falsely blocked 18/18 sufficient-context cases;
original Vela blocked 17/18. These annotations and already-observed examples are
regression diagnostics, not new validation data.

Use `scripts/chat-task-eval/dataset.example.json` as a format template, then save
a reviewed dataset under ignored `matching-eval-data/`. Its eight synthetic format
examples intentionally cannot meet the default minimum of ten accepted cases.
They do not establish representative work accuracy. A dataset needs:

- `schema_version: "decision_dataset.v1"`, `name`, `provenance` (`anonymized-work`
  or `synthetic`) and notes explaining collection and labelling.
- Examples with unique `id`, a source-conversation `group_id`, a fixed
  `calibration` or `holdout` split, matching `payload`, local `context`, and `expected`.
- An explicit `expected.insufficient_context` boolean and `link_task_id` (or null)
  for every example. Positive links also need the same task ID in `expected.label`.
  For clear no-match ranking, use `label: null`; for ambiguity or insufficient
  evidence where no single ranking label is defensible, omit `label`.

Include clear positives, unrelated work, ambiguity, missing context, negated/quoted
tickets, incidental mentions, reordered candidates and truncated but clear text.
Keep every conversation and its derived variations in one group and one split.
Choose the split before examining model answers. The loader rejects crossing
groups/chat IDs, duplicate normalized evidence and known regression evidence.
These checks catch common leakage; they cannot detect every semantic paraphrase
or an incorrectly assigned group. Preservation/skips remain in regression.

For a ready-to-run public synthetic expansion, use `--dataset synthetic-v1`.
The portable script embeds 40 new cases: 20 clear no-matches, 16 genuine matches,
two ambiguity cases and two missing-context cases. Each partition has 20 cases;
the [case catalogue and commands](synthetic-decision-tests.md) explain every
label. Most negatives are nearby work in the same repository, while positives
include different tickets within a broad attention area. The original 23-case
regression suite remains unchanged.

Calibration analysis now also shows correct links gained versus wrong links
introduced across threshold combinations. Held-out analysis does not sweep
thresholds. For this small synthetic batch, use explicit exploratory targets
such as `--min-precision .8 --min-links 5`; each partition contains only eight
genuine matches. The older generic defaults below are not shipping requirements.
An occasional reversible wrong link can be acceptable if the feature saves more
effort than corrections cost. A missed sample target is evidence for that decision,
not an automatic release veto.

Run one model and configuration on the calibration partition:

```sh
node local-decision-test.mjs --models kai --adapter concise --dataset matching-eval-data/work.json --split calibration --dry-run
node local-decision-test.mjs --models kai --adapter concise --dataset matching-eval-data/work.json --split calibration --timeout 1800
node local-decision-test.mjs --calibrate-report CALIBRATION_REPORT.json --policy-out matching-eval-data/kai-policy.json
```

Calibration searches a recorded fixed grid of task, margin and context thresholds
to maximize correct accepted cases subject to `--min-precision` (default 0.98) and
`--min-links` (default ten distinct accepted cases). These are sample targets, not
statistical reliability guarantees. Repeated trials are never counted as additional
labelled cases: any wrong repetition makes that accepted case wrong. No feasible
policy means calibration fails explicitly. Regression reports and incomplete or
invalid inference cannot be used for calibration. Frozen policy files never
overwrite existing files.

Then evaluate the frozen policy on the untouched held-out partition:

```sh
node local-decision-test.mjs --models kai --adapter concise --dataset matching-eval-data/work.json --split holdout --policy matching-eval-data/kai-policy.json --timeout 1800
node local-decision-test.mjs --evaluate-report HOLDOUT_REPORT.json --policy matching-eval-data/kai-policy.json --analysis-out matching-eval-data/heldout-analysis
```

The policy is bound to the dataset manifest and partition fingerprints, model
revision, prompt version and actual returned remote model identity when available.
A changed dataset/model/adapter requires a new calibration experiment. Live holdout
inference requires a frozen policy before calls start; labels and split/group fields
are never included in model requests. The original policy metrics remain visible as
a baseline. Held-out live/offline evaluation exits 0 when the frozen policy meets
its sample precision/minimum-case targets, 1 when it misses them, or 2 on errors.
Synthetic held-out results are labelled synthetic; representative accuracy remains
unknown until evaluated with representative examples. Thresholds are not retuned
on held-out answers. A failed held-out trial calls for a new development/calibration
cycle and a fresh evaluation set, not repeated tuning against the same holdout.

No representative labelled dataset has been collected or calibrated by this change.
Private examples must be deliberately supplied and anonymized; this harness does
not scrape provider storage or desktop chats. Selecting Jev still explicitly sends
the supplied evidence to OpenRouter; offline analysis/calibration never does.

## First run: no model or Python dependencies needed

```sh
npm run test:matching
npm run test:matching:local
npm run eval:matching:local
```

The default is a dry run. The smoke suite contains the 15 existing cloud-matching
cases and eight additional cases: identical titles, repository-only sparse context,
negated and quoted tickets, notes-only evidence, dependency mentions, reordered
ambiguity, and a long prompt. Three cases skip inference because a link already
exists or all candidates were dismissed. A full smoke run makes 20 measured requests
plus one warmup; three repetitions make 60 measured requests plus one warmup.

The stress suite adds 20, 50, and 200 candidate cases. Use it after smoke succeeds.
Inputs that exceed Kai's context limit are retained as errors; they are not silently
shortened or turned into successful abstentions.

## Prepare an isolated model environment

Use Python 3.11–3.14 and Node 24+. PyTorch does not currently publish Python 3.15
wheels; an up-to-date system Python can therefore be too new for this experiment.
The system Python on macOS may also be too old. Select the interpreter explicitly
when creating the virtual environment; upgrading the system Python does not change
an existing environment's interpreter. These
requirements affect only the experiment. Package versions are recorded in reports;
requirements are compatible ranges, not a fully locked environment. Keep a
`pip freeze` beside the report when reproducing or sharing a comparison.

If `pip` says no matching `torch` distribution exists, first check the environment's
interpreter with `.venv-local-matching/bin/python --version` (Windows:
`.venv-local-matching\Scripts\python.exe --version`). If it is Python 3.15, rename
the environment to an unused `.venv-local-matching-backup-*` directory, then create
a fresh one with Python 3.11–3.14 using the commands below. Reusing an existing venv
directory can leave packages from the old Python version behind.

Windows PowerShell (use your installed Python 3.11–3.14 version with `py`):

```powershell
py -3.14 -m venv .venv-local-matching
.venv-local-matching\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv-local-matching\Scripts\python.exe -m pip install -r scripts/chat-task-eval/requirements-local.txt
.venv-local-matching\Scripts\python.exe scripts/chat-task-eval/download_local_model.py --model-path local-models/kai --backend hf
```

macOS/Linux:

```sh
python3.14 -m venv .venv-local-matching
.venv-local-matching/bin/python -m pip install -r scripts/chat-task-eval/requirements-local.txt
.venv-local-matching/bin/python scripts/chat-task-eval/download_local_model.py --model-path local-models/kai --backend hf
```

The `hf` CLI is included in the `huggingface-hub` requirement. `--backend hf` uses
`hf download` with the pinned revision and local directory, preserving the CLI's
progress output. The wrapper finds `hf.exe`/`hf` beside the selected Python first,
then on `PATH`, so virtual-environment activation is unnecessary. To select another
installation, add `--hf-executable "PATH_TO_HF"`. Omitting `--backend hf` keeps the
original Python-library download route.

Use the wrapper for CLI downloads so it also writes the provenance required by the
worker. Running `hf download` directly does not create that sidecar. With an explicit
`--revision FULL_COMMIT_SHA`, the CLI route does not need to import the Hub Python
library to resolve a revision. An unavailable or failed CLI exits nonzero; partial
downloads are retained without a new provenance sidecar.

Only the explicit downloader accesses Hugging Face. It resolves the repository to a
full commit SHA once, downloads that revision, and writes a provenance sidecar outside
the model directory. For an exact rerun, add `--revision FULL_COMMIT_SHA`. Model
directories must be empty; choose another directory for another revision. A failed
download is retained for inspection. Weights and the virtual environment are ignored
by Git. The published repository is approximately 1.52 GB; runtime and loading may
need additional disk and RAM.

The worker verifies the sidecar, manifest hash and inventoried files before loading
checkpoint code, then uses Kai's own runtime validation. It forces CPU execution,
disables Hugging Face online loading, and removes credential-like environment variables. Keep the
model package unchanged; store logs or notes outside it.

## Test one case before the whole suite

Windows:

```powershell
npm run eval:matching:local -- --live --model-path local-models/kai --python .venv-local-matching\Scripts\python.exe --case ticket-over-repository
```

macOS/Linux:

```sh
npm run eval:matching:local -- --live --model-path local-models/kai --python .venv-local-matching/bin/python --case ticket-over-repository
```

For the following commands, replace `PYTHON_EXE` with the appropriate executable:

```sh
npm run eval:matching:local -- --live --model-path local-models/kai --python PYTHON_EXE --repeat 3 --threads 4
npm run eval:matching:local -- --live --model-path local-models/kai --python PYTHON_EXE --suite stress --threads 4
```

Try 2, 4, and 8 threads in separate runs on the work PC. Record whether transcription
and normal work were active. Measure the same checkpoint and dataset both while idle
and while transcribing. Start with short cases; long-input CPU inference can dominate
latency. The default whole-worker timeout is 600 seconds, configurable with
`--timeout`; this includes loading, warmup and all repetitions. No retries run.

## Decision adapter and evaluation

Kai receives two named choice questions: task fit (one option per task plus no match)
and sufficient/insufficient context. Each candidate description includes the title,
notes, daily note and ticket keys. The supplied state contains the observed chat and
plan day. Expected labels and local preservation/dismissal context are never sent.
The adapter prompt is versioned independently of the cloud prompt; decisions are
compared using the same fixtures and policy, but the model interfaces are different.

Every option must have a finite probability in [0,1] and the distribution must sum
to one within 0.001. Scores are never repaired or renormalized. A context-sufficient
probability below 0.90 blocks a link; change this explicitly with
`--context-threshold`. The desktop's unchanged rule then requires task probability
at least 0.90 and a lead of at least 0.20 over the runner-up, including no match.
The report's reason string is an adapter label, not an invented model explanation.

Thresholds are provisional. Do not tune them on the cases subsequently reported as
held-out evidence. The original synthetic suite remains a smoke/regression set;
`synthetic-v1` adds a separate calibration/holdout experiment. Neither establishes
representative work accuracy. Use practical coverage and correction counts to
judge usefulness, then improve with locally reviewed examples as they become
available.

## Evidence and interpretation

Each live run creates an ignored `test-results/matching-local/<timestamp>/` folder:

- `requests.json`: exact synthetic inputs and named questions.
- `raw.json`: atomically checkpointed runtime, warmups, raw answers and errors.
- `report.json`: fixture expectations, dataset hash, prompt version, thresholds,
  scored results and completeness status. Model/dependency versions, hardware
  information, load latency and sampled process memory are in runtime metadata.

Reports measure wrong links, correct links, link precision/recall, abstention rate,
labelled top-choice accuracy, Brier score, changed decisions across repetitions,
and warm latency p50/p95. Skips are excluded from model-quality denominators. A model
that always abstains gets zero link recall and undefined precision. Errors stay
separate from legitimate abstentions, and incomplete runs count unrun trials.

One warmup is kept separately by default: it measures first inference after loading;
later requests measure a resident model. `--warmup 0` includes the first cold request
in quality scoring but excludes it from warm-latency percentiles. Per-request RSS is
sampled every 20 ms, so it can miss brief peaks; it includes the worker/runtime/model,
not just tensors. CPU time is process CPU time, not wall time. These are CPU results,
not VRAM measurements. Reports retain failures and traces; failed quality cases or
incomplete runs exit nonzero.

First decision gate: examine every incorrect link and the coverage lost to abstention.
Next, compare acceptable quality against measured latency under normal work-PC load.
Only then investigate ONNX export or quantization. A macOS run
does not establish native Windows/i7 performance, and Python inference does not
establish a compact native Electron bundle.

Dependency-free Python harness checks:

```sh
python scripts/chat-task-eval/local_worker_test.py
python scripts/chat-task-eval/download_local_model_test.py
```

Sources: [Kai model card](https://huggingface.co/vllm-sr/Decision-2.0-Kai-0.6B),
[CPU/loading interface](https://huggingface.co/vllm-sr/Decision-2.0-Kai-0.6B/blob/main/modeling_decision2.py),
[verified package runtime](https://huggingface.co/vllm-sr/Decision-2.0-Kai-0.6B/blob/main/decision2/api.py),
[HF CLI download documentation](https://huggingface.co/docs/huggingface_hub/en/guides/cli#hf-download).
