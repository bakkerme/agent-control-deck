// Independent Linux test owner. This is never part of the production app.
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { createHash } = require('node:crypto');
const summaryFile=resolve('test-results/outer-acceptance-summary.json');
mkdirSync(resolve('test-results'),{recursive:true});
writeFileSync(summaryFile,JSON.stringify({outcome:'not-completed',externalGuardianCleanup:false,paidCalls:0}));
if (process.platform !== 'linux') throw new Error('External acceptance guardian requires Linux');
if (process.argv.includes('--live')) throw new Error('Paid acceptance still requires separate budget-owner admission');
const args = process.argv.slice(2);
if (!args.length) throw new Error('Pass the prepared coordinator and synthetic test arguments');
const helper = resolve('out/sdk-supervisor'), manifest = JSON.parse(readFileSync(helper+'.json','utf8'));
if (manifest.protocol !== 1 || manifest.appVersion !== require('../../package.json').version || manifest.sourceSha256 !== createHash('sha256').update(readFileSync('src/main/sdk-supervisor.c')).digest('hex') || manifest.sha256 !== createHash('sha256').update(readFileSync(helper)).digest('hex')) throw new Error('External guardian build mismatch');
let cleanupConfirmed=false;
const requireReport=args.includes('--supervisor-failure-repro');
const root=mkdtempSync(join(tmpdir(),'acd-outer-guard-')), report=join(root,'report.json');
const guardian=spawn(helper,[String(process.pid),process.execPath,...args],{env:{...process.env,ACD_ACCEPTANCE_OUTER_REPORT:report},stdio:['ignore','inherit','inherit','pipe','pipe']});
for (const stream of guardian.stdio) stream?.on?.('error',()=>{});
guardian.stdio[4].on('data',()=>{});
// Do not force-kill the cleanup owner on timeout: a signal sent is not exit.
const timeout=setTimeout(()=>{process.exitCode=1;guardian.kill('SIGTERM');},510000);timeout.unref();
for(const signal of ['SIGTERM','SIGINT','SIGHUP']) process.on(signal,()=>guardian.kill('SIGTERM'));
function identity(pid){try{return readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ')[19];}catch{return undefined;}}
function state(pid){try{return readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ')[0];}catch{return undefined;}}
(async()=>{
  try {
    const [code,signal]=await once(guardian,'exit'); clearTimeout(timeout);
    if(signal) throw new Error('External test guardian was killed; containment not confirmed');
    cleanupConfirmed=true;
    if(code!==0) process.exitCode=1;
    if(requireReport && !existsSync(report)) throw new Error('Required supervisor-failure evidence missing');
    if(existsSync(report)){
      const evidence=JSON.parse(readFileSync(report,'utf8'));
      if(!Array.isArray(evidence.processes) || evidence.processes.length<3 || evidence.processes.some(p=>!Number.isInteger(p.pid) || p.pid<=1 || typeof p.startTime!=='string' || !/^\d+$/.test(p.startTime))) throw new Error('Required process identities missing');
      if(new Set(evidence.processes.map(p=>p.pid)).size!==evidence.processes.length) throw new Error('Duplicate process identities');
      const cleaned=evidence.processes.every(p=>identity(p.pid)!==p.startTime || [undefined,'Z'].includes(state(p.pid)));
      const ledger=readFileSync(join(evidence.root,'work/effects.txt'),'utf8').split('\n').filter(Boolean).length;
      const summary={outcome:cleaned && ledger===1 && evidence.effectCount===1?'passed':'failed',productBoundary:'supervisor-and-backend-death unsupported',externalGuardianCleanup:cleaned,effectCountBefore:evidence.effectCount,effectCountAfter:ledger,automaticReplay:false,paidCalls:0};
      writeFileSync(resolve('test-results/outer-acceptance-summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
      if(!cleaned || ledger!==1 || evidence.effectCount!==1) process.exitCode=1;
      // Only remove the temporary fixture directory created by the coordinator.
      if(resolve(evidence.root).startsWith(join(tmpdir(),'acd-app-acceptance-'))) rmSync(evidence.root,{recursive:true,force:true});
    } else writeFileSync(summaryFile,JSON.stringify({outcome:code===0?'passed':'failed',externalGuardianCleanup:true,paidCalls:0}));
  } finally {clearTimeout(timeout);if(cleanupConfirmed)rmSync(root,{recursive:true,force:true});}
})().catch(()=>{writeFileSync(resolve('test-results/outer-acceptance-summary.json'),JSON.stringify({outcome:'failed',externalGuardianCleanup:cleanupConfirmed,paidCalls:0}));console.error('External guardian acceptance failed; retain budget reservations. '+(cleanupConfirmed?'Owned processes cleaned.':'Unconfirmed cleanup retains its private recovery report at '+root));process.exitCode=1;guardian.kill('SIGTERM');});
