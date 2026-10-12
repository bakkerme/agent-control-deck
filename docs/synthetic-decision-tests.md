# Everyday synthetic matching cases

Source: [dataset.synthetic-v1.json](../scripts/chat-task-eval/dataset.synthetic-v1.json).
This public, hand-written set expands no-match coverage without changing the
23 existing regression cases. It is bundled as `--dataset synthetic-v1`.

| Partition | Clear no match | Genuine match | Ambiguous | Missing context | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Calibration | 10 | 8 | 1 | 1 | 20 |
| Holdout | 10 | 8 | 1 | 1 | 20 |

Tasks are broad attention areas. New tickets within an area remain positive
controls; adjacent work outside that area is negative. Clear no-match cases have
sufficient context, so the context gate cannot disguise bad task selection.
Ambiguity has sufficient context but no preferred single task. Missing-context
cases and ambiguity omit a ranking label rather than inventing a winning option.

There are eight plan families, four per partition. All conversations sharing a
plan stay in that plan's group and partition. Held-out plans and conversations
are different from calibration plans, rather than renamed copies. Each case
is a distinct hand-written conversation, but cases within a plan are related;
these counts do not establish population accuracy. Splits and labels were fixed
before running models. Every example carries a kind, category and rationale;
those fields and expected labels stay out of model requests.

The intended decision is practical: gain useful automatic links while keeping
corrections occasional. This set is not a zero-error shipping gate. Manual
links and dismissals remain covered by the original regression suite. Review
wrong links as concrete annoyances rather than reducing every outcome to a
pass/fail percentage. Unusual adversarial cases can be added separately later.

## Run it

Rebuild the portable script, then run one model's calibration partition:

```sh
npm run bundle:matching:local
node test-results/local-decision-test.mjs --models kai --adapter concise --dataset synthetic-v1 --split calibration --work-dir local-models --timeout 1800
node test-results/local-decision-test.mjs --analyze-report CALIBRATION_REPORT.json --analysis-out test-results/synthetic-kai-calibration
```

The analysis lists the threshold combinations that offer more correct links
for a given number of wrong links. It shows counts alongside model confidence;
confidence is not an established accuracy guarantee. Inspect that tradeoff on
calibration only. A baseline quality exit code of 1 still leaves complete model
answers available for analysis and threshold selection; code 2 means runtime
or incomplete inference.

As an exploratory starting point for this small batch, request at least five
accepted cases and 80% accepted-link precision. These are adjustable experiment
targets, not agreed shipping requirements, and permit some wrong links. The
legacy defaults of ten accepted cases and 98% precision are deliberately not
used here: each partition contains only eight genuine matches. The precision
target measures observed accepted links, not the model's probability threshold.

```sh
node test-results/local-decision-test.mjs --calibrate-report CALIBRATION_REPORT.json --policy-out test-results/synthetic-kai-policy.json --min-precision .8 --min-links 5
node test-results/local-decision-test.mjs --models kai --adapter concise --dataset synthetic-v1 --split holdout --policy test-results/synthetic-kai-policy.json --work-dir local-models --timeout 1800
node test-results/local-decision-test.mjs --evaluate-report HOLDOUT_REPORT.json --policy test-results/synthetic-kai-policy.json --analysis-out test-results/synthetic-kai-holdout
```

Substitute the report paths printed by each run. Use a fresh output directory
and policy name per experiment; existing reports and policies are preserved.
Repeat with `--models vela` and separate report/policy names to compare Vela.
No remote models are selected by these commands. On another machine, copy just
`test-results/local-decision-test.mjs` and invoke it with Node 24+; the dataset,
HF download support and CPU worker are embedded. Omit `--work-dir local-models`
to use the default cache.

Freeze thresholds before seeing held-out answers. The holdout analysis applies
that policy and does not generate another threshold sweep. A missed experiment
target is useful evidence, not an automatic product veto. These synthetic
results and macOS timings cannot establish work-PC performance.

## First CPU trial: 2026-10-12

Kai and Vela ran the concise v3 adapter with four CPU threads, one warmup and one
measured repetition per case. All 80 measured requests completed with valid output.
Policies were frozen from calibration before either held-out run. Selection used
the exploratory 80% precision and five accepted-case targets described above.

| Model | Genuine held-out matches linked | Clear no-match cases wrongly linked | Other wrong links | CPU median per held-out request |
| --- | ---: | ---: | --- | ---: |
| Kai | 8 / 8 | 0 / 10 | One ambiguous case | 666.6 ms |
| Vela | 7 / 8 | 1 / 10 | None | 90.2 ms |

Kai used task score 0.50, margin 0.10 and context score 0.25. It attached the
equally split scheduling/audit conversation to audit. Vela used task score 0.75,
margin 0.50 and context score 0, disabling its context gate. It attached a billing
conversation to transcripts because of a stale title, with a 0.994 task score,
and abstained on the installer upgrade positive. Raising confidence alone would
not remove that Vela mistake. Both abstained on the missing-context case.

On calibration, Kai offered seven correct links with zero wrong, or eight correct
with two wrong; this trial selected the latter. Vela's selected setting produced
eight correct links and zero wrong on calibration. No thresholds were retuned
after viewing held-out results.

The local [overview report](../test-results/synthetic-decision-evaluation/analysis.html)
contains the case rationales, concrete decisions, frozen policies and source report
links. Artifacts remain ignored. These are macOS Apple Silicon CPU measurements,
with synthetic author labels; private-work accuracy and Windows i7 performance
remain unmeasured. The policies apply to evaluation, without changing desktop
automatic linking.

## Label review

