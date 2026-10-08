import type { PlanningSnapshot, PlanCategory, PlanItem } from "./planning";
export const states = [
  "running",
  "idle",
  "waiting",
  "error",
  "unknown",
] as const;
export type State = (typeof states)[number];
export type Provider = "manual" | "claude" | "cursor" | "codex";
export type Environment = "native" | "wsl";
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  kind: "repo" | "custom";
  priority: boolean;
}
export interface Workspace {
  id: string;
  sourceId: string;
  projectId: string;
  path: string;
}
export interface Source {
  id: string;
  name: string;
  provider: Exclude<Provider, "manual">;
  environment: Environment;
  enabled: boolean;
  lastEventAt: string | null;
  error: string | null;
  accepted: number;
  rejected: number;
}
export interface Chat {
  id: string;
  projectId: string | null;
  // Detected repository origin; projectId alone controls current membership.
  repoProjectId: string | null;
  provider: Provider;
  sourceId: string | null;
  externalId: string | null;
  name: string;
  providerTitle: string;
  notes: string;
  jiraKey: string;
  jiraUrl: string;
  archived: boolean;
  state: State;
  lifecycle: "open" | "ended";
  preview: string;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
  subagents: Subagent[];
  backgroundTasks: BackgroundTask[];
  scheduledChecks: ScheduledCheck[];
}
export interface BackgroundObservation {
  id: string;
  state: "observed" | "unknown";
  lastEventAt: string;
}
export interface BackgroundTask extends BackgroundObservation {
  type: string;
  status: string;
  description: string;
}
export interface ScheduledCheck extends BackgroundObservation {
  schedule: string;
  recurring: boolean;
  prompt: string;
}
export interface Subagent {
  id: string;
  type: string;
  state: "running" | "unknown";
  lastEventAt: string;
}
export interface Activity {
  id: string;
  chatId: string;
  observedAt: string;
  kind: string;
  summary: string;
}
export interface Setup {
  inbox: string;
  endpoint: string;
  testCommand: string;
  config: string;
  configFile: string;
  instructions: string;
}
export interface Settings {
  jiraBaseUrl: string;
  linkRules: LinkRule[];
}
export interface LinkRule {
  domain: string;
  pathPrefix: string;
  category: string;
}
export interface ChatLink {
  id: string;
  chatId: string;
  url: string;
  label: string;
  firstSeenAt: string;
  lastSeenAt: string;
}
export interface Snapshot {
  planning: PlanningSnapshot;
  settings: Settings;
  links: ChatLink[];
  projects: Project[];
  chats: Chat[];
  sources: Source[];
  workspaces: Workspace[];
  demo: boolean;
  dataDirectory: string;
  ingestionError: string | null;
  setups: Record<string, Setup>;
}
export type Command =
  | { type: "createPlanItem"; day: string; category: PlanCategory; name: string }
  | { type: "updatePlanItem"; id: string; patch: Partial<Pick<PlanItem, "name" | "notes" | "projectId">> }
  | { type: "setPlanChats"; id: string; chatIds: string[] }
  | { type: "schedulePlanItem"; id: string; day: string; category: PlanCategory }
  | { type: "removePlanEntry"; id: string; day: string }
  | { type: "setPlanWorkedOn"; id: string; day: string; workedOn: boolean }
  | { type: "importDailyPlan"; markdown: string; sourceName: string; itemIds: (string | null)[] }
  | { type: "updateSettings"; jiraBaseUrl?: string; linkRules?: LinkRule[] }
  | { type: "createProject"; name: string; chatId?: string }
  | { type: "renameProject"; id: string; name: string }
  | { type: "setProjectPriority"; id: string; priority: boolean }
  | { type: "createChat"; projectId: string | null; name: string }
  | {
      type: "updateChat";
      id: string;
      patch: Partial<
        Pick<
          Chat,
          | "name"
          | "notes"
          | "jiraKey"
          | "jiraUrl"
          | "projectId"
          | "archived"
          | "state"
          | "lifecycle"
        >
      >;
    }
  | {
      type: "createSource";
      name: string;
      provider: Exclude<Provider, "manual">;
      environment: Environment;
    }
  | { type: "updateSource"; id: string; enabled: boolean }
  | { type: "addWorkspace"; sourceId: string; projectId: string; path: string }
  | { type: "removeWorkspace"; id: string }
  | { type: "testSource"; id: string }
  | { type: "setDemo"; enabled: boolean }
  | { type: "advanceDemo" };
export interface DeckApi {
  load(): Promise<Snapshot>;
  command(command: Command): Promise<Snapshot>;
  activity(chatId: string): Promise<Activity[]>;
  copy(text: string): Promise<void>;
  openTicket(chatId: string): Promise<void>;
  openLink(linkId: string): Promise<void>;
  onChanged(callback: () => void): () => void;
}
declare global {
  interface Window {
    deck: DeckApi;
  }
}
