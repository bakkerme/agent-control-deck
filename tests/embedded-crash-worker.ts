// Disposable synthetic backend process. Parent kills it at a durable checkpoint.
// No SDK subprocess, inherited credential environment or provider request.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/main/store";
import { PlanningStore } from "../src/main/planning-store";
import { EmbeddedChats } from "../src/main/embedded-chat";
import { embeddedConfig } from "../src/main/embedded-config";
import { sdk } from "./embedded-fault-harness";

const [directory, stage] = process.argv.slice(2);
const store = new Store(join(directory, "workspace.sqlite"));
const parked = new Promise<never>(() => {});
let chatId: string, sendId = randomUUID(), approving = false;
const checkpoint = () => process.send!({ checkpoint: stage, chatId, sendId });
const service = new EmbeddedChats(store, directory, () => {
  if (stage !== "effect" || !chatId || approving) return;
  void service.command({ type: "read", chatId }).then(reply => {
    const request = reply.chat!.requests[0];
    if (!request || approving) return;
    approving = true;
    return service.command({ type: "decide", chatId, requestId: request.id, allow: true });
  });
}, true, async (_prompt, options) => {
  if (stage === "accepted") { checkpoint(); return parked; }
  return { close() {}, async *[Symbol.asyncIterator]() {
    yield sdk({ type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111" });
    if (stage === "effect") {
      const decision = await options.canUseTool!("Write", { file_path: "effects.txt", content: "synthetic" }, { signal: options.abortController!.signal, requestId: "synthetic", toolUseID: "synthetic" });
      if (decision?.behavior !== "allow") throw new Error("Synthetic effect was not approved");
      appendFileSync(join(directory, "effects.txt"), "committed\n", { flush: true });
    }
    checkpoint(); await parked;
  } };
}, embeddedConfig({ ACD_EMBEDDED_AUTH: "api-key", ANTHROPIC_API_KEY: "synthetic-fault-key" }));
store.command({ type: "createPlanItem", day: "2026-10-18", category: "Other", name: "Synthetic crash task" });
void service.command({ type: "create", taskId: new PlanningStore(store).items()[0].id, cwd: directory, name: "Synthetic crash chat" }).then(reply => {
  chatId = reply.chat!.chatId;
  return service.command({ type: "send", chatId, sendId, text: "Synthetic crash submission" });
});
