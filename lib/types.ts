export type Provider = "codex" | "claude" | "grok" | "gemini" | "agy" | "muse";
export const providerNames: Record<Provider, string> = {
  codex: "ChatGPT · Codex",
  claude: "Claude Code",
  grok: "Grok",
  gemini: "Gemini CLI",
  agy: "Antigravity · agy",
  muse: "Muse Code",
};
export type TaskStatus = "queued" | "running" | "done" | "blocked";
export type Intent = "status" | "create_task" | "unknown";
export interface Project {
  id: string;
  name: string;
  path: string;
  aliases: string[];
  createdAt: string;
}
export interface Task {
  id: string;
  title: string;
  provider: Provider;
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
}
export interface Snapshot {
  projects: Project[];
  tasks: Task[];
  messages: Message[];
  warnings: string[];
  config: {
    jevConfigured: boolean;
    demo: boolean;
    codex: boolean;
    claude: boolean;
    grok: boolean;
    gemini: boolean;
    agy: boolean;
    muse: boolean;
  };
}
export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt?: number;
  windowDurationMins?: number;
}
export interface ProviderInfo {
  id: string;
  name: string;
  runnable: boolean;
  installed: boolean;
  detail: string;
  url?: string;
  windows: UsageWindow[];
  usageSource?: string;
  usageError?: string;
  checkedAt?: string;
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
