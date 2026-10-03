export type Provider = "codex" | "claude" | "grok" | "agy" | "muse";
export const providerNames: Record<Provider, string> = {
  codex: "ChatGPT · Codex",
  claude: "Claude Code",
  grok: "Grok",
  agy: "Antigravity · agy",
  muse: "Muse Code",
};
export type TaskStatus = "queued" | "running" | "done" | "blocked";
export type Intent = "status" | "create_task" | "unknown";
export type RoutingProvider = "jev" | "clef";
export type Effort =
  | "default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";
export interface WorkerSelection {
  provider: Provider;
  model: string;
  effort: Effort;
}
export interface ModelRef {
  provider: Provider;
  model: string;
}
export interface RoutingRule extends ModelRef {
  when: string;
}
export interface RoutingPreferences {
  enabledModels: ModelRef[];
  usageAware: boolean;
  minRemainingPercent: number;
  instructions: string;
  rules: RoutingRule[];
}
export type RoutingPreferenceChange =
  | { operation: "model"; provider: Provider; model: string; enabled: boolean }
  | { operation: "models"; models: ModelRef[]; enabled: boolean }
  | { operation: "usage"; enabled: boolean }
  | { operation: "rules"; instructions: string; rules: RoutingRule[] }
  | { operation: "reserve"; minRemainingPercent: number };
export interface WorkerModel {
  id: string;
  name: string;
  description: string;
  efforts: Effort[];
  defaultEffort: Effort;
}
export interface WorkerCandidate extends WorkerSelection {
  id: string;
  description: string;
  windows: UsageWindow[];
  usageStale: boolean;
}
export interface Project {
  id: string;
  kind?: "general";
  name: string;
  path: string;
  aliases: string[];
  description?: string;
  createdAt: string;
}
export interface Task {
  id: string;
  title: string;
  provider: Provider;
  model?: string;
  effort?: Effort;
  status: TaskStatus;
  threadId?: string;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  projectId: string;
  projectName: string;
}
export interface TaskDetail extends Task {
  body: string;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  projectId?: string;
  intent?: Intent | "worker_completed" | "worker_failed";
}
export interface Routing {
  projectId: string;
  intent: Intent;
  confidence: number;
  worker?: WorkerSelection;
  workerConfidence?: number;
}
export interface Snapshot {
  projects: Project[];
  tasks: Task[];
  messages: Message[];
  warnings: string[];
  config: {
    routingProvider: RoutingProvider | null;
    routingConfigured: boolean;
    demo: boolean;
    projectPathBase: string;
    routingPreferences: RoutingPreferences;
    codex: boolean;
    claude: boolean;
    grok: boolean;
    agy: boolean;
    muse: boolean;
  };
}
export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt?: number;
  windowDurationMins?: number;
  model?: string;
  /** Exact models sharing this quota, when supplied by a native adapter. */
  models?: string[];
}
export interface ProviderInfo {
  id: Provider;
  name: string;
  runnable: boolean;
  installed: boolean;
  detail: string;
  url?: string;
  windows: UsageWindow[];
  usageSource?: string;
  usageError?: string;
  checkedAt?: string;
  models: WorkerModel[];
  modelsError?: string;
  usageStale?: boolean;
  usageSummary?: {
    lifetimeTokens?: number;
    peakDailyTokens?: number;
    currentStreakDays?: number;
  };
}
export type ApprovalAction =
  | { kind: "archive_task"; projectId: string; taskId: string }
  | { kind: "remove_project"; projectId: string }
  | { kind: "clear_history" };
export interface Approval {
  id: string;
  description: string;
  expiresAt: string;
  confirmation: string;
}
