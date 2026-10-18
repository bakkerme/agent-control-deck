// Test coordinator backend only. Never bundled into the production application.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
export const ACCEPTANCE_MODEL = "deepseek/deepseek-v4.1-flash-1017";
export interface GatePolicy { priorUsageUsd: number; ceilingUsd: number; headroomUsd: number; reservationUsd: number; maxRequests: number; maxQueries: number; maxOutputTokens: number; maxBodyBytes: number; deadlineMs: number }
export async function acceptanceGateway(policy: GatePolicy, forward: (body: string, signal: AbortSignal) => Promise<Response>, now: () => number = Date.now) {
  if (![policy.priorUsageUsd, policy.ceilingUsd, policy.headroomUsd, policy.reservationUsd].every(Number.isFinite) || policy.priorUsageUsd < 0 || policy.ceilingUsd > 20 || policy.ceilingUsd <= 0 || policy.reservationUsd <= 0 || policy.headroomUsd < 1 || ![policy.maxRequests, policy.maxQueries, policy.maxOutputTokens, policy.maxBodyBytes, policy.deadlineMs].every(n => Number.isInteger(n) && n > 0) || policy.maxRequests > 16 || policy.maxQueries > 9 || policy.maxOutputTokens > 2048 || policy.maxBodyBytes > 262144 || policy.deadlineMs > 600000) throw new Error("Invalid acceptance policy");
  const token = randomUUID(), expires = now() + policy.deadlineMs;
  const ledger = { forwarded: 0, rejected: 0, denialReasons: {} as Record<string,number>, queries: 0, reservedUsd: 0, inFlight: 0, inputTokens: 0, outputTokens: 0, incompleteResponses: 0, receipts: [] as { complete: boolean; inputTokens: number; outputTokens: number; cacheTokens: number }[] };
  const queries = new Map<string, { requests: number; continuation: boolean; retired: boolean; toolIds: Set<string> }>();
  const bodies = new Set<string>(), controllers = new Set<AbortController>();
  let stopped = false;
  const server = createServer(async (req, res) => {
    const deny = (reason='policy') => { ledger.rejected++; ledger.denialReasons[reason]=(ledger.denialReasons[reason]??0)+1; res.writeHead(403, { "content-type": "application/json" }); res.end('{"type":"error","error":{"type":"permission_error","message":"Acceptance gate refused request; no retry permitted"}}'); };
    if (stopped || now() >= expires || req.method !== "POST" || req.url?.split("?")[0] !== "/v1/messages" || req.headers["x-acd-acceptance"] !== token || ledger.inFlight || ledger.forwarded >= policy.maxRequests) { deny(ledger.inFlight?'in-flight':stopped?'stopped':'route-auth-or-limit'); return; }
    const parts: Buffer[] = []; let length = 0;
    try { for await (const part of req) { length += part.length; if (length > policy.maxBodyBytes) { deny(); return; } parts.push(part); } } catch { stopped = true; res.destroy(); return; }
    const raw = Buffer.concat(parts).toString("utf8"), digest = createHash("sha256").update(raw).digest("hex");
    const queryId = req.headers["x-acd-query"];
    let body: any;
    try { body = JSON.parse(raw); } catch { deny(); return; }
    if (!body || typeof body !== "object" || Array.isArray(body)) { deny(); return; }
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages.some((m:any)=>!m || typeof m!=='object' || Array.isArray(m) || !['user','assistant','system'].includes(m.role) || !(typeof m.content==='string' || Array.isArray(m.content) && m.content.every((b:any)=>b && typeof b==='object' && !Array.isArray(b) && typeof b.type==='string')))) {deny('message-shape');return;}
    const priorQuery = typeof queryId === "string" ? queries.get(queryId) : undefined;
    const last = Array.isArray(body?.messages) ? body.messages.findLast((m:any)=>m.role !== 'system') : undefined;
    const results = last?.role === "user" && Array.isArray(last.content) ? last.content.filter((b: any) => b.type === "tool_result") : [];
    const validContinuation = results.length > 0 && results.every((b: any) => priorQuery?.toolIds.has(b.tool_use_id));

    if (typeof queryId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(queryId) || (queries.has(queryId) && (!validContinuation || !queries.get(queryId)!.continuation || queries.get(queryId)!.retired || queries.get(queryId)!.requests >= 2)) || (!queries.has(queryId) && queries.size >= policy.maxQueries) || body?.model !== ACCEPTANCE_MODEL || !Number.isInteger(body.max_tokens) || body.max_tokens < 1 || bodies.has(digest) || ledger.inFlight || stopped || now() >= expires || ledger.forwarded >= policy.maxRequests || policy.priorUsageUsd + ledger.reservedUsd + policy.reservationUsd + policy.headroomUsd > policy.ceilingUsd) { deny(priorQuery?!validContinuation?'tool-result-mismatch':!priorQuery.continuation?'not-tool-stop':priorQuery.retired?'retired':'query-limit':'policy'); return; }
    // Clamp before forwarding, including helper/retry/compaction attempts. The
    // reservation uses catalog-wide worst-case context/output, not this hint.
    body.max_tokens = Math.min(body.max_tokens, policy.maxOutputTokens);
    delete body.thinking;
    bodies.add(digest); queries.set(queryId, { requests: (queries.get(queryId)?.requests ?? 0) + 1, continuation: false, retired: false, toolIds: new Set() }); ledger.queries = queries.size; ledger.forwarded++; ledger.reservedUsd += policy.reservationUsd; ledger.inFlight++;
    const abort = new AbortController(); controllers.add(abort);
    const receipt = { complete: false, inputTokens: 0, outputTokens: 0, cacheTokens: 0 }; ledger.receipts.push(receipt);
    const timer = setTimeout(() => abort.abort(), Math.min(45000, expires - now()));
    let inputTokens = 0, outputTokens = 0, buffer = "", messageStopped = false, toolUse = false;
    let inputObserved = false, outputObserved = false, invalidUsage = false, cacheReadTokens = 0, cacheCreationTokens = 0;
    const usageIssues:string[]=[];
    const issue=(reason:string)=>{invalidUsage=true;if(!usageIssues.includes(reason))usageIssues.push(reason);};
    const decoder = new TextDecoder();
    res.once("close", () => { if (!res.writableEnded) { stopped = true; abort.abort(); } });
    try {
      const response = await forward(JSON.stringify(body), abort.signal);
      if (!response.ok) stopped = true;
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
      if (response.body) {
        const reader = response.body.getReader();
        try { while (true) {
          const next = await reader.read(); if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
          if (buffer.length > 131072) { issue("oversized-line"); buffer = ""; }
          for (const line of lines) if (line.startsWith("data: ")) try {
            if (line === "data: [DONE]" && messageStopped) continue;
            const value = JSON.parse(line.slice(6)), usage = value.message?.usage ?? value.usage;
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed event');
            if (messageStopped && value.type !== 'ping') issue('event-after-stop');
            if (value.type === "content_block_start" && value.content_block?.type === "tool_use" && typeof value.content_block.id === "string") queries.get(queryId)!.toolIds.add(value.content_block.id);
            if (value.type === "message_stop") { if (!outputObserved) issue('no-terminal-output'); messageStopped = true; }
            if (value.type === "message_delta") toolUse = value.delta?.stop_reason === "tool_use";
            if (usage !== undefined || Object.hasOwn(value,'usage') || Object.hasOwn(value.message ?? {},'usage')) {
              if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new Error('Malformed usage');
              for (const field of ['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens']) if (field in usage && (!Number.isSafeInteger(usage[field]) || usage[field] < 0)) issue('counter-'+field);
              if ('input_tokens' in usage) inputObserved = true;
              if (value.type === 'message_delta' && typeof value.delta?.stop_reason === 'string' && value.delta.stop_reason.length > 0 && 'output_tokens' in usage) outputObserved = true;
              inputTokens = Math.max(inputTokens, Number(usage.input_tokens) || 0); outputTokens = Math.max(outputTokens, Number(usage.output_tokens) || 0);
              cacheReadTokens = Math.max(cacheReadTokens, Number(usage.cache_read_input_tokens) || 0);
              cacheCreationTokens = Math.max(cacheCreationTokens, Number(usage.cache_creation_input_tokens) || 0);
            }
          } catch { issue('malformed-event-or-usage'); /* Never settle ambiguous usage or persist provider contents. */ }
          if (!res.write(next.value)) await new Promise<void>(resolve => {
            const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
            res.once("drain", done); res.once("close", done);
          });
          if (abort.signal.aborted) { await reader.cancel(); break; }
        } } finally { reader.releaseLock(); }
      }
      if (!messageStopped || abort.signal.aborted) stopped = true;
      if (buffer.trim()) issue('trailing-data');
      queries.get(queryId)!.continuation = response.ok && messageStopped && toolUse && !abort.signal.aborted;
      Object.assign(receipt, { complete: response.ok && messageStopped && !abort.signal.aborted && inputObserved && outputObserved && inputTokens+cacheReadTokens+cacheCreationTokens>0 && !invalidUsage, inputTokens, outputTokens, cacheTokens:cacheReadTokens+cacheCreationTokens, usageEvidence:{inputObserved,outputObserved,messageStopped,usageIssues} });
      res.end();
    } catch { stopped = true; if (!res.headersSent) res.writeHead(502); res.end(); }
    finally { clearTimeout(timer); controllers.delete(abort); ledger.inFlight--; ledger.inputTokens += inputTokens; ledger.outputTokens += outputTokens; if (abort.signal.aborted || !messageStopped) ledger.incompleteResponses++; }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Gateway did not bind");
  return { url: `http://127.0.0.1:${address.port}`, token, ledger,
    retireQuery(id: string) { const q = queries.get(id); if (q) q.retired = true; },
    async close() { stopped = true; for (const c of controllers) c.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
