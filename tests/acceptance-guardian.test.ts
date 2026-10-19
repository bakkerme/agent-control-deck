import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
function runGuardian(args: string[]) {
  const project=resolve('.'), root=mkdtempSync(join(tmpdir(),'acd-guardian-negative-'));
  try {
    for(const name of ['out','src','package.json']) symlinkSync(join(project,name),join(root,name),name==='package.json'?'file':'dir');
    const run=spawnSync(process.execPath,[join(project,'scripts/embedded-acceptance/guard.cjs'),...args],{cwd:root,env:{PATH:process.env.PATH,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',timeout:5000});
    const summary=JSON.parse(readFileSync(join(root,'test-results/outer-acceptance-summary.json'),'utf8'));
    return {run,summary};
  } finally {rmSync(root,{recursive:true,force:true});}
}
for (const fixture of ["missing", "empty", "invalid birth", "duplicate"]) test(`external test guardian rejects ${fixture} required supervisor-failure evidence`, {skip:process.platform!=="linux",timeout:8000}, ()=>{
  const records=fixture==="empty"?[]:Array.from({length:3},(_,index)=>({pid:fixture==="duplicate"?123:index+123,startTime:fixture==="invalid birth"?"":"123"}));
  const source=(fixture!=="missing"?"require('fs').writeFileSync(process.env.ACD_ACCEPTANCE_OUTER_REPORT,"+JSON.stringify(JSON.stringify({processes:records}))+ ");":"")+"console.log('SYNTHETIC_COORDINATOR_COMPLETED')";

  const {run}=runGuardian(["-e",source,"--","--supervisor-failure-repro"]);
  assert.equal(run.status,1);assert.match(run.stdout,/SYNTHETIC_COORDINATOR_COMPLETED/);assert.match(run.stderr,/External guardian acceptance failed/);
});
test('failed live coordinator never reports zero paid requests', {skip:process.platform!=="linux",timeout:8000}, () => {
  const {run,summary}=runGuardian(['-e',"process.exitCode=1",'--','--live','--small-batch']);
  assert.equal(run.status,1);
  assert.equal(summary.outcome,'failed'); assert.notEqual(summary.paidCalls,0);
});
