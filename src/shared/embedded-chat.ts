import { z } from "zod";
import { idSchema } from "./validation";
export const embeddedCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status") }).strict(),
  z.object({ type: z.literal("list"), taskId: idSchema }).strict(),
  z.object({ type: z.literal("read"), chatId: idSchema }).strict(),
  z.object({ type: z.literal("create"), taskId: idSchema, cwd: z.string().min(1).max(4000), name: z.string().trim().min(1).max(200) }).strict(),
  z.object({ type: z.literal("send"), chatId: idSchema, sendId: z.string().uuid(), text: z.string().trim().min(1).max(30000) }).strict(),
  z.object({ type: z.literal("cancel"), chatId: idSchema }).strict(),
  z.object({ type: z.literal("decide"), chatId: idSchema, requestId: idSchema, allow: z.boolean(), answers: z.record(z.string().max(300), z.string().max(4000)).optional() }).strict(),
]);
export type EmbeddedCommand = z.infer<typeof embeddedCommandSchema>;
export interface EmbeddedEvent { id: string; kind: "user" | "assistant" | "tool" | "notice" | "error"; text: string; at: string }
export interface EmbeddedQuestion { question: string; header: string; options: { label: string; description?: string }[]; multiSelect?: boolean }
export const questionsSchema = z.array(z.object({ question: z.string().max(4000), header: z.string().max(300), options: z.array(z.object({ label: z.string().max(300), description: z.string().max(1000).optional() })).max(20), multiSelect: z.boolean().optional() })).min(1).max(10);
export interface EmbeddedRequest { id: string; tool: string; input: string; questions?: EmbeddedQuestion[] }
export interface EmbeddedChat { chatId: string; name: string; cwd: string; sessionId: string | null; state: string; events: EmbeddedEvent[]; requests: EmbeddedRequest[]; active: boolean }
export interface EmbeddedReply { enabled: boolean; configured: boolean; authMode: "claude-code" | "api-key"; chats?: EmbeddedChat[]; chat?: EmbeddedChat }
