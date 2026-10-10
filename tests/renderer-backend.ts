import { z } from "zod";
import { WorkspaceRuntime } from "../src/main/workspace-runtime";
import { idSchema, ticketUrl } from "../src/shared/validation";
import { resolveTicketUrl } from "../src/shared/tickets";

const runtime = new WorkspaceRuntime(process.argv[2], () => process.send?.({ changed: true }), process.argv[3] === "demo");
const openedUrls: string[] = [];
const stop = () => { runtime.close(); process.exit(); };
process.on("disconnect", stop);
process.on("message", (message: { id: number; method: string; input?: unknown }) => {
  const { id, method, input } = message;
  if (method === "close") { stop(); return; }
  try {
    let value: unknown;
    switch (method) {
      case "load": value = runtime.snapshot(); break;
      case "command": value = runtime.command(input); break;
      case "activity": value = runtime.store.activity(idSchema.parse(input)); break;
      case "copy": z.string().max(100000).parse(input); break;
      case "openTicket": {
        const url = resolveTicketUrl(runtime.store.chat(idSchema.parse(input)), runtime.store.settings());
        if (url) openedUrls.push(url);
        break;
      }
      case "openLink": openedUrls.push(ticketUrl.parse(runtime.store.link(idSchema.parse(input)).url)); break;
      case "openedUrls": value = openedUrls; break;
      default: throw new Error(`Unknown test method: ${method}`);
    }
    process.send?.({ id, value });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues.map(i => i.message).join("; ") : error instanceof Error ? error.message : "Operation failed";
    process.send?.({ id, error: message });
  }
});
runtime.start().then(() => process.send?.({ ready: true })).catch(error => { console.error(error); process.exit(1); });
