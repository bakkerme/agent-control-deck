import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
for (const fixture of ["missing", "empty", "invalid birth", "duplicate"]) test(`external test guardian rejects ${fixture} required supervisor-failure evidence`, {skip:process.platform!=="linux",timeout:8000}, ()=>{
  const records=fixture==="empty"?[]:Array.from({length:3},(_,index)=>({pid:fixture==="duplicate"?123:index+123,startTime:fixture==="invalid birth"?"":"123"}));
  const source=(fixture!=="missing"?"require('fs').writeFileSync(process.env.ACD_ACCEPTANCE_OUTER_REPORT,"+JSON.stringify(JSON.stringify({processes:records}))+ ");":"")+"console.log('SYNTHETIC_COORDINATOR_COMPLETED')";

  const run=spawnSync(process.execPath,["scripts/embedded-acceptance/guard.cjs","-e",source,"--","--supervisor-failure-repro"],{env:{PATH:process.env.PATH,ELECTRON_RUN_AS_NODE:"1"},encoding:"utf8",timeout:5000});
  assert.equal(run.status,1);assert.match(run.stdout,/SYNTHETIC_COORDINATOR_COMPLETED/);assert.match(run.stderr,/External guardian acceptance failed/);
});
