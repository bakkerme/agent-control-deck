import { z } from "zod";

export const responseSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string().uuid(), kind: z.literal("permission"), decision: z.enum(["allow", "deny", "defer"]) }).strict(),
  z.object({ id: z.string().uuid(), kind: z.literal("question"), answers: z.array(z.union([
    z.string().trim().min(1).max(4000), z.array(z.string().min(1).max(200)).min(1).max(4),
  ])).min(1).max(4) }).strict(),
]);
export type AgentResponse = z.infer<typeof responseSchema>;
export const questionsSchema = z.array(z.object({
  question: z.string().min(1).max(2000), header: z.string().max(100),
  options: z.array(z.object({ label: z.string().min(1).max(200), description: z.string().max(4000) }).passthrough()).min(2).max(4),
  multiSelect: z.boolean().optional(),
}).passthrough()).min(1).max(4).refine(questions =>
  new Set(questions.map(q => q.question)).size === questions.length &&
  questions.every(q => new Set(q.options.map(o => o.label)).size === q.options.length), "Questions and choices must be distinct");
export type AgentQuestion = z.infer<typeof questionsSchema>[number];
export interface AgentRequest {
  id: string;
  sourceId: string;
  provider: "claude" | "codex";
  sessionId: string;
  sourceName: string;
  chatName: string;
  projectName: string;
  cwd: string;
  createdAt: string;
  expiresAt: string;
  kind: "permission" | "question";
  toolName: string;
  description: string;
  input: string;
  questions: AgentQuestion[];
}
