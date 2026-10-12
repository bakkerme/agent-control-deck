// OpenRouter SystemOne API: fixed Jev model, synthetic evidence only.
export const JEV_ENDPOINT = "https://openrouter.ai/api/v1/systemone";
export const JEV_MODEL = "typesafe/jev-1.13";

export async function requestJev(request, { apiKey, fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  if (!apiKey?.trim()) throw new Error("Set OPENROUTER_API_KEY in the environment or --env-file before selecting jev");
  let response;
  try {
    response = await fetchImpl(JEV_ENDPOINT, { method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, model: JEV_MODEL }), signal: AbortSignal.timeout(timeoutMs) });
  } catch { throw new Error("Jev network request failed or timed out; no retry was made"); }
  // Provider error bodies are intentionally excluded from logs: they may echo credentials.
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Jev HTTP ${response.status}; no retry was made`); }
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  for (;;) {
    let next;
    try { next = await reader.read(); } catch { throw new Error("Jev response stream failed; no retry was made"); }
    const { done, value } = next; if (done) break;
    size += value.byteLength;
    if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("Jev response exceeded 2 MiB"); }
    chunks.push(value);
  }
  let raw;
  try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Jev returned invalid JSON"); }
  if (!/^typesafe\/jev-1\.13(?:-\d{8})?$/.test(raw.model ?? "")) throw new Error("Jev returned an unexpected or missing model identity");
  if (raw.provider && raw.provider !== "TypeSafe") throw new Error("Jev returned an unexpected provider");
  // Retain only the documented response fields, never headers or arbitrary echoed request data.
  return { id: raw.id, model: raw.model, provider: raw.provider, answers: raw.answers, usage: raw.usage };
}

export async function runJev(jobs, { apiKey, repeat = 1, checkpoint = async () => {}, fetchImpl, timeoutMs } = {}) {
  const raw = { runtime: { device: "remote", endpoint: JEV_ENDPOINT, requested_model: JEV_MODEL,
    latency_scope: "end-to-end HTTP; server cold/warm state unknown" }, results: [], warmups: [] };
  await checkpoint(raw);
  for (let iteration = 1; iteration <= repeat; iteration++) for (const job of jobs) {
    const row = { case: job.case, iteration, temperature: "remote" }, started = performance.now();
    try { row.raw = await requestJev(job.request, { apiKey, fetchImpl, timeoutMs }); }
    catch (error) { row.error = error.message; }
    row.latency_ms = Math.round((performance.now() - started) * 1000) / 1000;
    raw.results.push(row); await checkpoint(raw);
    console.log(`[jev] Measured ${job.case} #${iteration}: ${row.latency_ms} ms${row.error ? `; ${row.error}` : ""}`);
    // Stop on an HTTP/transport/protocol failure, retaining the checkpoint and unrun cases.
    if (row.error) { raw.error = row.error; return raw; }
  }
  return raw;
}
