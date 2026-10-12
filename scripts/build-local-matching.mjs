import {build} from "esbuild";
import {mkdir,copyFile} from "node:fs/promises";
import {resolve,join} from "node:path";
const output=resolve("out/local-matching");
await mkdir(output,{recursive:true});
await build({entryPoints:["scripts/chat-task-eval/desktop_setup.mjs"],outfile:join(output,"setup.cjs"),
  bundle:true,platform:"node",format:"cjs",target:"node24"});
for(const file of ["desktop_worker.py","local_worker.py","bundle_download.py"])
  await copyFile(`scripts/chat-task-eval/${file}`,join(output,file));
console.log("Built local CPU matching resources");
