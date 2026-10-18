// Explicit acceptance coordinator. Default invocation dispatches nothing.
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { embeddedConfig } from "../../src/main/embedded-config";
import { localPlanDay } from "../../src/shared/planning";
import { acceptanceGateway, ACCEPTANCE_MODEL } from "./gateway";

const live = process.argv.includes('--live'), wire = process.argv.includes('--synthetic-wire'), crash = process.argv.includes('--crash-repro'), supervisorFailure = process.argv.includes('--supervisor-failure-repro');
if (supervisorFailure && !process.env.ACD_ACCEPTANCE_OUTER_REPORT) throw new Error('Supervisor-failure repro requires the external test guardian');
if (live) throw new Error('Live acceptance is held pending separate budget-owner admission after native containment review.');
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
const prior = live ? await accounting() : { usage: 0, remaining: 20, limit: 20 };
if (live) {
  const r = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(10000) });
  const m = (await r.json() as any).data.find((m: any) => m.id === ACCEPTANCE_MODEL);
  const prices = [m.pricing, ...(m.pricing.overrides ?? [])];
  const worst = m.context_length * Math.max(...prices.map((p: any) => Number(p.prompt))) + m.top_provider.max_completion_tokens * Math.max(...prices.map((p: any) => Number(p.completion)));
  assert.ok(Number.isFinite(worst) && worst <= 0.8, 'Catalog-wide reservation no longer sufficient');
}
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
const gate = await acceptanceGateway({ priorUsageUsd: prior.usage, ceilingUsd: prior.limit, headroomUsd: 2, reservationUsd: 0.8, maxRequests: 16, maxQueries: 9, maxOutputTokens: 2048, maxBodyBytes: 262144, deadlineMs: 600000 },
  live ? (body, signal) => fetch('https://openrouter.ai/api/v1/messages', { method: 'POST', headers: { Authorization: `Bearer ${config.env.ANTHROPIC_AUTH_TOKEN}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body, signal }) : async body => syntheticResponse(body));
let app: ElectronApplication | undefined, page: Page; let outerCleanup = false;
const summary: any = { mode: live ? 'live-sdk-openrouter-native-app' : 'actual-sdk-synthetic-wire-native-app', model: ACCEPTANCE_MODEL, cases: [], accountingBefore: live ? prior : undefined, oldReservationReconciliation: live ? 'Requires coordinator reconciliation of historical reservations with current accounting and terminated processes before dispatch.' : 'Not applicable: synthetic upstream, no monetary dispatch.' };
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
async function send(chatId: string, text: string, tool?: string, effect?: 'pre'|'post') {
  const sendId = randomUUID();
  await page.evaluate(c => window.deck.embedded(c), { type: 'send' as const, chatId, sendId, text });
  if (tool) {
    await expect.poll(async () => (await read(chatId)).requests.length, { timeout: 40000 }).toBeGreaterThan(0);
    const request = (await read(chatId)).requests[0]; assert.equal(request.tool, tool, 'Unexpected tool; stop rather than retry');
    const input = JSON.parse(request.input);
    if (effect) assert.equal(input.command.trim(), wireCommand);
    if (tool === 'Read') assert.equal(input.file_path, join(working, 'allowed.txt'));
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
      await page.evaluate(chatId => window.deck.embedded({ type: 'cancel', chatId }), chatId);
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
  }
  const record = await app!.evaluate(() => (globalThis as any).acdLiveAcceptance);
  assert.ok(record.pids.every((p: any) => p.exited)); assert.ok(record.models.every((m: string) => m === ACCEPTANCE_MODEL));
  summary.cases.push({ tool: tool ?? 'text', effect: effect ?? null, termination: effect === 'post' ? 'backend-SIGKILL-restart' : effect === 'pre' ? 'cancel' : null, result: 'passed', actualSdkProcessesExited: true });
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
  if (live) {
    await send(ids.a, 'Remember synthetic marker ORCHARD_A only for this conversation. Reply READY. No tools.');
    await send(ids.b, 'Remember synthetic marker MEADOW_B only for this conversation. Reply READY. No tools.');
    const sessions = [(await read(ids.a)).sessionId, (await read(ids.b)).sessionId]; assert.ok(sessions[0] && sessions[1] && sessions[0] !== sessions[1]);
    await app!.close(); app = undefined; await launch();
    for (const [chatId, marker, other, session] of [[ids.a,'ORCHARD_A','MEADOW_B',sessions[0]],[ids.b,'MEADOW_B','ORCHARD_A',sessions[1]]]) {
      await send(chatId!, 'What synthetic marker did I ask you to remember? Reply only that marker. No tools.');
      const chat = await read(chatId!); assert.equal(chat.sessionId, session);
      const output = chat.events.filter(e => e.kind === 'assistant').at(-1)!.text; assert.ok(output.includes(marker!) && !output.includes(other!));
    }
    await send(ids.a, `Use Read once on ${join(working,'allowed.txt')}, then give a short acknowledgement.`, 'Read');
    await send(ids.a, `Request Write once to ${join(working,'denied.txt')} with content synthetic. If denied stop; no alternate tool.`, 'Write'); assert.ok(!existsSync(join(working,'denied.txt')));
    await send(ids.a, 'Use AskUserQuestion once to ask which synthetic option A or B to choose, then acknowledge the answer. No other tools.', 'AskUserQuestion');
  } else await send(ids.a, 'Reply READY. No tools.');
  for (const effect of (crash || supervisorFailure ? ['post'] : ['pre']) as ('pre'|'post')[]) {
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
  if (live) try { summary.accountingAfter = await accounting(); } catch { summary.accountingAfter = 'unavailable; reservations retained'; }
  const destination = resolve('test-results', live ? 'live-acceptance-summary.json' : crash ? 'wire-crash-summary.json' : 'wire-acceptance-summary.json'); mkdirSync(resolve('test-results'), { recursive: true });
  writeFileSync(destination, JSON.stringify(summary,null,2)); console.log(JSON.stringify(summary)); if (!outerCleanup) rmSync(root,{recursive:true,force:true});
}
