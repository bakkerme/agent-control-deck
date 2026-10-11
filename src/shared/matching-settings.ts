import { z } from "zod";
import { DEFAULT_BEDROCK_MODEL, DEFAULT_BEDROCK_REGION } from "./chat-matching";
export const matchingConfigSchema = z.object({
  enabled: z.boolean(),
  backend: z.enum(["openrouter", "bedrock"]).default("openrouter"),
  bedrockRegion: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d+$/, "Use an AWS region ID").max(40).default(DEFAULT_BEDROCK_REGION),
  bedrockModel: z.string().trim().min(1).max(200).regex(/^[\w.:-]+$/, "Use a Bedrock model or system inference profile ID").default(DEFAULT_BEDROCK_MODEL),
  model: z.string().trim().min(1).max(200).regex(/^[\w./:-]+$/, "Use a valid OpenRouter model ID"),
  provider: z.string().trim().min(1).max(200).regex(/^[\w./-]+$/, "Use a valid provider ID"),
}).strict();
export const saveMatchingSchema = z.object({
  config: matchingConfigSchema,
  apiKey: z.string().trim().min(1).max(16384).regex(/^[\x21-\x7e]+$/, "Use an API key without spaces or newlines").optional(),
}).strict();
export type MatchingConfig = z.infer<typeof matchingConfigSchema>;
export type SaveMatchingInput = z.infer<typeof saveMatchingSchema>;
export interface MatchingStatus {
  config: MatchingConfig;
  keyStored: boolean;
  secureStorageAvailable: boolean;
  running: boolean;
  error: string | null;
  lastCheckedAt: string | null;
  demo: boolean;
}
