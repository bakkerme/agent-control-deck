import { createHash } from "node:crypto";
import { prepareInput } from "./matching.mjs";
import { fixturesFor, datasetHash } from "./local.mjs";
import syntheticV1 from "./dataset.synthetic-v1.json" with { type: "json" };

// A normal JSON import lets esbuild embed the reviewed dataset in the portable file.
export const SYNTHETIC_DATASET = syntheticV1;

export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = value => typeof value === "string" && value.trim().length > 0;
// Ignore identifiers, candidate order and insignificant whitespace for duplicate detection.
export function evidenceHash(payload) {
  const text = value => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  return digest({ title: text(payload.chat.title), repository: text(payload.chat.repository),
    prompt: text(payload.chat.latest_round?.prompt), response: text(payload.chat.latest_round?.response),
    truncated: payload.chat.latest_round?.truncated ?? false,
    tasks: payload.tasks.map(t => [t.title, t.notes, t.day_note, [...t.ticket_keys].sort().join(" ")].map(text)).sort() });
}

export function prepareDataset(document, split) {
  if (document?.schema_version !== "decision_dataset.v1" || !key(document.name) ||
      !["anonymized-work", "synthetic"].includes(document.provenance) || !key(document.notes) ||
      !Array.isArray(document.examples) || !document.examples.length)
    throw new Error("Dataset needs decision_dataset.v1, name, provenance, notes and examples");
  if (!["calibration", "holdout"].includes(split)) throw new Error("Custom dataset needs --split calibration or holdout");
  const ids = new Set(), groups = new Map(), chats = new Map(), evidence = new Set();
  const regression = new Set(fixturesFor("stress").map(f => evidenceHash(f.payload)));
  const prepared = document.examples.map(fixture => {
    if (!key(fixture.id) || ids.has(fixture.id) || !key(fixture.group_id) || !["calibration", "holdout"].includes(fixture.split))
      throw new Error("Every example needs a unique id, group_id and calibration/holdout split");
    ids.add(fixture.id);
    for (const [map, id] of [[groups, fixture.group_id], [chats, fixture.payload?.chat?.id]]) {
      if (map.has(id) && map.get(id) !== fixture.split) throw new Error("Related examples or chat IDs cross dataset splits");
      map.set(id, fixture.split);
    }
    const input = prepareInput(fixture.payload, fixture.context ?? {}), expected = fixture.expected;
    const candidates = input.payload.tasks.map(t => t.id);
    if (input.skip || !expected || !Object.hasOwn(expected, "link_task_id") || typeof expected.insufficient_context !== "boolean" ||
        (expected.link_task_id !== null && !candidates.includes(expected.link_task_id)) ||
        (Object.hasOwn(expected, "label") && expected.label !== null && !candidates.includes(expected.label)) ||
        (expected.insufficient_context && expected.link_task_id !== null) ||
        (expected.link_task_id !== null && expected.label !== expected.link_task_id))
      throw new Error("Examples need valid link/context labels; positive links need the same ranking label; preservation skips stay in regression");
    const hash = evidenceHash(fixture.payload);
    if (regression.has(hash)) throw new Error("Known regression evidence cannot become calibration or holdout data");
    if (evidence.has(hash)) throw new Error("Duplicate evidence in dataset, even with different identifiers or labels");
    evidence.add(hash);
    return { fixture, ...input };
  });
  const partition = name => prepared.filter(p => p.fixture.split === name);
  if (!partition("calibration").length || !partition("holdout").length) throw new Error("Both calibration and holdout partitions are required");
  return { prepared: partition(split), metadata: { schema_version: document.schema_version, name: document.name,
    provenance: document.provenance, notes: document.notes, split, manifest_sha256: digest(document),
    calibration_sha256: datasetHash(partition("calibration")), holdout_sha256: datasetHash(partition("holdout")),
    calibration_cases: partition("calibration").length, holdout_cases: partition("holdout").length } };
}

export function contextLabels(fixtures) {
  // Independent annotations of the existing regression cases; fixture bytes stay unchanged.
  const known = new Map(fixturesFor("stress").map(f => [f.id, digest(f)]));
  return Object.fromEntries(fixtures.flatMap(f => {
    if (typeof f.expected?.insufficient_context === "boolean") return [[f.id, f.expected.insufficient_context]];
    if (known.get(f.id) === digest(f)) return [[f.id, ["sparse-context", "local-repository-only"].includes(f.id)]];
    return [];
  }));
}
