import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {mkdtempSync,mkdirSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {LocalMatcher,localPython,localEnvironment} from "../src/main/local-matcher";
import {localOutput,localRequest} from "../src/shared/local-matching";
import type {MatchPayload} from "../src/shared/chat-matching";
import {removeFixture} from "./fixture-cleanup";
const payload:MatchPayload={schema_version:"chat_task_match.v1",plan_day:"2026-10-12",tasks:[{id:"a",title:"One",notes:"",day_note:"",ticket_keys:[]}],chat:{id:"chat",title:"",repository:null,latest_round:{prompt:"One",response:"",truncated:false}}};
test("Windows Python paths and clean worker environment preserve OS essentials, not secrets",()=>{
  assert.equal(localPython("folder with spaces","kai","win32"),join("folder with spaces",".venvs","kai","Scripts","python.exe"));
  const env=localEnvironment({PATH:"system-path",SystemRoot:"C:/Windows",OPENROUTER_API_KEY:"private",PYTHONPATH:"injected",NODE_OPTIONS:"injected",HF_TOKEN:"secret"});
  assert.equal(env.SystemRoot,"C:/Windows");assert.equal(env.PATH,"system-path");
  assert.equal(env.OPENROUTER_API_KEY,undefined);assert.equal(env.PYTHONPATH,undefined);assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.HF_TOKEN,undefined);
  assert.equal(env.HF_HUB_OFFLINE,"1");assert.equal(env.CUDA_VISIBLE_DEVICES,"");
});
test("native distributions reject missing or invalid choices rather than infer a probability",()=>{
  const raw={answers:{task:{type:"choice",probabilities:{candidate_0:.7,no_match:.3}},context:{type:"choice",probabilities:{sufficient:.5,insufficient:.5}}}};
  assert.equal(localOutput(raw,payload,"kai").output.insufficient_context,false);
  assert.equal(localRequest(payload).state.request,"One");
  assert.throws(()=>localOutput({...raw,answers:{...raw.answers,task:{type:"choice",probabilities:{candidate_0:1}}}},payload,"kai"));
});
test("production concise adapter exactly matches the evaluated portable adapter",()=>{
  const code=`import {portableRequest} from './scripts/chat-task-eval/benchmark-core.mjs';console.log(JSON.stringify(portableRequest(${JSON.stringify(payload)},'concise')));`;
  const run=spawnSync(process.execPath,["--input-type=module","-e",code],{encoding:"utf8",env:{...process.env,ELECTRON_RUN_AS_NODE:"1"}});
  assert.equal(run.status,0,run.stderr);assert.deepEqual(localRequest(payload),JSON.parse(run.stdout));
});
test("resident protocol reuses one worker, records cold first call and cancels only the owned worker",async t=>{
  const root=mkdtempSync(join(tmpdir(),"acd local worker "));
  const python=localPython(root,"kai");mkdirSync(join(python,".."),{recursive:true});writeFileSync(python,"");writeFileSync(join(root,"kai.provenance.json"),"{}");
  const script=join(root,"fake.cjs");
  writeFileSync(script,`console.log(JSON.stringify({ready:true,startup_ms:20}));let cold=true;require('readline').createInterface({input:process.stdin}).on('line',line=>{const {id}=JSON.parse(line);console.log(JSON.stringify({id,cold,inference_ms:10,cpu_ms:20,peak_rss_bytes:1000,raw:{answers:{task:{type:'choice',probabilities:{candidate_0:.7,no_match:.3}},context:{type:'choice',probabilities:{sufficient:.5,insufficient:.5}}}}}));cold=false;});`);
  let launches=0;
  const launch:typeof spawn=((_exe:unknown,_args:unknown,options:any)=>{launches++;return spawn(process.execPath,[script],{...options,env:{...options.env,ELECTRON_RUN_AS_NODE:"1"}});}) as typeof spawn;
  const client=new LocalMatcher(root,()=>{},root,launch);
  t.after(()=>{client.stop();removeFixture(root);});
  const first=await client.request(payload,"kai",4),second=await client.request(payload,"kai",4);
  assert.equal(first.cold,true);assert.equal(second.cold,false);assert.equal(launches,1);
  assert.equal(client.status("kai").state,"ready");assert.equal(client.status("kai").startupMs,20);
  client.stop();assert.equal(client.status("kai").state,"installed");
});
