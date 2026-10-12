# Chat-to-task matching experiment

For CPU-only decision-model testing, see [local decision evaluation](local-decision-eval.md).
It reuses these fixtures and the desktop's link policy in a separate offline harness.

This standalone harness tests the proposed automatic chat binding. It does not read
your database, modify task links, or integrate AI into the desktop app. All 15 cases
are synthetic. Three cases exercise local skip rules; the full live run makes 12
sequential API requests. No retries run automatically.

## Run without a key

```sh
npm run test:matching
npm run eval:matching
```

The first command tests output validation, thresholds, preserved links, dismissals,
and OpenRouter/Bedrock requests using mocks. The second validates the case payloads and
prints the planned requests without making API calls. Neither measures model quality.

## Add the key and run the model

Copy `.env.example` to `.env.local` and fill in `OPENROUTER_API_KEY`, or set that
variable in your terminal environment. `.env.local` is ignored by Git and is loaded
by the eval command using Node's built-in env-file support. Existing shell variables
take precedence over file values. Do not put a real key in `.env.example`.

```sh
# Start with one request:
npm run eval:matching -- --live --case ticket-over-repository

# Run every case:
npm run eval:matching -- --live

# Check variability (36 requests):
npm run eval:matching -- --live --repeat 3
```

The default model is `openai/gpt-6-luna`, pinned to
`amazon-bedrock/us-east-1` with fallback disabled. This is a documented Luna endpoint
on OpenRouter supporting structured output. If it is unavailable or your key cannot
access it, the run stops rather than silently switching providers. Use
`OPENROUTER_MODEL` and `OPENROUTER_PROVIDER` to explicitly change the experiment.
OpenRouter via Bedrock does not prove identical results with your workplace's direct
Bedrock API, region or inference settings.

## Run directly through Bedrock

Set `AWS_BEARER_TOKEN_BEDROCK` in your shell or ignored `.env.local`. The default
region is `ap-southeast-2` (Sydney) and model is `global.openai.gpt-6-luna`.
Global inference can process requests outside Australia. Override with
`BEDROCK_REGION` and `BEDROCK_MODEL` when your account requires another supported
system inference profile. This uses Bedrock Runtime's Chat Completions API with
the same prompt, schema and decision rules as OpenRouter. It never calls OpenRouter
or uses its key. The desktop's keys remain separate from this harness.

```sh
# First validate offline, then test one real request:
npm run eval:matching -- --backend bedrock
npm run eval:matching -- --backend bedrock --live --case ticket-over-repository

# Compare the full suite with your OpenRouter results:
npm run eval:matching -- --backend bedrock --live
```

The selected AWS region/profile must be available to your IAM identity. This suite
does not establish identical outputs across endpoints; use it to measure direct
Bedrock behavior. AWS token usage is reported, but cost remains unavailable unless
the API explicitly returns a cost.

## What is tested

- Explicit ticket references despite misleading repository/title context.
- Topic matching without tickets, and broad daily attention areas.
- Unrelated chats, equally plausible tasks, and sparse context.
- Truncated text that still contains a clear ticket reference.
- Instructions embedded in chat text or task notes that must stay data.
- Reversed candidate order and incidental assistant response mentions.
- Existing manual and AI links preserved before inference.
- A dismissed chat/task pair excluded, while other candidates remain eligible.
- No eligible candidates: skip the API entirely.

The shared prompt and stable JSON Schema are in
`src/shared/chat-matching.ts`, re-exported by `scripts/chat-task-eval/matching.mjs`
so the harness and app use identical rules. Labelled cases live in `cases.mjs`; expected
labels and local link/dismissal context are never sent to the model. This harness
models the approved compact UX: a clear match adds a normal linked-chat row with an
AI sparkle, and removing it suppresses that pair. The desktop implementation is
configured independently in [Settings](daily-planning.md#optional-automatic-chat-links);
the harness never reads the desktop's securely saved key or database.

## Output and decisions

Every response must score each supplied task exactly once, plus `no_match_likelihood`,
with a total of 1 within 0.001. It must include `insufficient_context` and a short
evidence-based `reason`. Unknown/duplicate IDs, missing candidates, malformed JSON,
invalid scores, refusals and incomplete responses fail closed. Numerical bounds are
validated locally, keeping the schema compatible with Bedrock's supported subset.

A task links only if its score is at least 0.90, its lead over the runner-up
(including no match) is at least 0.20, and context is sufficient. Otherwise the chat
stays unassigned. These are provisional thresholds, not calibrated guarantees.
Existing links are preserved rather than reassigned by changed conversation topics.

Live runs print pass/fail decisions and save timestamped JSON under ignored
`test-results/matching/`. Reports contain the prompt version/text, thresholds,
synthetic payloads, scores, reasons, backend/region, returned model/provider, latency,
token usage and API-reported cost when available. They contain no authorization key
or request headers. Synthetic tests show a bounded provider error message with
credentials redacted; raw error bodies are never printed or saved. Automatic
matching with real chats suppresses provider error messages. A failed case
returns a nonzero exit status; a transport/contract error also stops further requests.

The report includes correct automatic links and a multiclass Brier score for definite
labels (lower is better). Ambiguous and sparse cases have no unique calibration
label. Definite cases must also rank the labelled task (or no match) first to pass.
A small synthetic suite can expose mistakes; it cannot establish calibration.
Before using automatic binding on real chats, add representative labelled examples
and check incorrect-link rate, abstention rate, and score reliability across providers.

## References

- [OpenRouter Luna endpoints](https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints)
- [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [OpenRouter provider selection](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Bedrock structured output constraints](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html)
