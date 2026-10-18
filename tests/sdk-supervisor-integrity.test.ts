import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySdkSupervisor } from "../src/main/embedded-process";
test("Linux supervisor refuses stale, corrupt or mismatched package artifacts", {skip:process.platform!=="linux"}, () => {
  const dir=mkdtempSync(join(tmpdir(),"acd-supervisor-integrity-")), helper=join(dir,"helper");
  try {
    cpSync("out/sdk-supervisor",helper); cpSync("out/sdk-supervisor.json",helper+".json");
    const original=JSON.parse(readFileSync(helper+".json","utf8"));
    verifySdkSupervisor(helper,original.sourceSha256);
    for (const changed of [{protocol:2},{appVersion:"stale"},{sourceSha256:"different"},{sha256:"corrupt"}]) {
      writeFileSync(helper+".json",JSON.stringify({...original,...changed}));
      assert.throws(()=>verifySdkSupervisor(helper,original.sourceSha256),/integrity\/version/);
    }
    writeFileSync(helper+".json",JSON.stringify(original));
    assert.throws(()=>verifySdkSupervisor(helper,undefined),/integrity\/version/);
    writeFileSync(helper,"corrupt binary"); assert.throws(()=>verifySdkSupervisor(helper,original.sourceSha256),/integrity\/version/);
    assert.throws(()=>verifySdkSupervisor(join(dir,"missing"),original.sourceSha256));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
