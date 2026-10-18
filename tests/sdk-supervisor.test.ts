import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, fork, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
function state(pid: number) { try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[0]; } catch { return undefined; } }
async function ready(file: string) {
  if (existsSync(file)) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error("Fixture readiness deadline")); }, 4000);
    const watcher = watch(join(file, ".."), () => { if (existsSync(file)) { clearTimeout(timer); watcher.close(); resolve(); } });
    if (existsSync(file)) { clearTimeout(timer); watcher.close(); resolve(); }
  });
}
for (const boundary of ["lifetime EOF", "SIGTERM", "SDK root exit", "closed startup channel", "blocked protocol output", "supervisor SIGKILL"]) test(`Linux subreaper contains detached adopted descendant after ${boundary}`, { skip: process.platform !== "linux", timeout: 8000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "acd-supervisor-"));
  const marker = join(dir, "ready"), effect = join(dir, "effect"), release = join(dir, "release");
  // The intermediate parent exits before the gate, so ancestry polling cannot
  // discover this descendant through the SDK root. Subreaper adoption must.
  const grandchild = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(marker+".tmp")},String(process.pid));fs.renameSync(${JSON.stringify(marker+".tmp")},${JSON.stringify(marker)});const w=fs.watch(${JSON.stringify(dir)},()=>{if(fs.existsSync(${JSON.stringify(release)})){fs.writeFileSync(${JSON.stringify(effect)},'forbidden');process.exit(0)}});`;
  const intermediate = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'}).unref();`;
  const script = join(dir, "sdk.cjs");
  writeFileSync(script, `process.title='owned)\\nchild';require('child_process').spawn(process.execPath,['-e',${JSON.stringify(intermediate)}],{stdio:'ignore'});process.stdin.on('data',()=>process.exit(0));setInterval(()=>{},1000);${boundary === "blocked protocol output" ? "process.stdout.write('x'.repeat(1048576));" : ""}`);
  const helper = spawn(resolve(boundary === "closed startup channel" ? "out-tests/sdk-supervisor-test" : "out/sdk-supervisor"), [String(process.pid), process.execPath, script], {
    env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", ...(boundary === "closed startup channel" ? ["pipe" as const] : [])],
  });
  for (const stream of helper.stdio) stream?.on("error", () => {});
  helper.stderr!.resume(); if (boundary !== "blocked protocol output") helper.stdout!.resume();
  let report = ""; helper.stdio[4]!.on("data", (part: Buffer) => { report += part.toString(); });
  const exit = once(helper, "exit"); let descendant = 0;
  t.after(async () => {
    if (helper.exitCode === null && helper.signalCode === null) { helper.kill("SIGTERM"); await exit; }
    if (descendant && ![undefined,"Z"].includes(state(descendant))) { process.kill(descendant,"SIGKILL"); assert.fail("Supervisor left fixture descendant alive"); }
    rmSync(dir, { recursive:true, force:true });
  });
  await ready(marker); descendant = Number(readFileSync(marker,"utf8"));
  // Wait for adoption deterministically: intermediate exit is a real process
  // event, not a delay used to manufacture the cancellation ordering.
  const deadline = Date.now()+3000;
  while (Number(readFileSync(`/proc/${descendant}/stat`,"utf8").split(") ")[1].split(" ")[1]) !== helper.pid) {
    assert.ok(Date.now()<deadline,"Detached child was not adopted by this helper"); await new Promise<void>(resolve=>setImmediate(resolve));
  }
  if (boundary === "supervisor SIGKILL") helper.kill("SIGKILL");
  else if (boundary === "SIGTERM") helper.kill("SIGTERM");
  else if (boundary === "SDK root exit") helper.stdin!.write("exit");
  else {
    helper.stdio[3]!.destroy();
    if (boundary === "closed startup channel") { helper.stdio[4]!.destroy(); ((helper.stdio as unknown as Writable[])[5]).end("release"); }
  }
  await exit;
  if (boundary === "supervisor SIGKILL") {
    const root = Number(report.trim().split(" ")[1]); const deadline=Date.now()+2000;
    while (![undefined,"Z"].includes(state(root)) && Date.now()<deadline) await new Promise<void>(resolve=>setImmediate(resolve));
    assert.ok([undefined,"Z"].includes(state(root)), "Parent-death signal must terminate SDK root");
    assert.ok(![undefined,"Z"].includes(state(descendant)), "Documented boundary: killing supervisor can leave an already adopted tool alive");
    process.kill(descendant,"SIGKILL");
    while (![undefined,"Z"].includes(state(descendant))) { assert.ok(Date.now()<deadline+2000); await new Promise<void>(resolve=>setImmediate(resolve)); }
    t.diagnostic("Supervisor SIGKILL is outside backend-death containment; owned escaped fixture explicitly terminated"); return;
  }
  assert.equal(state(descendant),undefined,"Subreaper must reap adopted descendants before exit");
  writeFileSync(release,"release"); assert.equal(existsSync(effect),false);
});
test("Linux supervisor fails closed when SDK executable cannot start", { skip:process.platform!=="linux", timeout:5000 }, async () => {
  const helper = spawn(resolve("out/sdk-supervisor"), [String(process.pid), "/nonexistent-acd-synthetic-executable"], { stdio:["pipe","pipe","pipe","pipe","pipe"] });
  (helper.stdio[4] as Readable).resume();
  const [code] = await once(helper,"exit"); assert.equal(code,127);
});

for (const owner of ["1", "invalid", "99999999999999999999999"]) test(`Linux supervisor refuses invalid or unrelated owner ${owner}`, { skip:process.platform!=="linux", timeout:5000 }, async () => {
  const helper=spawn(resolve("out/sdk-supervisor"), [owner,process.execPath,"-e","process.exit(99)"],{stdio:["pipe","pipe","pipe","pipe","pipe"]});
  const [code]=await once(helper,"exit"); assert.equal(code,125);
});

test("backend death between owner validation and pidfd acquisition never dispatches SDK", {skip:process.platform!=="linux", timeout:5000}, async t=>{
  const dir=mkdtempSync(join(tmpdir(),"acd-owner-race-")), marker=join(dir,"forbidden"), script=join(dir,"backend.cjs");
  writeFileSync(script, `const p=require('child_process').spawn(${JSON.stringify(resolve("out-tests/sdk-supervisor-owner-test"))},[String(process.pid),process.execPath,'-e',${JSON.stringify("require('fs').writeFileSync("+JSON.stringify(marker)+",'forbidden')")}],{stdio:['pipe','pipe','pipe','pipe','pipe','pipe']});p.stdio[4].once('data',()=>process.send({helper:p.pid}));`);
  const backend=fork(script,[],{execPath:process.execPath,execArgv:[],env:{PATH:process.env.PATH,ELECTRON_RUN_AS_NODE:"1"},stdio:["ignore","ignore","ignore","ipc"]});
  let helper=0;
  t.after(()=>{if(backend.exitCode===null&&backend.signalCode===null)backend.kill("SIGKILL");if(helper&&![undefined,"Z"].includes(state(helper)))process.kill(helper,"SIGKILL");rmSync(dir,{recursive:true,force:true});});
  const [m]=await once(backend,"message"); helper=(m as any).helper;
  const exited=once(backend,"exit");backend.kill("SIGKILL");await exited;
  const deadline=Date.now()+2000;
  while(![undefined,"Z"].includes(state(helper))){assert.ok(Date.now()<deadline,"Guardian bound to a replacement parent");await new Promise<void>(resolve=>setImmediate(resolve));}
  assert.equal(existsSync(marker),false);
});
