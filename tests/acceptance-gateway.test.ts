import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptanceGateway, ACCEPTANCE_MODEL } from "../scripts/embedded-acceptance/gateway";
const policy = { priorUsageUsd: 0.01, ceilingUsd: 20, headroomUsd: 2, reservationUsd: 0.8, maxRequests: 2, maxQueries: 2, maxOutputTokens: 512, maxBodyBytes: 262144, deadlineMs: 10000 };
const body = { model: ACCEPTANCE_MODEL, max_tokens: 8192, messages: [{ role: "user", content: "synthetic" }] };
const response = (tool = false) => new Response(`${tool ? 'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"synthetic-tool"}}\n\n' : ""}data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" } })}\n\ndata: {"type":"message_stop"}\n\n`, { headers: { "content-type": "text/event-stream" } });
test('billing receipts require terminal usage and preserve split cache counters',async()=>{
  const start={type:'message_start',message:{usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:100}}};
  const terminal={type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:20,cache_creation_input_tokens:100}};
  const stop={type:'message_stop'};
  for(const scenario of ['valid','valid-done','intermediate','malformed','zero-input','out-of-order']) {
    const events=scenario==='zero-input'?[{type:'message_start',message:{usage:{input_tokens:0,output_tokens:0}}},{...terminal,usage:{output_tokens:20,cache_creation_input_tokens:0}},stop]:[start,...(scenario==='intermediate'?[{...terminal,delta:{stop_reason:null}},{type:'message_delta',delta:{stop_reason:'end_turn'}}]:[terminal]),...(scenario==='malformed'?['{']:[]),stop];
    const ordered = scenario==='out-of-order'?[start,stop,terminal]:scenario==='valid-done'?[...events,'[DONE]']:events;
    const gate=await acceptanceGateway(policy,async()=>new Response(ordered.map(e=>'data: '+(typeof e==='string'?e:JSON.stringify(e))+'\n\n').join('')));
    try {await status(call(gate));assert.equal(gate.ledger.receipts[0].complete,scenario.startsWith('valid'));if(scenario.startsWith('valid'))assert.equal(gate.ledger.receipts[0].cacheTokens,200);}
    finally {await gate.close();}
  }
});
test('SDK system reminders after a tool result preserve the matching continuation',async()=>{
  const gate=await acceptanceGateway(policy,async()=>response(true));
  try {
    assert.equal(await status(call(gate,body,'q')),200);
    const messages=[{role:'assistant',content:[{type:'tool_use',id:'synthetic-tool'}]},{role:'user',content:[{type:'tool_result',tool_use_id:'synthetic-tool',content:'synthetic result'}]},{role:'system',content:[{type:'text',text:'Synthetic SDK reminder'}]}];
    assert.equal(await status(call(gate,{...body,messages},'q')),200);
    assert.equal(gate.ledger.forwarded,2);
  }finally{await gate.close();}
});
function call(gate: Awaited<ReturnType<typeof acceptanceGateway>>, value: unknown = body, id = "synthetic-query", token: string = gate.token) {
  return fetch(gate.url + "/v1/messages", { method: "POST", headers: { "x-acd-acceptance": token, "x-acd-query": id }, body: typeof value === "string" ? value : JSON.stringify(value) });
}
async function status(p: Promise<Response>) { const r = await p; await r.text(); return r.status; }
test("gate clamps output, reserves actual forwards, and admits only completed tool continuations", async () => {
  const seen: any[] = [];
  const gate = await acceptanceGateway(policy, async raw => { seen.push(JSON.parse(raw)); return response(seen.length === 1); });
  try {
    assert.equal(await status(call(gate, body, "q", "wrong")), 403);
    assert.equal(await status(call(gate, { ...body, model: "fallback" }, "q")), 403);
    assert.equal(await status(call(gate, body, "q")), 200); assert.equal(seen[0].max_tokens, 512);
    assert.equal(await status(call(gate, body, "q")), 403);
    assert.equal(await status(call(gate, { ...body, metadata: "retry" }, "q")), 403);
    assert.equal(await status(call(gate, { ...body, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "synthetic-tool", content: "done" }] }] }, "q")), 200);
    assert.equal(await status(call(gate, { ...body, metadata: "changed retry" }, "q")), 403);
    assert.equal(seen.length, 2); assert.equal(gate.ledger.reservedUsd, 1.6);
  } finally { await gate.close(); }
});
test("gate refuses exhausted budget and invalid policy before dispatch", async () => {
  await assert.rejects(acceptanceGateway({ ...policy, maxRequests: 17 }, async () => response()));
  let forwards = 0;
  const gate = await acceptanceGateway({ ...policy, priorUsageUsd: 18 }, async () => { forwards++; return response(); });
  try { assert.equal(await status(call(gate)), 403); assert.equal(forwards, 0); } finally { await gate.close(); }
});
test("gate rejects malformed and oversized input without dispatch", async () => {
  let forwards = 0;
  const gate = await acceptanceGateway({ ...policy, maxBodyBytes: 256 }, async () => { forwards++; return response(); });
  try {
    for (const value of ['{', 'null', 'true', '1', '[]']) assert.equal(await status(call(gate, value)), 403);
    for (const messages of [[null],[{role:'user',content:[null]}],[{role:'other',content:'synthetic'}]]) assert.equal(await status(call(gate,{...body,messages})),403);
    assert.equal(await status(call(gate, 'x'.repeat(257))), 403);
    assert.equal(forwards, 0);
  } finally { await gate.close(); }
});
test("gate refuses concurrent dispatch using a controlled upstream barrier", async () => {
  let release!: () => void, arrived!: () => void;
  const barrier = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { arrived = r; });
  const gate = await acceptanceGateway(policy, async () => { arrived(); await barrier; return response(); });
  try {
    const first = status(call(gate)); await started;
    assert.equal(await status(call(gate, { ...body, metadata: "second" }, "q2")), 403);
    release(); assert.equal(await first, 200); assert.equal(gate.ledger.forwarded, 1);
  } finally { release(); await gate.close(); }
});
for (const failure of ["non-success", "truncated", "transport"] as const) test(`gate fails closed after ${failure}, including changed-body retry`, async () => {
  const gate = await acceptanceGateway(policy, async () => {
    if (failure === "transport") throw new Error("synthetic transport failure");
    return failure === "non-success" ? new Response("synthetic rejection", { status: 429 }) : new Response('data: {"type":"message_start"}\n\n');
  });
  try {
    await status(call(gate));
    assert.equal(await status(call(gate, { ...body, metadata: "retry" })), 403);
    assert.equal(gate.ledger.forwarded, 1); assert.equal(gate.ledger.reservedUsd, 0.8);
  } finally { await gate.close(); }
});
test("completed end-turn and explicitly retired tool queries cannot be retried with changed metadata", async () => {
  for (const tool of [false, true]) {
    const gate = await acceptanceGateway(policy, async () => response(tool));
    try {
      await status(call(gate)); if (tool) gate.retireQuery("synthetic-query");
      assert.equal(await status(call(gate, { ...body, metadata: "retry" })), 403);
      assert.equal(gate.ledger.forwarded, 1);
    } finally { await gate.close(); }
  }
});

test("expired admission uses a controlled clock, with no request or timer race", async () => {
  let now = 100;
  const gate = await acceptanceGateway(policy, async () => response(), () => now);
  try { now += policy.deadlineMs; assert.equal(await status(call(gate)), 403); assert.equal(gate.ledger.forwarded, 0); } finally { await gate.close(); }
});