The full prompt, response and candidate tasks are in the source JSON. The rows
below summarise the label reasoning; this is author review, not independent
human validation.

### Calibration

| Case | Kind / expected home | Category | Rationale |
| --- | --- | --- | --- |
| calibration-storefront-partial-refund | match / refunds | explicit-ticket | An explicit task ticket and refund subject agree. |
| calibration-storefront-catalog-filter | match / search | broad-task-scope | A different ticket still belongs to the broad product discovery task. |
| calibration-storefront-profile-address | no_match | same-repository | Customer profile persistence falls outside refunds, product discovery and CI. |
| calibration-storefront-search-build-log | no_match | lexical-overlap | Searching log text is not product search, and no build job is involved. |
| calibration-storefront-missing-cart-task | no_match | task-absent | Basket and checkout work is clear, but that area has no candidate task. |
| calibration-photo-library-album-tags | match / catalogue | topic-without-ticket | Organising existing photos directly fits the catalogue attention area. |
| calibration-photo-library-card-duplicates | match / import | explicit-ticket | The ticket and duplicate import behaviour fit camera import. |
| calibration-photo-library-pdf-catalogue | no_match | lexical-overlap | A workshop brochure shares the word catalogue but is unrelated to organising library photos. |
| calibration-photo-library-stale-import-title | no_match | stale-title | The current subject is account recovery; the old title does not make it import work. |
| calibration-photo-library-backup-library | no_match | same-repository | Upgrade backups are distinct from catalogue interactions, camera import and import help. |
| calibration-work-board-move-card | match / planning | topic-without-ticket | Persistent daily card ordering belongs to daily planning. |
| calibration-work-board-reference-ticket | match / references | explicit-ticket | The explicit ticket and task link extraction identify task references. |
| calibration-work-board-quoted-ticket | no_match | incidental-ticket | A ticket mentioned as fixture filler is not the subject; theme persistence has no candidate. |
| calibration-work-board-repository-picker | no_match | same-repository | Project browsing UI is outside daily cards, task references and installer packaging. |
| calibration-work-board-two-equal-areas | ambiguous | multiple-subjects | Two supplied attention areas are explicit and equally central; no single preferred home is labelled. |
| calibration-service-console-late-samples | match / metrics | broad-task-scope | Late sample handling fits ingestion even though its ticket differs from the task ticket. |
| calibration-service-console-email-retry | match / alerts | topic-without-ticket | The actual work is retrying alert email delivery. |
| calibration-service-console-dashboard-layout | no_match | same-repository | Dashboard layout is distinct from ingestion, email delivery and login permissions. |
| calibration-service-console-billing-receipts | no_match | task-absent | Billing receipts have a clear subject but no supplied billing task. |
| calibration-service-console-continue | missing_context | sparse-context | The round does not identify the proposed change; repository identity alone is insufficient. |

### Holdout

| Case | Kind / expected home | Category | Rationale |
| --- | --- | --- | --- |
| holdout-lending-library-renew-loan | match / loans | explicit-ticket | The ticket and renewal reservation rule agree on loans. |
| holdout-lending-library-author-filter | match / discovery | broad-task-scope | Catalogue filtering remains discovery work despite a different ticket. |
| holdout-lending-library-printer-settings | no_match | same-repository | Local desk device settings are distinct from loans, catalogue discovery and member accounts. |
| holdout-lending-library-reserve-memory | no_match | lexical-overlap | Reserving memory has no connection to book reservations or the other library tasks. |
| holdout-lending-library-missing-inventory | no_match | task-absent | Supplier invoice administration is absent from the three attention areas. |
| holdout-voice-notebook-input-device | match / capture | topic-without-ticket | Input device selection and unplug behaviour fit microphone capture. |
| holdout-voice-notebook-installer-upgrade | match / distribution | explicit-ticket | The ticket and installer upgrade purpose identify application distribution. |
| holdout-voice-notebook-search-records | no_match | lexical-overlap | Searching purchasing records is unrelated to transcript search or audio capture. |
| holdout-voice-notebook-stale-transcript-title | no_match | stale-title | Billing settings are the current subject; the old transcript title is stale. |
| holdout-voice-notebook-cloud-sync | no_match | same-repository | Cross-device synchronisation is a separate area from capture, transcript interactions and distribution. |
| holdout-appointment-desk-cancelled-slot | match / booking | topic-without-ticket | Cancellation and slot availability fit appointment scheduling. |
| holdout-appointment-desk-csv-columns | match / exports | explicit-ticket | The CSV ticket and export fields identify administrative exports. |
| holdout-appointment-desk-response-mention | no_match | incidental-response | Incidental response mentions do not change the prompt subject of colour preference persistence. |
| holdout-appointment-desk-staff-payroll | no_match | same-repository | Payroll calculations are outside scheduling, access audit and appointment exports. |
| holdout-appointment-desk-scheduling-and-audit | ambiguous | multiple-subjects | Scheduling and access audit are equally explicit supplied homes; an automatic single link should abstain. |
| holdout-garden-controller-probe-offset | match / sensors | broad-task-scope | Probe calibration fits soil readings, including work under a new ticket. |
| holdout-garden-controller-watering-duration | match / watering | topic-without-ticket | Configuring irrigation run duration belongs to watering schedules. |
| holdout-garden-controller-firmware-installer | no_match | same-repository | Firmware delivery is outside soil measurement, watering rules and history charting. |
| holdout-garden-controller-garden-budget | no_match | task-absent | Expense tracking is clearly identified, with no matching attention area. |
| holdout-garden-controller-unspecified-fix | missing_context | sparse-context | Neither message identifies the behaviour; the repository does not supply the missing subject. |
