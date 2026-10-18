// Explicit acceptance coordinator. Default invocation dispatches nothing.
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { embeddedConfig } from "../../src/main/embedded-config";
import { localPlanDay } from "../../src/shared/planning";
import { acceptanceGateway, ACCEPTANCE_MODEL } from "./gateway";
import { financialPreflight, reserveBatch, writeDurableRecord, completedLiability, accountedLiability, LIVE_REQUESTS, HISTORICAL_RESERVE_USD } from './admission';

const wireToolFlow = process.argv.includes('--tool-flow-repro');
const decisions = process.argv.includes('--decisions');
const finish = process.argv.includes('--finish-after-question');
const remaining = process.argv.includes('--remaining-after-read') || finish;
const recoverRead = process.argv.includes('--after-read-gate-fix') || remaining;
const decisionDirectory = finish ? 'test-results/live-decisions-finish' : remaining ? 'test-results/live-decisions-remaining' : recoverRead ? 'test-results/live-decisions-after-gate-fix' : 'test-results/live-decisions';
const live = process.argv.includes('--live'), wire = process.argv.includes('--synthetic-wire'), crash = process.argv.includes('--crash-repro'), supervisorFailure = process.argv.includes('--supervisor-failure-repro');
if (recoverRead && !decisions) throw new Error('Read recovery requires decision admission');
if (decisions && !live) throw new Error('Decision acceptance requires explicit live admission');
if (supervisorFailure && !process.env.ACD_ACCEPTANCE_OUTER_REPORT) throw new Error('Supervisor-failure repro requires the external test guardian');
if (live && ((!process.argv.includes('--small-batch') && !decisions) || !process.env.ACD_ACCEPTANCE_OUTER_REPORT || crash || supervisorFailure || wire)) throw new Error('Live requires the guarded two-forward small batch; fault modes remain synthetic only.');
if (!live && !wire) { console.log('Prepared only. Use --synthetic-wire, or separately authorized --live.'); process.exit(0); }
const root = mkdtempSync(join(tmpdir(), 'acd-app-acceptance-')); mkdirSync(join(root, 'work'));
const working = join(root, 'work');
const config = live ? embeddedConfig() : embeddedConfig({ PATH: process.env.PATH, ACD_EMBEDDED_PROVIDER: 'openrouter', ANTHROPIC_AUTH_TOKEN: 'synthetic-wire-only' });
assert.equal(config.provider, 'openrouter'); assert.equal(config.model, ACCEPTANCE_MODEL); assert.equal(config.helperModel, ACCEPTANCE_MODEL); assert.ok(!config.diagnostic);
async function accounting() {
  const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${config.env.ANTHROPIC_AUTH_TOKEN}` }, signal: AbortSignal.timeout(10000) });
  assert.equal(r.status, 200, 'Accounting unavailable; no further dispatch');
  const d = (await r.json() as any).data;
  assert.ok(d.limit > 0 && d.limit <= 20 && d.limit_remaining >= 15, 'Shared budget unavailable');
  return { usage: Number(d.usage), remaining: Number(d.limit_remaining), limit: Number(d.limit) };
}
let retainedCompletedUsd = decisions ? (finish ? 0.11 : remaining ? 0.08 : recoverRead ? 0.06 : 0.05) : 0;
let usageWatermark = finish ? JSON.parse(readFileSync('docs/embedded-live-write-question-evidence.json','utf8')).laterAccounting.usage : remaining ? JSON.parse(readFileSync('docs/embedded-live-read-success-evidence.json','utf8')).laterAccounting.usage : 0;
let admission = live ? await financialPreflight(config.env.ANTHROPIC_AUTH_TOKEN, retainedCompletedUsd, usageWatermark) : undefined;
usageWatermark = Math.max(usageWatermark,admission?.usage??0);
if (decisions) {
  const seed = JSON.parse(readFileSync('docs/embedded-live-small-batch-evidence.json','utf8'));
  const original = JSON.parse(readFileSync('test-results/live-acceptance-summary.json','utf8'));
  const reservation = JSON.parse(readFileSync('test-results/live-budget-reservation.json','utf8'));
  assert.equal(original.outcome,'passed'); assert.equal(original.gate.forwarded,2); assert.equal(original.gate.incompleteResponses,0);
  const expected = original.gate.inputTokens*Number(reservation.pricing.pricing[0].prompt)+original.gate.outputTokens*Number(reservation.pricing.pricing[0].completion);
  assert.ok(expected>0 && Math.abs(seed.laterAccounting.usage-reservation.usage-expected)<1e-10 && admission!.usage>=seed.laterAccounting.usage, 'Seed billing reconciliation unavailable');
  if (recoverRead) {
    const failed=JSON.parse(readFileSync('test-results/live-decisions-summary.json','utf8'));
    const evidence=JSON.parse(readFileSync('docs/embedded-live-decisions-first-attempt.json','utf8'));
    assert.equal(failed.outcome,'failed');assert.equal(failed.gate.forwarded,1);assert.equal(failed.gate.incompleteResponses,0);assert.equal(failed.batches.length,0);
    const charge=failed.gate.inputTokens*Number(reservation.pricing.pricing[0].prompt)+failed.gate.outputTokens*Number(reservation.pricing.pricing[0].completion);
    assert.ok(charge>0 && charge<0.01 && Math.abs(evidence.laterAccounting.usage-failed.admission.usage-charge)<1e-10 && admission!.usage>=evidence.laterAccounting.usage, 'Failed Read billing is not reconciled');
  }
  if (remaining) {
    const readProof=JSON.parse(readFileSync('docs/embedded-live-read-success-evidence.json','utf8'));
    const original=JSON.parse(readFileSync('test-results/live-decisions-after-gate-fix-summary.json','utf8'));
    assert.equal(original.gate.forwarded,2);assert.equal(original.gate.incompleteResponses,0);assert.equal(original.cases.length,1);assert.equal(original.cases[0].tool,'Read');assert.equal(original.cases[0].result,'passed');
    const cache=original.gate.receipts.reduce((n:number,r:any)=>n+r.cacheTokens,0);
    const charge=original.gate.inputTokens*Number(reservation.pricing.pricing[0].prompt)+original.gate.outputTokens*Number(reservation.pricing.pricing[0].completion)+cache*Number(reservation.pricing.pricing[0].input_cache_read);
    assert.ok(charge>0 && charge<0.02 && Math.abs(readProof.laterAccounting.usage-original.admission.usage-charge)<1e-10 && admission!.usage>=readProof.laterAccounting.usage,'Successful Read billing reconciliation unavailable');
  }
  if (finish) {
    const original=JSON.parse(readFileSync('test-results/live-decisions-remaining-summary.json','utf8'));
    const evidence=JSON.parse(readFileSync('docs/embedded-live-write-question-evidence.json','utf8'));
    const write=JSON.parse(readFileSync('test-results/live-decisions-remaining/00-completed.json','utf8'));
    assert.equal(original.cases.length,2);assert.ok(original.cases.every((c:any)=>c.result==='passed'));assert.equal(original.cases[0].tool,'Write');assert.equal(original.cases[1].tool,'AskUserQuestion');
    assert.equal(original.gate.forwarded,2);assert.equal(original.gate.incompleteResponses,0);
    const cache=original.gate.receipts.reduce((n:number,r:any)=>n+r.cacheTokens,0);
    const price=reservation.pricing.pricing[0];
    const charge=original.gate.inputTokens*Number(price.prompt)+original.gate.outputTokens*Number(price.completion)+cache*Number(price.input_cache_read);
    assert.ok(charge>0 && charge<0.02 && Math.abs(evidence.laterAccounting.usage-write.accountingProof.usageAfter-charge)<1e-10,'Question billing reconciliation unavailable');
  }
  writeDurableRecord(resolve(decisionDirectory+'/seed-reconciliation.json'),{...(recoverRead ? {failedReadObservedChargeUsd:JSON.parse(readFileSync('docs/embedded-live-decisions-first-attempt.json','utf8')).observedCumulativeUsageIncreaseUsd,failedSummarySha256:createHash('sha256').update(readFileSync('test-results/live-decisions-summary.json')).digest('hex'),failedEvidenceSha256:createHash('sha256').update(readFileSync('docs/embedded-live-decisions-first-attempt.json')).digest('hex')} : {}), retainedLiabilityUsd:retainedCompletedUsd, historicalReserveUsd:HISTORICAL_RESERVE_USD, observedCharge:expected, originalReservationSha256:createHash('sha256').update(readFileSync('test-results/live-budget-reservation.json')).digest('hex'), laterAccounting:seed.laterAccounting});
}
if (admission) reserveBatch(resolve(decisions ? decisionDirectory+'/00-reservation.json' : 'test-results/live-budget-reservation.json'), admission);
const prior = admission ?? { usage: 0, remaining: 20, limit: 20 };
let wireCommand = '';
function event(type: string, value: unknown) { return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`; }
function syntheticResponse(body: string) {
  const request = JSON.parse(body), last = request.messages.filter((m: any) => m.role === "user").at(-1), text = JSON.stringify(last);
  const tool = text.includes('controlled-effect') && !(Array.isArray(last.content) && last.content.some((b: any) => b.type === 'tool_result'));
  const id = randomUUID();
  let s = event('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: ACCEPTANCE_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  s += event('content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: randomUUID(), name: 'Bash', input: {} } : { type: 'text', text: '' } });
  s += event('content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify({ command: wireCommand, description: 'Synthetic controlled effect' }) } : { type: 'text_delta', text: 'READY' } });
  s += event('content_block_stop', { type: 'content_block_stop', index: 0 });
  s += event('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
  s += event('message_stop', { type: 'message_stop' });
  return new Response(s, { headers: { 'content-type': 'text/event-stream' } });
}
const makeGate = () => acceptanceGateway({ priorUsageUsd: (admission?.usage ?? prior.usage) + (live ? HISTORICAL_RESERVE_USD + retainedCompletedUsd : 0), ceilingUsd: prior.limit, headroomUsd: 2, reservationUsd: 0.8, maxRequests: live ? LIVE_REQUESTS : 16, maxQueries: live ? LIVE_REQUESTS : 9, maxOutputTokens: live ? 512 : 2048, maxBodyBytes: 262144, deadlineMs: 600000 },
  live ? (body, signal) => {
    const request = JSON.parse(body);
    request.provider = { only: ['deepseek'], allow_fallbacks: false, max_price: { prompt: 0.306, completion: 1.2 } };
    delete request.plugins; delete request.models; delete request.route;
    // Selected live cases are text only: no paid tool/web/image extensions.
    if (decisions) request.tools = (request.tools ?? []).filter((t:any)=>['Read','Write','AskUserQuestion','Bash'].includes(t.name));
    else request.tools = [];
    delete request.tool_choice;
    return fetch('https://openrouter.ai/api/v1/messages', { method: 'POST', headers: { Authorization: `Bearer ${config.env.ANTHROPIC_AUTH_TOKEN}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(request), signal });
  } : async body => syntheticResponse(body));
let gate = await makeGate();
let app: ElectronApplication | undefined, page: Page; let outerCleanup = false;
const summary: any = { batches: [], mode: live ? 'live-sdk-openrouter-native-app' : 'actual-sdk-synthetic-wire-native-app', model: ACCEPTANCE_MODEL, cases: [], accountingBefore: live ? prior : undefined, admission, oldReservationReconciliation: live ? 'Completed historical run evidence reconciled; entire $16 envelope plus separate $0.25 smoke reserve retained, never released on lagging usage.' : 'Not applicable: synthetic upstream, no monetary dispatch.' };
const fixture = join(working, 'effect-sink.cjs');
writeFileSync(fixture, `const fs=require('fs'),{spawn}=require('child_process'),p=require('path');const dir=__dirname,mode=process.argv[2];const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});if(mode==='post')fs.appendFileSync(p.join(dir,'effects.txt'),'post\\n',{flush:true});fs.writeFileSync(p.join(dir,'ready-'+mode+'.tmp'),JSON.stringify({pid:process.pid,child:child.pid}));fs.renameSync(p.join(dir,'ready-'+mode+'.tmp'),p.join(dir,'ready-'+mode));const file=p.join(dir,'release-'+mode);const w=fs.watch(dir,()=>{if(fs.existsSync(file)){w.close();if(mode==='pre')fs.appendFileSync(p.join(dir,'effects.txt'),'pre\\n',{flush:true});child.kill();process.exit(0)}});`);
writeFileSync(join(working, 'allowed.txt'), 'Synthetic file marker: ORCHARD_READ\n');
function state(pid: number) { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[0]; } catch { return undefined; } }
const tracked = new Map<number, string>();
function identity(pid: number) { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]; } catch { return undefined; } }
function track(pid: number, expected?: string) { const key = identity(pid); if (key && (!expected || expected === key)) tracked.set(pid, key); }
function trackTree(parent: number) {
  if (tracked.get(parent) !== identity(parent)) return;
  const parents = new Map<number, number>();
  for (const name of readdirSync('/proc')) if (/^\d+$/.test(name)) try { parents.set(Number(name), Number(readFileSync(`/proc/${name}/stat`, 'utf8').split(') ')[1].split(' ')[1])); } catch {}
  const visit = (id: number) => { for (const [pid, ppid] of parents) if (ppid === id) { track(pid); visit(pid); } }; visit(parent);
}
function terminateTracked() { for (const [pid, key] of tracked) if (identity(pid) === key && ![undefined, 'Z'].includes(state(pid))) try { process.kill(pid, 'SIGKILL'); } catch {} }
function allTrackedExited() { return [...tracked].every(([pid,key]) => identity(pid) !== key || [undefined,'Z'].includes(state(pid))); }
const watchdog = setTimeout(() => { terminateTracked(); console.error('Acceptance coordinator exceeded 8-minute limit; tracked children terminated, reservations retained.'); process.exit(1); }, 480000);
watchdog.unref();
async function launch() {
  app = await electron.launch({ args: [...(process.env.ACD_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), resolve('out-tests/native-app'), `--data-dir=${root}`],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k !== 'ELECTRON_RUN_AS_NODE' && !k.startsWith('ANTHROPIC_') && v !== undefined)) as Record<string, string>, ...config.env as Record<string, string>, ACD_HTTP_PORT: '0', ACD_EMBEDDED_CHAT: '1', ACD_EMBEDDED_PROVIDER: 'openrouter', ACD_EMBEDDED_MODEL: ACCEPTANCE_MODEL, ACD_EMBEDDED_HELPER_MODEL: ACCEPTANCE_MODEL, ACD_ACCEPTANCE_GATE_URL: gate.url, ACD_ACCEPTANCE_GATE_TOKEN: gate.token } });
  track(app.process().pid!);
  page = await app.firstWindow();
}
const read = async (chatId: string) => (await page.evaluate(chatId => window.deck.embedded({ type: 'read', chatId }), chatId)).chat!;
async function send(chatId: string, text: string, tool?: string, effect?: 'pre'|'post', expected = 'READY', duplicate = false) {
  const priorAssistantCount = (await read(chatId)).events.filter(e => e.kind === 'assistant').length;
  const priorModels = live ? await app!.evaluate(() => (globalThis as any).acdLiveAcceptance.models.length) : 0;
  const priorCalls = duplicate ? await app!.evaluate(() => (globalThis as any).acdLiveAcceptance.calls) : 0;
  const sendId = randomUUID();
  const command = { type: 'send' as const, chatId, sendId, text };
  if (duplicate) await page.evaluate(c => Promise.all([window.deck.embedded(c),window.deck.embedded(c)]),command);
  else await page.evaluate(c => window.deck.embedded(c), command);
  if (tool) {
    await expect.poll(async () => (await read(chatId)).requests.length, { timeout: 40000 }).toBeGreaterThan(0);
    const request = (await read(chatId)).requests[0]; assert.equal(request.tool, tool, 'Unexpected tool; stop rather than retry');
    const input = JSON.parse(request.input);
    if (effect) assert.equal(input.command.trim(), wireCommand);
    if (tool === 'Read') assert.equal(input.file_path, join(working, 'allowed.txt'));
    if (tool === 'Write') { assert.equal(input.file_path,join(working,'denied.txt')); assert.ok(typeof input.content==='string' && input.content.length<64); assert.equal(input.content.trim(),'synthetic'); }
    const taskName = chatId === ids.a ? 'Synthetic acceptance A' : 'Synthetic acceptance B';
    await page.getByRole('button', { name: `Select task ${taskName}`, exact: true }).click();
    const panel = page.getByRole('region', { name: 'Embedded conversation' });
    if (tool === 'AskUserQuestion') {
      for (const q of request.questions!) await panel.getByLabel(q.question, { exact: true }).fill('A');
      await panel.getByRole('button', { name: 'Send answers', exact: true }).click();
    } else await panel.getByRole('button', { name: tool === 'Write' ? 'Deny' : 'Allow once', exact: true }).click();
  }
  if (effect) {
    await expect.poll(() => existsSync(join(working, 'ready-'+effect)), { timeout: 15000 }).toBe(true);
    const p = JSON.parse(readFileSync(join(working, 'ready-'+effect), 'utf8')); track(p.pid); track(p.child);
    gate.retireQuery(await app!.evaluate(() => (globalThis as any).acdLiveAcceptance.latestQueryId));
    if (effect === 'post') {
      const sdkRecords = await app!.evaluate(() => (globalThis as any).acdLiveAcceptance.pids);
      const sdkPids: number[] = sdkRecords.map((p: any) => p.pid);
      sdkRecords.filter((p: any) => p.startTime).forEach((p: any) => track(p.pid, p.startTime)); trackTree(app!.process().pid!);
      if (supervisorFailure) {
        const supervisorPid = await app!.evaluate(() => (globalThis as any).acdLiveAcceptance.latestSupervisorPid);
        process.kill(supervisorPid,'SIGKILL');
        await expect.poll(async () => (await read(chatId)).active, {timeout:5000}).toBe(false);
        assert.equal((await read(chatId)).state,'error');
        assert.ok(![undefined,'Z'].includes(state(p.pid)), 'Tool must still be alive to establish this unsupported product boundary');
        await assert.rejects(page.evaluate(c => window.deck.embedded(c), {type:'send' as const, chatId,sendId:randomUUID(),text:'Synthetic unsafe retry'}),/process shutdown/);
        const gone = new Promise<void>(resolve => app!.process().once('exit', () => resolve())); app!.process().kill('SIGKILL'); await gone; app=undefined;
        outerCleanup=true;
        writeFileSync(process.env.ACD_ACCEPTANCE_OUTER_REPORT!,JSON.stringify({root, processes:[...tracked].map(([pid,startTime])=>({pid,startTime})), effectCount:readFileSync(join(working,'effects.txt'),'utf8').split('\n').filter(Boolean).length}));
        summary.cases.push({tool:'Bash',effect:'post',termination:'supervisor-and-backend-SIGKILL',result:'documented-unsupported-product-boundary',toolAliveBeforeOuterCleanup:true,unsafeRetryRejected:true,effectCount:1});
        return;
      }
      app!.process().kill('SIGKILL'); await new Promise<void>(resolve => app!.process().once('exit', () => resolve())); app = undefined;
      try { await expect.poll(() => [...sdkPids, p.pid, p.child].every(pid => [undefined, 'Z'].includes(state(pid))), { timeout: 15000 }).toBe(true); }
      catch (error) { summary.crashObservation = { sdkStates: sdkPids.map(state), toolState: state(p.pid), descendantState: state(p.child), effectCount: existsSync(join(working,'effects.txt')) ? readFileSync(join(working,'effects.txt'),'utf8').split('\n').filter(Boolean).length : 0, uncertainty: 'Backend is gone; no automatic replay or verified tool-result acknowledgement' }; throw error; }
      await launch();
      assert.equal((await read(chatId)).active, false);
      assert.ok((await read(chatId)).events.some(e => e.text.includes('previous turn interrupted')));
    } else {
      if (decisions) await page.getByRole('region',{name:'Embedded conversation'}).getByRole('button',{name:'Cancel turn',exact:true}).click();
      else await page.evaluate(chatId => window.deck.embedded({ type: 'cancel', chatId }), chatId);
      await expect.poll(async () => (await read(chatId)).active, { timeout: 15000 }).toBe(false);
      await expect.poll(() => [p.pid, p.child].every(pid => [undefined, 'Z'].includes(state(pid))), { timeout: 10000 }).toBe(true);
    }
    writeFileSync(join(working, 'release-'+effect), 'release');
    assert.equal(existsSync(join(working, 'effects.txt')) ? readFileSync(join(working, 'effects.txt'), 'utf8') : '', effect === 'post' ? 'post\n' : '');
    const before = await app!.evaluate(() => (globalThis as any).acdLiveAcceptance.calls);
    await page.evaluate(c => window.deck.embedded(c), { type: 'send' as const, chatId, sendId, text });
    assert.equal(await app!.evaluate(() => (globalThis as any).acdLiveAcceptance.calls), before);
  } else {
    await expect.poll(async () => (await read(chatId)).active, { timeout: 45000 }).toBe(false);
    const done = await read(chatId);
    assert.equal(done.state, 'idle', 'SDK turn failed; no automatic retry');
    if (live) {
      const answers = done.events.filter(e => e.kind === 'assistant').slice(priorAssistantCount);
      assert.ok(answers.some(e => e.text?.includes(expected)), 'Live text output missing expected acknowledgement');
    }
  }
  const record = await app!.evaluate(() => (globalThis as any).acdLiveAcceptance);
  assert.ok(record.pids.every((p: any) => p.exited)); assert.ok(record.models.every((m: string) => m === ACCEPTANCE_MODEL));
  if (live) assert.ok(record.models.length > priorModels, 'No actual model observation for live case');
  if (duplicate) {
    assert.equal(record.calls,priorCalls+1,'Duplicate submission launched another SDK query');
    const before = record.calls; await page.evaluate(c=>window.deck.embedded(c),command);
    await page.reload(); await page.evaluate(c=>window.deck.embedded(c),command);
    assert.equal(await app!.evaluate(()=>(globalThis as any).acdLiveAcceptance.calls),before);
  }
  summary.cases.push({ duplicateSuppressed:duplicate, tool: tool ?? 'text', effect: effect ?? null, termination: effect === 'post' ? 'backend-SIGKILL-restart' : effect === 'pre' ? 'cancel' : null, result: 'passed', actualSdkProcessesExited: true });
  return command;
}
let ids: {a:string;b:string};
try {
  await launch();
  ids = await page!.evaluate(async ({ dir, day }) => {
    const result: any = {};
    for (const key of ['a','b']) {
      await window.deck.command({ type: 'createPlanItem', day, category: 'Other', name: `Synthetic acceptance ${key.toUpperCase()}` });
      const task = (await window.deck.load()).planning.items.find(t => t.name === `Synthetic acceptance ${key.toUpperCase()}`)!;
      result[key] = (await window.deck.embedded({ type: 'create', taskId: task.id, cwd: dir, name: 'Synthetic acceptance chat '+key })).chat!.chatId;
    } return result;
  }, { dir: working, day: localPlanDay() });
  if (decisions) {
    let duplicateCommand: any; let savedSession: string | undefined;
    const cases = (finish ? ['duplicate-reconnect','restart-resume','cancel-before-effect'] : remaining ? ['write-deny','question-answer','duplicate-reconnect','restart-resume','cancel-before-effect'] : ['read-allow','write-deny','question-answer','duplicate-reconnect','restart-resume','cancel-before-effect']);
    for (const [index,scenario] of cases.entries()) {
      if (index>0) {
        admission = await financialPreflight(config.env.ANTHROPIC_AUTH_TOKEN,retainedCompletedUsd,usageWatermark);
        reserveBatch(resolve(decisionDirectory+'/'+String(index).padStart(2,'0')+'-reservation.json'),admission);
        gate = await makeGate();
        await app!.evaluate((_e,{url,token})=>{process.env.ACD_ACCEPTANCE_GATE_URL=url;process.env.ACD_ACCEPTANCE_GATE_TOKEN=token;},{url:gate.url,token:gate.token});
      }
      if (scenario==='read-allow') {
        await send(ids.a,`Use Read once on ${join(working,'allowed.txt')}. Remember its synthetic marker and reply READ_OK. No other tools.`,'Read',undefined,'READ_OK');
        savedSession=(await read(ids.a)).sessionId;assert.ok(savedSession);
      } else if (scenario==='write-deny') {
        await send(ids.a,`Remember synthetic marker CLOVER_RESUME for this chat. Request Write once to ${join(working,'denied.txt')} with content exactly synthetic. If denied stop, no alternate tool, reply DENIED_OK.`,'Write',undefined,'DENIED_OK');
        assert.ok(!existsSync(join(working,'denied.txt')));
        if (remaining) { savedSession=(await read(ids.a)).sessionId; assert.ok(savedSession); }
      } else if (scenario==='question-answer') {
        await send(ids.b,'Use AskUserQuestion once to ask which synthetic option A or B to choose, then acknowledge A with ANSWER_A. No other tools.','AskUserQuestion',undefined,'ANSWER_A');
      } else if (scenario==='duplicate-reconnect') {
        duplicateCommand=await send(finish?ids.a:ids.b,finish?'Remember synthetic marker CLOVER_RESUME in this chat. Reply DUPLICATE_OK. No tools.':'Reply DUPLICATE_OK. No tools.',undefined,undefined,'DUPLICATE_OK',true);
        if (finish) {savedSession=(await read(ids.a)).sessionId;assert.ok(savedSession);}
      }
      else if (scenario==='restart-resume') {
        await app!.close();app=undefined;await launch();
        assert.equal((await read(ids.a)).sessionId,savedSession);
        await page.evaluate(c=>window.deck.embedded(c),duplicateCommand);
        assert.equal(await app!.evaluate(()=>(globalThis as any).acdLiveAcceptance.calls),0);
        await send(ids.a,finish ? 'Which synthetic marker did I ask you to remember in the previous duplicated submission? Reply only that marker. No tools.' : remaining ? 'Which synthetic marker did I explicitly ask you to remember before the denied Write? Reply only that marker. No tools.' : 'What synthetic marker did the earlier Read file contain? Reply only that marker. No tools.',undefined,undefined,remaining ? 'CLOVER_RESUME' : 'ORCHARD_READ');
        assert.equal((await read(ids.a)).sessionId,savedSession);
      } else {
        wireCommand=`node ${fixture} pre`;
        await send(ids.a,`Run this exact controlled-effect Bash command once and no other tool: ${wireCommand}. It waits for the coordinator.`,'Bash','pre');
      }
      const budget = admission!;
      let accountingProof:unknown;
      let retained: number;
      if (scenario==='cancel-before-effect') retained=budget.batchUsd;
      else {
        assert.equal(gate.ledger.incompleteResponses,0); assert.equal(gate.ledger.inFlight,0); assert.equal(gate.ledger.receipts.length,gate.ledger.forwarded);
        assert.ok(gate.ledger.receipts.every(r=>[r.inputTokens,r.outputTokens,r.cacheTokens].every(n=>Number.isSafeInteger(n)&&n>=0)&&r.inputTokens+r.cacheTokens>0));
        const price=budget.endpointPricing.pricing[0];
        const expected=gate.ledger.receipts.reduce((n,r)=>n+r.inputTokens*Number(price.prompt)+r.outputTokens*Number(price.completion)+r.cacheTokens*Number(price.input_cache_read??'0'),0);
        assert.ok(expected>0 && expected<budget.batchUsd);
        for (let poll=0;poll<12;poll++) {
          const current=await accounting(); const delta=current.usage-budget.usage;
          if (Math.abs(delta-expected)<1e-10) {accountingProof={usageBefore:budget.usage,usageAfter:current.usage,matchedChargeUsd:expected};usageWatermark=Math.max(usageWatermark,current.usage);break;}
          assert.ok(delta<=expected+1e-10,'Unmatched provider charges; retain full batch');
          if(poll<11) await new Promise(r=>setTimeout(r,2000));
        }
        assert.ok(accountingProof,'Provider bill not reconciled; retain full batch');
        retained=accountedLiability(gate.ledger.receipts,gate.ledger.forwarded,budget,accountingProof as any);
      }
      const batch={scenario,accountingProof,gate:structuredClone(gate.ledger),retainedLiabilityUsd:retained,committedUsd:budget.committedUsd,observedAccountingUsage:budget.usage};
      writeDurableRecord(resolve(decisionDirectory+'/'+String(index).padStart(2,'0')+'-completed.json'),batch);
      summary.batches.push(batch);retainedCompletedUsd+=retained;
      await gate.close();
    }
  } else if (live) {
    await send(ids.a, 'Remember synthetic marker ORCHARD_A only for this conversation. Reply READY. No tools.');
    await send(ids.b, 'Remember synthetic marker MEADOW_B only for this conversation. Reply READY. No tools.');
    const sessions = [(await read(ids.a)).sessionId, (await read(ids.b)).sessionId]; assert.ok(sessions[0] && sessions[1] && sessions[0] !== sessions[1]);
    summary.cases.push({ scenario: 'isolated-task-sessions', distinctSessionIds: true, result: 'passed' });

  } else if (wireToolFlow) {
    wireCommand="node -e \"console.log('TOOL_OK')\"";
    await send(ids.a,'Run controlled-effect command once: '+wireCommand,'Bash');
  } else await send(ids.a, 'Reply READY. No tools.');
  for (const effect of (live || wireToolFlow ? [] : crash || supervisorFailure ? ['post'] : ['pre']) as ('pre'|'post')[]) {
    wireCommand = `node ${fixture} ${effect}`;
    await send(ids.a, `Run this exact controlled-effect Bash command once and no other tool: ${wireCommand}. It intentionally waits for the acceptance coordinator.`, 'Bash', effect);
  }
  summary.outcome = 'passed';
} catch (error) {
  summary.outcome = 'failed'; summary.failure = error instanceof Error ? error.message.replaceAll(root, '[fixture]').slice(0,1000) : 'Acceptance assertion failed';
  process.exitCode = 1;
} finally {
  if (app) { trackTree(app.process().pid!); try { const record = await app.evaluate(() => (globalThis as any).acdLiveAcceptance); record.pids.filter((p: any) => p.startTime).forEach((p: any) => track(p.pid, p.startTime)); } catch {}
    await Promise.race([app.close().catch(() => {}), new Promise<void>(resolve => { const timer = setTimeout(resolve, 3000); timer.unref(); })]); }
  if (!outerCleanup) terminateTracked();
  if (outerCleanup) summary.cleanup = "Delegated to external test guardian; not product containment success";
  else try { await expect.poll(allTrackedExited, { timeout: 5000 }).toBe(true); summary.cleanup = 'All tracked processes exited or zombie awaiting PID1 reaping; no tracked live processes'; } catch { summary.cleanup = 'FAILED: tracked process still live'; process.exitCode = 1; }
  clearTimeout(watchdog);
  await gate.close(); summary.gate = gate.ledger;
  if (live) try { summary.accountingAfter = {...await accounting(),acceptedUsageWatermark:usageWatermark}; } catch { summary.accountingAfter = 'unavailable; reservations retained'; }
  const destination = resolve('test-results', decisions ? (finish ? 'live-decisions-finish-summary.json' : remaining ? 'live-decisions-remaining-summary.json' : recoverRead ? 'live-decisions-after-gate-fix-summary.json' : 'live-decisions-summary.json') : live ? 'live-acceptance-summary.json' : crash ? 'wire-crash-summary.json' : 'wire-acceptance-summary.json'); mkdirSync(resolve('test-results'), { recursive: true });
  writeFileSync(destination, JSON.stringify(summary,null,2)); console.log(JSON.stringify(summary)); if (!outerCleanup) rmSync(root,{recursive:true,force:true});
}
