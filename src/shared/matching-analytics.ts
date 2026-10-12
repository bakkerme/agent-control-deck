export interface MatchingMeasurement {
  backend: "local" | "openrouter" | "bedrock";
  model: string;
  revision: string;
  adapter: string;
  policy: { likelihood: number; margin: number; context: number | null };
  threads: number | null;
  outcome: "linked" | "not-applied" | "no_match" | "uncertain" | "insufficient_context" | "stale" | "cancelled" | "error";
  inferenceMs: number | null;
  cold: boolean;
  endToEndMs: number;
  waitMs: number;
  cpuMs: number | null;
  peakRssBytes: number | null;
  candidateCount: number;
  inputChars: number;
  truncated: boolean;
  contextScore: number | null;
  topScore: number | null;
  margin: number | null;
}
export interface MatchingAnalyticsSummary {
  days: number;
  assessments: number;
  collectionIncomplete: boolean;
  chats: number;
  outcomes: Record<string, number>;
  feedback: { removed: number; manuallyLinked: number; undoRestored: number };
  configurations: { identity: string; backend: string; model: string; revision: string; adapter: string;
    threads: number | null; policy: MatchingMeasurement["policy"]; samples: number; warmSamples: number;
    inferenceP50Ms: number | null; inferenceP95Ms: number | null; endToEndP95Ms: number | null;
    waitP95Ms: number | null; peakRssBytes: number | null; cpuMs: number | null }[];
  quality: { reviewed: 0; precision: null; recall: null };
  recent: { id: string; at: string; model: string; outcome: string; inferenceMs: number | null; endToEndMs: number }[];
}
