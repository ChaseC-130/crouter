"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  Command,
  ExternalLink,
  Folder,
  GitBranch,
  LayoutDashboard,
  Loader2,
  Menu,
  Maximize2,
  Minimize2,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  X,
  AlertCircle,
  Archive,
  RotateCcw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ModelPicker } from "./model-picker";
import { RoutingRules } from "./routing-rules";
import { ThemeSelect } from "./theme-select";
import { RouterMessages } from "./router-messages";
import { providerNames } from "@/lib/types";
import {
  defaultRoutingPreferences,
  applyRoutingPreference,
} from "@/lib/routing-policy";
import type {
  ProviderInfo,
  Project,
  Snapshot,
  Task,
  TaskDetail,
  Provider,
  Approval,
  ApprovalAction,
  TaskStatus,
  RoutingPreferences,
  RoutingPreferenceChange,
} from "@/lib/types";
const statusNames: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  blocked: "Blocked",
};
const statusIcons: Record<TaskStatus, LucideIcon> = {
  queued: Clock3,
  running: Loader2,
  done: CheckCircle2,
  blocked: AlertCircle,
};
const colors = ["green", "purple", "orange", "blue"];
async function api<T>(
  url: string,
  body?: unknown,
  method: "POST" | "PATCH" = "POST",
): Promise<T> {
  const response = await fetch(
    url,
    body
      ? {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-Crouter-Request": "1",
          },
          body: JSON.stringify(body),
        }
      : { cache: "no-store" },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error || "The local server could not complete this request.",
    );
  return data;
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null),
    closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    root
      ?.querySelector<HTMLElement>("input, button, textarea, select")
      ?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") closeRef.current();
      if (event.key === "Tab" && root) {
        const nodes = Array.from(
          root.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary",
          ),
        ).filter((node) => node.getClientRects().length > 0);
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "modal-wide" : ""}`}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Badge({ status }: { status: TaskStatus }) {
  const Icon = statusIcons[status];
  return (
    <span className={`status-badge ${status}`}>
      <Icon size={12} className={status === "running" ? "spin" : ""} />
      {statusNames[status]}
    </span>
  );
}
function timeString(value: string) {
  return new Date(value).toLocaleTimeString();
}
function ProviderMark({ provider }: { provider: Provider }) {
  return (
    <span className={`provider-mark ${provider}`}>
      {provider === "codex" ? <Code2 size={13} /> : <Sparkles size={13} />}
    </span>
  );
}
export function Workspace() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [input, setInput] = useState(""),
    [routingProject, setRoutingProject] = useState("auto"),
    [chatExpanded, setChatExpanded] = useState(false),
    [composerExpanded, setComposerExpanded] = useState(false),
    [editingProject, setEditingProject] = useState<Project | null>(null),
    [description, setDescription] = useState(""),
    [provider, setProvider] = useState<Provider | "auto">("auto"),
    [sending, setSending] = useState(false),
    [tab, setTab] = useState<"workspace" | "tasks">("workspace"),
    [projectFilter, setProjectFilter] = useState("all"),
    [status, setStatus] = useState("all"),
    [query, setQuery] = useState(""),
    [sidebarOpen, setSidebarOpen] = useState(false),
    [adding, setAdding] = useState(false),
    [settings, setSettings] = useState(false),
    [detail, setDetail] = useState<TaskDetail | null>(null),
    [detailLoading, setDetailLoading] = useState(false),
    [approval, setApproval] = useState<Approval | null>(null),
    [approving, setApproving] = useState(false),
    [busyTask, setBusyTask] = useState(""),
    [name, setName] = useState(""),
    [projectPath, setProjectPath] = useState(""),
    [resolvedPath, setResolvedPath] = useState(""),
    [pathError, setPathError] = useState(""),
    [aliases, setAliases] = useState(""),
    [saving, setSaving] = useState(false),
    [notice, setNotice] = useState(""),
    [providerInfo, setProviderInfo] = useState<ProviderInfo[]>([]),
    [usageLoading, setUsageLoading] = useState(false);
  const [preferencesSaving, setPreferencesSaving] = useState(false),
    [preferencesError, setPreferencesError] = useState(""),
    [reserveInput, setReserveDraft] = useState<string | null>(null);
  const preferenceQueue = useRef(Promise.resolve());
  const pendingPreferences = useRef(0);
  const preferenceRevision = useRef(0);
  const providerRequest = useRef(false);
  const contextRequests = useRef(new Map<string, number>());
  const bottom = useRef<HTMLDivElement>(null),
    textArea = useRef<HTMLTextAreaElement>(null);
  const latestMessageId = snapshot?.messages.at(-1)?.id;
  const refresh = useCallback(async () => {
    const revision = preferenceRevision.current;
    const wasSaving = pendingPreferences.current > 0;
    try {
      const next = await api<Snapshot>("/api/snapshot");
      setSnapshot((current) =>
        (wasSaving ||
          pendingPreferences.current ||
          revision !== preferenceRevision.current) &&
        current
          ? {
              ...next,
              config: {
                ...next.config,
                routingPreferences: current.config.routingPreferences,
              },
            }
          : next,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const interval = setInterval(() => void refresh(), 7000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [refresh]);
  useEffect(() => {
    if (
      !snapshot?.config.routingConfigured ||
      !snapshot.config.routingPreferences.enabledModels.length
    )
      return;
    // Backfill existing projects one at a time. The host also guards every job with a lease.
    for (const p of snapshot.projects)
      if (p.contextStatus === "generating")
        contextRequests.current.delete(p.id);
    if (snapshot.projects.some((p) => p.contextStatus === "generating")) return;
    const pending = snapshot.projects.find(
      (p) =>
        p.kind !== "general" &&
        !p.description?.trim() &&
        p.contextStatus !== "error" &&
        Date.now() - (contextRequests.current.get(p.id) || 0) > 30000,
    );
    if (!pending) return;
    contextRequests.current.set(pending.id, Date.now());
    void api("/api/projects/context", { projectId: pending.id })
      .then(() => refresh())
      .catch((e) => setError((e as Error).message));
  }, [snapshot, refresh]);
  useEffect(() => {
    // assistant-ui adopts external messages in an effect; scroll after its next paint.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const feed = bottom.current?.parentElement;
        feed?.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [latestMessageId, sending, tab]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!adding || editingProject || !projectPath.trim()) return;
    let active = true;
    const timer = setTimeout(() => {
      api<{ path: string }>(
        `/api/projects?${new URLSearchParams({ path: projectPath })}`,
      )
        .then((result) => {
          if (active) {
            setResolvedPath(result.path);
            setPathError("");
          }
        })
        .catch((e) => {
          if (active) {
            setResolvedPath("");
            setPathError((e as Error).message);
          }
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [adding, editingProject, projectPath]);
  const projects = snapshot?.projects || [],
    tasks = snapshot?.tasks || [],
    messages = snapshot?.messages || [];
  const routingProvider = snapshot?.config.routingProvider;
  const preferences =
    snapshot?.config.routingPreferences || defaultRoutingPreferences;
  const reserveDraft = reserveInput ?? String(preferences.minRemainingPercent);
  const routingName =
    routingProvider === "clef"
      ? "Clef"
      : routingProvider === "jev"
        ? "JEV"
        : "Router";
  const filtered = tasks.filter(
    (t) =>
      (projectFilter === "all" || t.projectId === projectFilter) &&
      (status === "all" || t.status === status) &&
      `${t.title} ${t.id} ${t.projectName} ${t.provider} ${t.model || ""} ${t.effort || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  async function send(text = input) {
    if (!text.trim() || sending) return;
    setError("");
    setSending(true);
    setInput("");
    try {
      await api("/api/chat", {
        turn: text,
        provider,
        ...(routingProject !== "auto" ? { projectId: routingProject } : {}),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await refresh();
      setSending(false);
      textArea.current?.focus();
    }
  }
  function showProjectEditor(project?: Project) {
    setEditingProject(project || null);
    setName(project?.name || "");
    setProjectPath(project?.path || "");
    setAliases(project?.aliases.join(", ") || "");
    setDescription(project?.description || "");
    setResolvedPath("");
    setPathError("");
    setError("");
    setAdding(true);
  }
  async function addProject(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api(
        "/api/projects",
        {
          name,
          description,
          ...(editingProject
            ? { id: editingProject.id }
            : { path: projectPath }),
          aliases: aliases
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        },
        editingProject ? "PATCH" : "POST",
      );
      setAdding(false);
      setName("");
      setProjectPath("");
      setAliases("");
      setNotice(
        !description.trim()
          ? "Project saved. Routing context is generated automatically."
          : editingProject
            ? "Project context saved. Routing uses it on your next request."
            : "Project connected with context for routing.",
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function openTask(task: Task) {
    setDetailLoading(true);
    setError("");
    try {
      setDetail(
        await api<TaskDetail>(
          `/api/tasks?projectId=${task.projectId}&taskId=${task.id}`,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDetailLoading(false);
    }
  }
  async function run(task: TaskDetail, operation: "run" | "recover" = "run") {
    setBusyTask(task.id);
    setError("");
    const request = api<{ message: string }>("/api/tasks", {
      projectId: task.projectId,
      taskId: task.id,
      operation,
    });
    setDetail(null);
    setNotice(
      operation === "run"
        ? "Starting a read-only worker. You can keep using the workspace."
        : "Recovering interrupted worker state.",
    );
    setTimeout(() => void refresh(), 800);
    try {
      const result = await request;
      setNotice(result.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyTask("");
      await refresh();
    }
  }
  async function preview(action: ApprovalAction) {
    setError("");
    try {
      setApproval(
        await api<Approval>("/api/approvals", { operation: "preview", action }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function confirm() {
    if (!approval) return;
    setApproving(true);
    setError("");
    try {
      await api("/api/approvals", {
        operation: "confirm",
        id: approval.id,
        confirmation: approval.confirmation,
      });
      setApproval(null);
      setDetail(null);
      setAdding(false);
      setEditingProject(null);
      setNotice("Approved action completed.");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      setApproval(null);
    } finally {
      setApproving(false);
    }
  }
  const loadProviders = useCallback(async () => {
    if (providerRequest.current) return;
    providerRequest.current = true;
    setUsageLoading(true);
    try {
      const result = await api<{ providers: ProviderInfo[] }>("/api/providers");
      setProviderInfo(result.providers);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      providerRequest.current = false;
      setUsageLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!settings) return;
    const timer = setInterval(() => void loadProviders(), 60000);
    return () => clearInterval(timer);
  }, [settings, loadProviders]);
  function showSettings() {
    setReserveDraft(null);
    setPreferencesError("");
    setSettings(true);
    void loadProviders();
  }
  function savePreference(change: RoutingPreferenceChange) {
    preferenceRevision.current += 1;
    pendingPreferences.current += 1;
    setPreferencesSaving(true);
    setPreferencesError("");
    setSnapshot((current) =>
      current
        ? {
            ...current,
            config: {
              ...current.config,
              routingPreferences: applyRoutingPreference(
                current.config.routingPreferences,
                change,
              ),
            },
          }
        : current,
    );
    // Queue writes so rapid mouse and keyboard selections preserve their order.
    preferenceQueue.current = preferenceQueue.current.then(async () => {
      let saved: RoutingPreferences | undefined;
      try {
        saved = (
          await api<{ preferences: RoutingPreferences }>(
            "/api/routing-preferences",
            change,
          )
        ).preferences;
        if (change.operation === "reserve") setReserveDraft(null);
      } catch (e) {
        setPreferencesError((e as Error).message);
      } finally {
        pendingPreferences.current -= 1;
        if (!pendingPreferences.current) {
          if (saved)
            setSnapshot((current) =>
              current
                ? {
                    ...current,
                    config: { ...current.config, routingPreferences: saved! },
                  }
                : current,
            );
          else await refresh();
          setPreferencesSaving(false);
        }
      }
    });
  }
  const activeName = projects.find((p) => p.id === projectFilter)?.name;
  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <a className="brand" href="/" aria-label="crouter home">
          <span className="brand-icon">
            <GitBranch size={22} />
          </span>
          <span>
            crouter<span className="brand-dot">.</span>
          </span>
          <span className="version">v0.1</span>
        </a>
        <div className="workspace-switch">
          <span className="workspace-avatar">
            <Command size={16} />
          </span>
          <div>
            <strong>Local workspace</strong>
            <span>Your machine, your context</span>
          </div>
          <ChevronDown size={14} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <button
            className={`nav-item ${tab === "workspace" ? "active" : ""}`}
            onClick={() => {
              setTab("workspace");
              setSidebarOpen(false);
            }}
          >
            <MessageSquare size={17} />
            Conversation<span className="keyboard-hint">⌘ ↵</span>
          </button>
          <button
            className={`nav-item ${tab === "tasks" ? "active" : ""}`}
            onClick={() => {
              setTab("tasks");
              setSidebarOpen(false);
            }}
          >
            <LayoutDashboard size={17} />
            All tasks<span className="nav-count">{tasks.length}</span>
          </button>
        </nav>
        <div className="nav-label projects-label">
          <span>PROJECTS</span>
          <button
            className="icon-button"
            aria-label="Add project"
            onClick={() => showProjectEditor()}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="project-list" aria-label="Projects">
          <button
            className={`project-item ${projectFilter === "all" ? "selected" : ""}`}
            onClick={() => {
              setProjectFilter("all");
              setSidebarOpen(false);
            }}
          >
            <span className="project-dot all-dot" />
            <span>All projects</span>
            <span>{tasks.length}</span>
          </button>
          {projects.map((p, i) => (
            <div className="project-row" key={p.id}>
              <button
                className={`project-item ${projectFilter === p.id ? "selected" : ""}`}
                onClick={() => {
                  setProjectFilter(p.id);
                  setSidebarOpen(false);
                }}
              >
                <span className={`project-dot ${colors[i % colors.length]}`} />
                <span>{p.name}</span>
                <span>{tasks.filter((t) => t.projectId === p.id).length}</span>
              </button>
              {p.kind !== "general" && (
                <button
                  className="project-settings icon-button"
                  aria-label={`Project settings for ${p.name}`}
                  onClick={() => showProjectEditor(p)}
                >
                  <MoreHorizontal size={14} />
                </button>
              )}
            </div>
          ))}
          <button className="add-project" onClick={() => showProjectEditor()}>
            <Plus size={15} />
            Add a project
          </button>
        </div>
        <div className="sidebar-bottom">
          <div className="local-note">
            <ShieldCheck size={18} />
            <div>
              <strong>Local by design</strong>
              <span>State stays on your machine.</span>
            </div>
          </div>
          <button className="nav-item settings-nav" onClick={showSettings}>
            <Settings2 size={16} />
            Host & usage
            <ChevronRight size={14} />
          </button>
          <div className="sidebar-footer">
            <span>
              <span className="online-dot" />
              Local storage
            </span>
            <a
              href="https://opensource.org/license/mit"
              target="_blank"
              rel="noreferrer"
            >
              MIT licensed
              <ExternalLink size={10} />
            </a>
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{tab === "workspace" ? "Conversation" : "Tasks"}</strong>
          </div>
          <div className="topbar-right">
            <button
              className="secondary-button compact-view-switch"
              aria-label={
                tab === "workspace" ? "View tasks" : "View conversation"
              }
              onClick={() =>
                setTab(tab === "workspace" ? "tasks" : "workspace")
              }
            >
              {tab === "workspace" ? (
                <LayoutDashboard size={16} />
              ) : (
                <MessageSquare size={16} />
              )}
              {tab === "workspace" ? "Tasks" : "Chat"}
            </button>
            <ThemeSelect />
            <span className="local-pill">
              <span className="online-dot" />
              {snapshot?.config.demo ? "Synthetic demo" : "Local instance"}
            </span>
            <button
              className="user-avatar"
              aria-label="Open local setup"
              onClick={showSettings}
            >
              <Terminal size={16} />
            </button>
          </div>
        </header>
        <div className="page-content">
          <h1 className="sr-only">
            {tab === "workspace" ? "Conversation" : "Tasks"}
          </h1>
          {error && (
            <div role="alert" className="alert">
              <AlertCircle size={17} />
              <span>{error}</span>
              <button
                aria-label="Dismiss error"
                className="icon-button"
                onClick={() => setError("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {snapshot?.warnings.map((w) => (
            <div className="alert" key={w}>
              <AlertCircle size={16} />
              {w}
            </div>
          ))}
          {notice && (
            <div role="status" className="notice">
              <Check size={16} />
              {notice}
            </div>
          )}
          {tab === "workspace" &&
            projects.some((p) => !p.description?.trim()) && (
              <div className="project-context-prompt">
                <span>
                  <strong>Automatic project context.</strong>{" "}
                  {snapshot?.config.routingConfigured &&
                  preferences.enabledModels.length
                    ? `${routingName} selects an enabled model to draft missing context.`
                    : "Configure the router and enable a model in Host & usage to start setup."}
                </span>
                <div>
                  {projects
                    .filter((p) => !p.description?.trim())
                    .map((p) => (
                      <span key={p.id} title={p.contextError}>
                        {p.name}:{" "}
                        {p.contextStatus === "error"
                          ? p.contextError || "setup failed"
                          : p.contextStatus === "generating"
                            ? "generating…"
                            : "waiting"}
                        {p.contextStatus === "error" && (
                          <button
                            className="text-button"
                            onClick={() => {
                              void api("/api/projects/context", {
                                projectId: p.id,
                                retry: true,
                              })
                                .then(() => refresh())
                                .catch((e) => setError((e as Error).message));
                            }}
                          >
                            Retry {p.name}
                          </button>
                        )}
                      </span>
                    ))}
                </div>
              </div>
            )}
          <div
            className={`work-grid ${tab === "tasks" ? "tasks-only" : chatExpanded ? "chat-expanded" : ""}`}
          >
            {tab === "workspace" && (
              <section className="chat-panel panel" aria-label="Conversation">
                <div className="panel-heading">
                  <div>
                    <MessageSquare size={17} />
                    <h2>Conversation</h2>
                    <span className="subtle-label">
                      All projects, one thread
                    </span>
                  </div>
                  <div className="chat-heading-actions">
                    <button
                      className="icon-button"
                      aria-label={
                        chatExpanded
                          ? "Show task dashboard"
                          : "Expand conversation"
                      }
                      aria-pressed={chatExpanded}
                      onClick={() => setChatExpanded(!chatExpanded)}
                    >
                      {chatExpanded ? (
                        <Minimize2 size={16} />
                      ) : (
                        <Maximize2 size={16} />
                      )}
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Clear chat history"
                      disabled={!messages.length}
                      onClick={() => void preview({ kind: "clear_history" })}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
                <div className="chat-feed" aria-live="polite">
                  <div className="chat-day">
                    <span />
                    {messages.length
                      ? new Date(messages[0].createdAt).toLocaleDateString(
                          undefined,
                          { month: "long", day: "numeric" },
                        )
                      : "A fresh start"}
                    <span />
                  </div>
                  {!messages.length && (
                    <div className="welcome-message">
                      <span className="assistant-avatar">
                        <GitBranch size={18} />
                      </span>
                      <div>
                        <div className="message-meta">
                          <strong>crouter</strong>
                          <span>Your project coordinator</span>
                        </div>
                        <h3>A place for your next idea.</h3>
                        <p>
                          Ask a question or describe what needs doing. I’ll
                          match it to a project, or use General for everything
                          else.
                        </p>
                        <div className="route-illustration">
                          <span>
                            <MessageSquare size={13} />
                            Your turn
                          </span>
                          <ArrowRight size={12} />
                          <span className="jev-node">
                            <GitBranch size={13} />
                            {routingName} routes
                          </span>
                          <ArrowRight size={12} />
                          <span>
                            <Folder size={13} />
                            Project state
                          </span>
                        </div>
                        <div className="prompt-suggestions">
                          <button
                            disabled={!projects.length}
                            onClick={() =>
                              void send(
                                `What is the status of ${projects[0]?.name}?`,
                              )
                            }
                          >
                            <Activity size={13} />
                            Check project status
                            <ArrowUp size={12} />
                          </button>
                          <button
                            onClick={() => {
                              if (projects.length) {
                                setInput(
                                  `Create a task for ${projects[0].name}: `,
                                );
                                textArea.current?.focus();
                              } else showProjectEditor();
                            }}
                          >
                            <Plus size={13} />
                            {projects.length
                              ? "Start something new"
                              : "Connect your first project"}
                            <ArrowUp size={12} />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                  <RouterMessages
                    messages={messages}
                    isRunning={sending}
                    onSend={send}
                  />
                  {sending && (
                    <div className="chat-message">
                      <span className="assistant-avatar">
                        <GitBranch size={17} />
                      </span>
                      <div className="thinking">
                        <span />
                        <span />
                        <span />
                        Routing this turn…
                      </div>
                    </div>
                  )}
                  <div ref={bottom} />
                </div>
                <div className="composer-area">
                  <form
                    className={`composer${composerExpanded ? " composer-expanded" : ""}`}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void send();
                    }}
                  >
                    <textarea
                      ref={textArea}
                      aria-label="Message to route"
                      placeholder="Ask anything or describe the work you want to do…"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      maxLength={4000}
                      rows={composerExpanded ? 10 : 5}
                      disabled={sending}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void send();
                        }
                      }}
                    />
                    <div className="composer-tools">
                      <label className="provider-select composer-project">
                        <Folder size={13} />
                        <select
                          aria-label="Project for this message"
                          value={routingProject}
                          onChange={(e) => setRoutingProject(e.target.value)}
                        >
                          <option value="auto">Automatic workspace</option>
                          {projects.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        <ChevronDown size={12} />
                      </label>
                      <label className="provider-select">
                        {provider === "auto" ? (
                          <GitBranch size={13} />
                        ) : (
                          <ProviderMark provider={provider} />
                        )}
                        <select
                          aria-label="Worker provider for new tasks"
                          value={provider}
                          onChange={(e) =>
                            setProvider(e.target.value as Provider | "auto")
                          }
                        >
                          <option value="auto">Automatic model & effort</option>
                          {Object.entries(providerNames).map(([id, name]) => (
                            <option
                              key={id}
                              value={id}
                              disabled={
                                !snapshot?.config.demo &&
                                !snapshot?.config[id as Provider]
                              }
                            >
                              {name}
                            </option>
                          ))}
                        </select>
                        <ChevronDown size={12} />
                      </label>
                      <span className="composer-hint">
                        ↵ Send · Shift ↵ New line
                      </span>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={
                          composerExpanded
                            ? "Shrink message box"
                            : "Expand message box"
                        }
                        aria-pressed={composerExpanded}
                        title="Adjust message box size; you can also drag its bottom edge"
                        onClick={() => setComposerExpanded((value) => !value)}
                      >
                        {composerExpanded ? (
                          <Minimize2 size={16} />
                        ) : (
                          <Maximize2 size={16} />
                        )}
                      </button>
                      <button
                        type="submit"
                        className="send-button"
                        aria-label="Send message"
                        disabled={sending || !input.trim()}
                      >
                        {sending ? (
                          <Loader2 size={17} className="spin" />
                        ) : (
                          <ArrowUp size={18} />
                        )}
                      </button>
                    </div>
                  </form>
                  <div className="composer-footnote">
                    <ShieldCheck size={12} />
                    Chat is a display. Project files are the source of truth.
                  </div>
                </div>
              </section>
            )}
            {(tab === "tasks" || !chatExpanded) && (
              <section
                className="tasks-panel panel"
                aria-label="Task dashboard"
              >
                <div className="panel-heading">
                  <div>
                    <LayoutDashboard size={17} />
                    <h2>Task dashboard</h2>
                    <span className="count-chip">{tasks.length}</span>
                  </div>
                  <button
                    className="icon-button"
                    aria-label="Refresh tasks"
                    onClick={() => void refresh()}
                  >
                    <RotateCcw size={14} />
                  </button>
                </div>
                <div className="task-controls">
                  <div className="task-select-row">
                    <label className="project-select">
                      <Folder size={13} />
                      <select
                        aria-label="Filter tasks by project"
                        value={projectFilter}
                        onChange={(e) => setProjectFilter(e.target.value)}
                      >
                        <option value="all">All projects</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={12} />
                    </label>
                    <span className="results-count">
                      {filtered.length} tasks
                    </span>
                  </div>
                  <label className="search-field">
                    <Search size={14} />
                    <input
                      aria-label="Search tasks"
                      placeholder="Find a task…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <span>/</span>
                  </label>
                  <div
                    className="filter-tabs"
                    role="group"
                    aria-label="Filter tasks by status"
                  >
                    {["all", "queued", "running", "done", "blocked"].map(
                      (s) => (
                        <button
                          key={s}
                          className={status === s ? "selected" : ""}
                          onClick={() => setStatus(s)}
                        >
                          {s === "all" ? "All" : statusNames[s as TaskStatus]}
                          {s === "all" && <span>{tasks.length}</span>}
                        </button>
                      ),
                    )}
                  </div>
                </div>
                <div className="task-list">
                  {!snapshot ? (
                    <div className="empty-tasks">
                      <Loader2 className="spin" />
                      <p>Opening your local workspace…</p>
                    </div>
                  ) : filtered.length ? (
                    filtered.map((t) => (
                      <button
                        className="task-card"
                        key={`${t.projectId}-${t.id}`}
                        onClick={() => void openTask(t)}
                      >
                        <div className="task-card-top">
                          <span
                            className={`project-tag ${
                              colors[
                                Math.max(
                                  0,
                                  projects.findIndex(
                                    (p) => p.id === t.projectId,
                                  ),
                                ) % colors.length
                              ]
                            }`}
                          >
                            <span className="project-dot" />
                            {t.projectName}
                          </span>
                          <Badge status={t.status} />
                        </div>
                        <h3>{t.title}</h3>
                        <div className="task-card-bottom">
                          <span>
                            <ProviderMark provider={t.provider} />
                            {providerNames[t.provider]}
                            <span className="dot-separator">·</span>
                            <span className="task-id">{t.id}</span>
                          </span>
                          <ChevronRight size={14} />
                        </div>
                        {t.threadId && (
                          <div className="thread-hint">
                            <GitBranch size={11} />
                            Saved session · ready to resume
                          </div>
                        )}
                        {t.model && (
                          <div className="thread-hint">
                            {t.model} · {t.effort || "default"} effort
                          </div>
                        )}
                      </button>
                    ))
                  ) : (
                    <div className="empty-tasks">
                      <div className="empty-task-icon">
                        <LayoutDashboard size={25} />
                        <span>
                          <Plus size={12} />
                        </span>
                      </div>
                      <h3>
                        {tasks.length
                          ? "A clear view."
                          : "Room for your next task."}
                      </h3>
                      <p>
                        {tasks.length
                          ? "No tasks match these filters. Try another project or status."
                          : "Create a task in the conversation. Its progress and saved session will show up here."}
                      </p>
                      {tasks.length ? (
                        <button
                          className="text-button"
                          onClick={() => {
                            setStatus("all");
                            setProjectFilter("all");
                            setQuery("");
                          }}
                        >
                          Reset filters
                          <ArrowRight size={12} />
                        </button>
                      ) : (
                        <span className="example-prompt">
                          “Create a task for {activeName || "my-project"}:
                          review the API”
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div className="dashboard-footer">
                  <span className="online-dot" />
                  Updated from project Markdown<span>Auto-refresh on</span>
                </div>
              </section>
            )}
          </div>
        </div>
      </main>
      {adding && !approval && (
        <Modal
          title={editingProject ? "Project settings" : "Connect a project"}
          onClose={() => setAdding(false)}
        >
          <form onSubmit={addProject}>
            <p className="modal-description">
              {routingName} selects an enabled model to draft routing context
              automatically from the project README and metadata. You can edit
              it here.
            </p>
            <label className="form-label">
              Project name
              <input
                required
                maxLength={60}
                placeholder="e.g. Atlas"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="form-label">
              Project path on host
              <input
                readOnly={Boolean(editingProject)}
                required
                placeholder="../my-project or /absolute/path/to/project"
                value={projectPath}
                onChange={(e) => {
                  setProjectPath(e.target.value);
                  setResolvedPath("");
                  setPathError("");
                }}
              />
            </label>
            <p className="usage-note">
              Relative paths start at{" "}
              <code>{snapshot?.config.projectPathBase}</code>. <code>~/</code>{" "}
              uses the host’s home directory.
            </p>
            {resolvedPath && (
              <p className="usage-note">
                Resolved host folder: <code>{resolvedPath}</code>
              </p>
            )}
            {pathError && <p className="inline-error">{pathError}</p>}
            <label className="form-label">
              Aliases <span>optional, separated by commas</span>
              <input
                placeholder="atlas-app, atlas-web"
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
              />
            </label>
            <label className="form-label">
              Project context <span>optional, generated automatically</span>
              <textarea
                aria-label="Project context"
                maxLength={1500}
                rows={5}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What are you building? Describe its purpose, domain terms and typical work. For a strategy game: unit tiers, upgrades, combat roles and balance audits."
              />
            </label>
            <p className="usage-note">
              This description is sent to {routingName} with requests to help
              choose a project. You can update it here as the project evolves.
            </p>
            {!editingProject && (
              <div className="info-box">
                <ShieldCheck size={17} />
                <p>
                  Creates <code>.router-agent/</code> and adds its exclusion to
                  the project’s <code>.gitignore</code>. Paths and session IDs
                  stay in private local storage.
                </p>
              </div>
            )}
            {error && <p className="inline-error">{error}</p>}
            <div className="modal-actions">
              {editingProject && (
                <button
                  type="button"
                  className="text-button danger-text"
                  onClick={() =>
                    void preview({
                      kind: "remove_project",
                      projectId: editingProject.id,
                    })
                  }
                >
                  <Trash2 size={14} />
                  Remove project
                </button>
              )}
              <button
                type="button"
                className="secondary-button"
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={saving}
              >
                {saving ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <Plus size={15} />
                )}
                {editingProject ? "Save project" : "Connect project"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {detail && !approval && (
        <Modal title="Task details" wide onClose={() => setDetail(null)}>
          <div className="detail-meta">
            <span className="task-id">{detail.id}</span>
            <span className="project-tag green">{detail.projectName}</span>
            <Badge status={detail.status} />
          </div>
          <h3 className="detail-title">{detail.title}</h3>
          <div className="detail-grid">
            <div>
              <span>Provider</span>
              <strong>
                <ProviderMark provider={detail.provider} />
                {detail.provider}
              </strong>
            </div>
            <div>
              <span>Updated</span>
              <strong>{new Date(detail.updatedAt).toLocaleString()}</strong>
            </div>
            <div>
              <span>Model</span>
              <strong>{detail.model || "Host CLI default"}</strong>
            </div>
            <div>
              <span>Effort</span>
              <strong>{detail.effort || "Host CLI default"}</strong>
            </div>
          </div>
          {detail.threadId && (
            <div className="session-box">
              <GitBranch size={15} />
              <span>Saved session</span>
              <code>{detail.threadId}</code>
            </div>
          )}
          <div className="detail-body">
            <pre>{detail.body}</pre>
          </div>
          <div className="info-box">
            <ShieldCheck size={17} />
            <p>
              Workers run with read-only permissions. Results are plans or
              review findings. Use the saved session in the official interactive
              CLI to approve implementation changes.
            </p>
          </div>
          <div className="modal-actions">
            <button
              className="text-button danger-text"
              disabled={detail.status === "running"}
              onClick={() =>
                void preview({
                  kind: "archive_task",
                  projectId: detail.projectId,
                  taskId: detail.id,
                })
              }
            >
              <Archive size={15} />
              Archive task
            </button>
            <button
              className="primary-button"
              disabled={busyTask === detail.id}
              onClick={() =>
                void run(
                  detail,
                  detail.status === "running" ? "recover" : "run",
                )
              }
            >
              {detail.status === "running" ? (
                <RotateCcw size={15} />
              ) : (
                <Terminal size={15} />
              )}{" "}
              {detail.status === "running"
                ? "Recover interrupted run"
                : detail.threadId
                  ? "Resume read-only worker"
                  : "Start read-only worker"}
            </button>
          </div>
        </Modal>
      )}
      {approval && (
        <Modal
          title="Approve this action"
          onClose={() => {
            if (!approving) setApproval(null);
          }}
        >
          <div className="approval-icon">
            <ShieldCheck size={24} />
          </div>
          <p className="approval-description">{approval.description}</p>
          <p className="modal-description">
            This approval applies only to this exact action. It expires after 60
            seconds and can be used once.
          </p>
          <div className="modal-actions">
            <button
              className="secondary-button"
              disabled={approving}
              onClick={() => setApproval(null)}
            >
              Cancel
            </button>
            <button
              className="danger-button"
              disabled={approving}
              onClick={() => void confirm()}
            >
              {approving ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Check size={15} />
              )}
              Approve action
            </button>
          </div>
        </Modal>
      )}
      {settings && !approval && (
        <Modal title="Host & usage" wide onClose={() => setSettings(false)}>
          <p className="modal-description">
            Project state stays on your machine. {routingName} classifies turns
            remotely; provider workers use your existing CLI logins.
          </p>
          <p className="usage-note">
            App built:{" "}
            {process.env.NEXT_PUBLIC_CROUTER_BUILD_TIME || "development"}.
            Appearance is in the top toolbar.
          </p>
          <div className="connection-row">
            <span className="brand-icon">
              <GitBranch size={18} />
            </span>
            <div>
              <strong>
                {routingName}
                {routingProvider === "clef"
                  ? " / Cloudflare"
                  : routingProvider === "jev"
                    ? " / TypeSafe"
                    : " configuration"}
              </strong>
              <span>Project, model and effort decisions</span>
            </div>
            <span
              className={`connection-state ${snapshot?.config.routingConfigured ? "connected" : ""}`}
            >
              {snapshot?.config.demo
                ? "Demo"
                : snapshot?.config.routingConfigured
                  ? "Configured"
                  : "Needs setup"}
            </span>
          </div>
          <section
            className="routing-controls"
            aria-label="Routing preferences"
          >
            <label className="routing-switch">
              <input
                type="checkbox"
                checked={preferences.usageAware}
                disabled={preferencesSaving || !snapshot}
                onChange={(e) =>
                  void savePreference({
                    operation: "usage",
                    enabled: e.target.checked,
                  })
                }
              />
              <span>
                <strong>Route based on remaining usage</strong>
                <small>
                  Balance suitable models by remaining allowance and time until
                  reset, while keeping a reserve in every reported window. Only
                  fresh usage readings qualify.
                </small>
              </span>
            </label>
            {preferences.usageAware && (
              <form
                className="routing-reserve"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reserveDraft.trim())
                    void savePreference({
                      operation: "reserve",
                      minRemainingPercent: Number(reserveDraft),
                    });
                }}
              >
                <label>
                  Minimum remaining usage{" "}
                  <span>
                    <input
                      aria-label="Minimum remaining usage"
                      type="number"
                      required
                      min={0}
                      max={100}
                      step={1}
                      value={reserveDraft}
                      disabled={preferencesSaving}
                      onChange={(e) => setReserveDraft(e.target.value)}
                    />
                    %
                  </span>
                </label>
                <button
                  type="submit"
                  className="secondary-button"
                  disabled={
                    preferencesSaving ||
                    !reserveDraft.trim() ||
                    Number(reserveDraft) === preferences.minRemainingPercent
                  }
                >
                  Save reserve
                </button>
              </form>
            )}
            <p className="usage-note">
              {preferences.usageAware
                ? `New tasks require at least ${preferences.minRemainingPercent}% remaining in each available window. CLIs with unavailable or stale usage are excluded.`
                : "Usage is displayed below. Routing uses enabled models and task complexity."}
            </p>
            <ModelPicker
              providers={providerInfo}
              preferences={preferences}
              loading={usageLoading}
              ready={Boolean(snapshot)}
              saving={preferencesSaving}
              onChange={savePreference}
              onRefresh={() => void loadProviders()}
            />
            <RoutingRules
              providers={providerInfo}
              preferences={preferences}
              saving={preferencesSaving}
              ready={Boolean(snapshot)}
              onChange={savePreference}
            />
            {preferencesError && (
              <p className="inline-error" role="alert">
                {preferencesError}
              </p>
            )}
          </section>
          <div className="quota-heading">
            <strong>Providers & usage</strong>
            <button
              className="text-button"
              disabled={usageLoading}
              onClick={() => void loadProviders()}
            >
              {usageLoading ? (
                <Loader2 className="spin" size={13} />
              ) : (
                <RotateCcw size={13} />
              )}
              Refresh limits
            </button>
          </div>
          {providerInfo.map((p) => (
            <div className="provider-info" key={p.id}>
              <div className="connection-row">
                <span className="provider-mark">
                  <Terminal size={19} />
                </span>
                <div>
                  <strong>{p.name}</strong>
                  <span>{p.detail}</span>
                </div>
                <span
                  className={`connection-state ${p.installed ? "connected" : ""}`}
                >
                  {!p.runnable
                    ? "Unsupported host"
                    : snapshot?.config.demo
                      ? "Demo"
                      : p.installed
                        ? "CLI found"
                        : "Not detected"}
                </span>
              </div>
              {p.models.length > 0 && (
                <details className="host-models">
                  <summary>
                    {p.models.length}{" "}
                    {p.models.length === 1 ? "model" : "models"} available from
                    host
                  </summary>
                  {p.models.map((m) => (
                    <p className="usage-note" key={m.id}>
                      <strong>{m.id}</strong>
                      <br />
                      Effort: {m.efforts.join(", ")}
                    </p>
                  ))}
                </details>
              )}
              {p.modelsError && <p className="usage-note">{p.modelsError}</p>}
              {p.windows.map((w) => (
                <div className="usage-window" key={w.label}>
                  <div>
                    <span>{w.label}</span>
                    <strong>
                      {p.usageStale ? "Stale · " : ""}
                      {Math.round(100 - w.usedPercent)}% remaining
                    </strong>
                  </div>
                  <div className="usage-track">
                    <span style={{ width: `${w.usedPercent}%` }} />
                  </div>
                  <small>
                    {w.resetsAt
                      ? `Resets ${new Date(w.resetsAt * 1000).toLocaleString()}`
                      : "Reset time unavailable"}
                    {w.windowDurationMins
                      ? ` · ${w.windowDurationMins} minute window`
                      : ""}
                  </small>
                </div>
              ))}
              {p.usageError && <p className="usage-note">{p.usageError}</p>}
              {p.usageSummary?.lifetimeTokens !== undefined && (
                <p className="usage-note">
                  Account reported lifetime tokens:{" "}
                  {p.usageSummary.lifetimeTokens.toLocaleString()}
                  {p.usageSummary.peakDailyTokens !== undefined
                    ? ` · Peak day: ${p.usageSummary.peakDailyTokens.toLocaleString()}`
                    : ""}
                </p>
              )}
              {p.usageSource && (
                <p className="usage-note">
                  {p.usageSource}
                  {p.checkedAt ? ` · ${timeString(p.checkedAt)}` : ""}
                </p>
              )}
            </div>
          ))}
          <div className="info-box">
            <ShieldCheck size={17} />
            <p>
              Choose <code>CROUTER_ROUTER=jev</code> with{" "}
              <code>TYPESAFE_API_KEY</code>, or <code>CROUTER_ROUTER=clef</code>
              with <code>CLOUDFLARE_API_TOKEN</code> and{" "}
              <code>CLOUDFLARE_ACCOUNT_ID</code>, in your private{" "}
              <code>.env.local</code>. Restart crouter after changing these
              settings. CLI detection does not verify your subscription or
              login.
            </p>
          </div>
          <p className="modal-description">
            The README includes safe setup, data boundaries, session recovery,
            and the checklist for publishing this MIT project without private
            data.
          </p>
          <div className="modal-actions">
            <a
              className="text-button"
              target="_blank"
              rel="noreferrer"
              href="https://docs.typesafe.ai/introduction/quickstart"
            >
              TypeSafe API docs
              <ExternalLink size={13} />
            </a>
            <a
              className="text-button"
              target="_blank"
              rel="noreferrer"
              href="https://developers.cloudflare.com/workers-ai/models/clef/"
            >
              Cloudflare Clef docs
              <ExternalLink size={13} />
            </a>
            <button
              className="primary-button"
              onClick={() => setSettings(false)}
            >
              Done
              <Check size={14} />
            </button>
          </div>
        </Modal>
      )}
      {detailLoading && (
        <div className="loading-toast" role="status">
          <Loader2 size={16} className="spin" />
          Reading project task…
        </div>
      )}
    </div>
  );
}
