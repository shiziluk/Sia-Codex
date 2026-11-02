import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowRightLeft,
  Check,
  Copy,
  GitMerge,
  Loader2,
  Maximize2,
  Play,
  RefreshCw,
  Save,
  Square,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { PageHeader } from "./ManagementPages";
import { AppSelect } from "./AppSelect";
import { agentQueueState, DEFAULT_MAX_CONCURRENT_TASKS_LIMIT, normalizeConcurrency } from "./agent-collaboration-queue";
import { t, tf } from "./i18n";
import "./AgentCollaborationPage.css";

// maxConcurrentTasks：同一 Agent 最多同时运行的任务数（1–4，默认 1），超出时排队（#2800）。
type Agent = { id: string; name: string; executable: string; enabled: boolean; model: string; reuseSavedAuth: boolean; maxConcurrentTasks: number };
type CollaborationConfig = { enabled: boolean; defaultAgentId: string; agents: Agent[]; maxRuntimeMinutes: number };
const defaultMaxRuntimeMinutes = 10;
const maxRuntimeMinutesLimit = 240;
type Integration = { status: "connected" | "not_connected" | "conflict"; message: string; home?: string; configPath?: string };
type CodexRuntime = {
  status: "ready" | "partial" | "unavailable" | "error";
  message: string;
  reloadSucceeded: boolean;
  toolsReady: boolean;
  toolCount: number;
  threadVerified: boolean;
  cacheRefreshed: boolean;
};
type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "handed_off";
type TaskRecord = {
  id: string;
  agentId: string;
  prompt: string;
  cwd: string;
  status: TaskStatus;
  answer: string;
  error: string;
  sessionId: string;
  parentTaskId?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  cancelRequested: boolean;
  progress: string;
  workflowId?: string | null;
  role?: string;
};
type WorkflowPhase = "planning" | "plan_review" | "executing" | "result_review" | "awaiting_acceptance" | "merging" | "merge_conflict" | "completed" | "failed" | "cancelled" | "blocked" | "interrupted";
type MergeConflictPreview = {
  file: string;
  baseExists: boolean;
  oursExists: boolean;
  theirsExists: boolean;
  base: string;
  ours: string;
  theirs: string;
  binary: boolean;
  truncated: boolean;
};
type WorkflowRecord = {
  id: string;
  objective: string;
  cwd: string;
  plannerAgentId: string;
  reviewerAgentId: string;
  executorAgentId: string;
  phase: WorkflowPhase;
  planRevision: number;
  reviewRound: number;
  maxReviewRounds: number;
  resultReviewRound: number;
  repairCount: number;
  reviewDecision: string;
  reviewNotes: string;
  resultSummary: string;
  acceptanceNotes: string;
  error: string;
  controllerId: string;
  cancelRequested: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  subtaskTaskIds?: Record<string, string>;
  subtaskOutputs?: Record<string, string>;
  subtaskWorktrees?: Record<string, { path: string; branchName: string; baseCommit: string; status: string; changedFiles: string[] }>;
  mergeCommit?: string;
  mergeConflicts?: string[];
  mergeConflictTaskId?: string;
  mergeResolutions?: Record<string, string>;
  mergeConflictPreviews?: MergeConflictPreview[];
  mergeSummary?: string;
  plan?: { goal: string; subtasks: { id: string; title: string; agentId?: string; dependsOn?: string[]; workspaceMode?: string; mergeMode?: string; mergeStrategy?: string; expectedOutput: string }[] } | null;
};
type WorkflowEvent = {
  seq: number;
  kind: string;
  phase: WorkflowPhase;
  taskId?: string;
  role?: string;
  message: string;
  createdAtMs: number;
};
type Snapshot = {
  config: CollaborationConfig;
  tasks: TaskRecord[];
  workflows?: WorkflowRecord[];
  /** configuredMissing：已保存的路径不存在；recovered：已改用自动找到的 CLI（桌面版更新后哈希目录变化，#2751）。 */
  availability?: { id: string; available: boolean; path?: string | null; configuredMissing?: boolean; recovered?: boolean }[];
  integration?: Integration;
  runtime?: CodexRuntime;
  /** maxQueuedPerAgent：每个 Agent 最多排队的任务数（#2772）；maxConcurrentTasksLimit：并发上限的可选上界（#2800）。 */
  capabilities?: { maxQueuedPerAgent?: number; maxConcurrentTasksLimit?: number };
};
type McpConfig = { codexToml: string; claudeJson: string; command: string; args: string[] };
type EventStreamEndpoint = { url: string; protocol: string };
type EventStreamStatus = "connecting" | "live" | "fallback" | "snapshot";

const defaultConfig = (): CollaborationConfig => ({
  enabled: false,
  defaultAgentId: "deepseek",
  agents: [
    { id: "codex", name: "Codex", executable: "", enabled: false, model: "", reuseSavedAuth: false, maxConcurrentTasks: 1 },
    { id: "deepseek", name: "DeepSeek Harness", executable: "", enabled: false, model: "", reuseSavedAuth: false, maxConcurrentTasks: 1 },
    { id: "claude", name: "Claude Code", executable: "", enabled: false, model: "", reuseSavedAuth: false, maxConcurrentTasks: 1 },
    { id: "workbuddy", name: "WorkBuddy", executable: "", enabled: false, model: "hy3", reuseSavedAuth: false, maxConcurrentTasks: 1 },
    { id: "trae", name: "Trae CN", executable: "", enabled: false, model: "", reuseSavedAuth: false, maxConcurrentTasks: 1 },
  ],
  maxRuntimeMinutes: defaultMaxRuntimeMinutes,
});
const statusLabels: Record<TaskStatus, string> = {
  queued: "排队中", running: "执行中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断", handed_off: "已交付待结果",
};
const workflowPhaseLabels: Record<WorkflowPhase, string> = {
  planning: "中书规划中",
  plan_review: "门下审议中",
  executing: "六部执行中",
  result_review: "结果复核中",
  awaiting_acceptance: "待宰相验收",
  merging: "自动合并中",
  merge_conflict: "合并冲突",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  blocked: "阻塞",
  interrupted: "已中断",
};
const workflowSubtaskStatusLabels: Record<string, string> = {
  blocked: "等待依赖",
  ready: "待调度",
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  merged: "已合并",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  handed_off: "已交付待结果",
};
const unfinished = (task: TaskRecord) => task.status === "queued" || task.status === "running";
const absolutePath = (value: string) => /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(value.trim());
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const runtimeReady = (runtime?: CodexRuntime | null) => runtime?.status === "ready"
  && runtime.reloadSucceeded === true && runtime.toolsReady === true && runtime.cacheRefreshed === true;
// 旧版本快照和默认关闭的认证字段可能省略，读取后补齐，保存时发送完整配置。
const copyConfig = (config: CollaborationConfig): CollaborationConfig => ({
  ...config,
  defaultAgentId: config.defaultAgentId || "deepseek",
  maxRuntimeMinutes: Number.isInteger(config.maxRuntimeMinutes) && config.maxRuntimeMinutes > 0
    ? config.maxRuntimeMinutes : defaultMaxRuntimeMinutes,
  agents: config.agents.map((agent) => ({ ...agent, model: agent.model || "", reuseSavedAuth: agent.reuseSavedAuth === true, maxConcurrentTasks: normalizeConcurrency(agent.maxConcurrentTasks) })),
});
const formatTime = (value: number) => Number.isFinite(value) && value > 0
  ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
  : "—";
const mergeConflictResolutionKey = (subtaskId: string, file: string) => `${subtaskId}\u001f${file}`;
type WorkflowSubtask = NonNullable<WorkflowRecord["plan"]>["subtasks"][number];
type WorkflowDagNode = {
  subtask: WorkflowSubtask;
  status: string;
  column: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
const workflowSubtaskStatus = (workflow: WorkflowRecord, subtask: WorkflowSubtask, tasks: TaskRecord[]) => {
  const taskId = workflow.subtaskTaskIds?.[subtask.id];
  const task = taskId ? tasks.find((item) => item.id === taskId) : undefined;
  const dependencies = subtask.dependsOn ?? [];
  const worktree = workflow.subtaskWorktrees?.[subtask.id];
  const dependenciesReady = dependencies.every((dependency) => Boolean(workflow.subtaskOutputs?.[dependency]));
  return worktree?.status || task?.status || (workflow.subtaskOutputs?.[subtask.id] ? "completed" : dependenciesReady ? "ready" : "blocked");
};
const displayWorkflowStatus = (status: string) => status === "queued" || status === "running"
  ? "running"
  : status === "completed" || status === "merged"
    ? "completed"
    : status === "failed" || status === "blocked" || status === "interrupted"
      ? "failed"
      : status === "cancelled" ? "cancelled" : "running";
const buildWorkflowDag = (workflow: WorkflowRecord, tasks: TaskRecord[]) => {
  const subtasks = workflow.plan?.subtasks ?? [];
  const knownIds = new Set(subtasks.map((subtask) => subtask.id));
  const levels = new Map<string, number>();
  for (let pass = 0; pass <= subtasks.length; pass += 1) {
    let changed = false;
    for (const subtask of subtasks) {
      const dependencies = (subtask.dependsOn ?? []).filter((dependency) => knownIds.has(dependency));
      const level = dependencies.length
        ? Math.max(...dependencies.map((dependency) => levels.get(dependency) ?? 0)) + 1
        : 0;
      if (levels.get(subtask.id) !== level) {
        levels.set(subtask.id, level);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const groups = new Map<number, WorkflowSubtask[]>();
  for (const subtask of subtasks) {
    const column = levels.get(subtask.id) ?? 0;
    groups.set(column, [...(groups.get(column) ?? []), subtask]);
  }
  const nodes = new Map<string, WorkflowDagNode>();
  for (const [column, group] of groups) {
    group.forEach((subtask, row) => {
      nodes.set(subtask.id, {
        subtask,
        status: workflowSubtaskStatus(workflow, subtask, tasks),
        column,
        row,
        x: 24 + column * 230,
        y: 18 + row * 92,
        width: 190,
        height: 68,
      });
    });
  }
  const edges = subtasks.flatMap((subtask) => (subtask.dependsOn ?? []).flatMap((dependency) => {
    const source = nodes.get(dependency);
    const target = nodes.get(subtask.id);
    return source && target ? [{ source, target }] : [];
  }));
  const columnCount = Math.max(1, ...Array.from(levels.values(), (level) => level + 1));
  const rowCount = Math.max(1, ...Array.from(groups.values(), (group) => group.length));
  return {
    nodes: Array.from(nodes.values()),
    edges,
    width: 48 + columnCount * 230,
    height: 38 + rowCount * 92,
  };
};

export function AgentCollaborationPage({ defaultCwd = "" }: { defaultCwd?: string } = {}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [runtime, setRuntime] = useState<CodexRuntime | null>(null);
  const [draft, setDraft] = useState<CollaborationConfig>(defaultConfig);
  // 运行上限输入框保留原始文本：输入过程中的空值或「1」→「15」这类中间态不能立刻钳制，
  // 否则删掉一位就跳回 10 或 1，无法正常改数。合法时才写进草稿，失焦时还原成草稿值。
  const [runtimeText, setRuntimeText] = useState(String(defaultMaxRuntimeMinutes));
  const [dirty, setDirty] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState("");
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [agentId, setAgentId] = useState("");
  const [cwd, setCwd] = useState(defaultCwd);
  const [prompt, setPrompt] = useState("");
  const [workflowObjective, setWorkflowObjective] = useState("");
  const [workflowPlannerId, setWorkflowPlannerId] = useState("workbuddy");
  const [workflowReviewerId, setWorkflowReviewerId] = useState("trae");
  const [workflowExecutorId, setWorkflowExecutorId] = useState("codex");
  const [workflowMaxReviewRounds, setWorkflowMaxReviewRounds] = useState("2");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const [workflowEvents, setWorkflowEvents] = useState<WorkflowEvent[]>([]);
  const [eventStreamUrl, setEventStreamUrl] = useState("");
  const [eventStreamStatus, setEventStreamStatus] = useState<EventStreamStatus>("connecting");
  const [eventStreamEpoch, setEventStreamEpoch] = useState(0);
  const [manualConflictDrafts, setManualConflictDrafts] = useState<Record<string, string>>({});
  const [loadedConflictPreviews, setLoadedConflictPreviews] = useState<Record<string, MergeConflictPreview>>({});
  const [loadingConflictPreview, setLoadingConflictPreview] = useState("");
  const [dagScale, setDagScale] = useState(1);
  const [dagOffset, setDagOffset] = useState({ x: 0, y: 0 });
  const [selectedDagNodeId, setSelectedDagNodeId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [continueTaskId, setContinueTaskId] = useState("");
  const [mcpConfig, setMcpConfig] = useState<McpConfig | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState("");
  const [copied, setCopied] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(false);
  const lifecycle = useRef(0);
  const requestSequence = useRef(0);
  const readInFlight = useRef(false);
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);
  const mcpInFlight = useRef(false);
  const dagDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const dagViewportRef = useRef<HTMLDivElement>(null);

  const applySnapshot = useCallback((next: Snapshot, saved = false) => {
    const normalized = { ...next, config: copyConfig(next.config) };
    setSnapshot(normalized);
    // 普通快照不触发运行时检查，也不能抹掉用户最近一次显式刷新的结果。
    if (saved) setRuntime(null);
    else if (next.runtime) setRuntime(next.runtime);
    // 后台轮询只更新执行状态，保留用户尚未保存的配置。
    if (saved || !dirtyRef.current) {
      setDraft(copyConfig(normalized.config));
      dirtyRef.current = false;
      setDirty(false);
    }
    setSelectedId((current) => next.tasks.some((task) => task.id === current)
      ? current : [...next.tasks].sort((a, b) => b.createdAtMs - a.createdAtMs)[0]?.id ?? "");
    setSelectedWorkflowId((current) => (next.workflows ?? []).some((workflow) => workflow.id === current)
      ? current : [...(next.workflows ?? [])].sort((a, b) => b.createdAtMs - a.createdAtMs)[0]?.id ?? "");
  }, []);

  const refresh = useCallback(async (silent = false) => {
    if (!mounted.current || readInFlight.current || busyRef.current) return;
    const epoch = lifecycle.current;
    const sequence = ++requestSequence.current;
    readInFlight.current = true;
    if (!silent) setRefreshing(true);
    try {
      const next = await invoke<Snapshot>("agent_collaboration_request", { action: "snapshot", payload: {} });
      if (!mounted.current || lifecycle.current !== epoch || sequence !== requestSequence.current) return;
      applySnapshot(next);
      setReadError("");
    } catch (error) {
      if (mounted.current && lifecycle.current === epoch && sequence === requestSequence.current) setReadError(errorText(error));
    } finally {
      if (mounted.current && lifecycle.current === epoch) {
        readInFlight.current = false;
        if (!silent) setRefreshing(false);
      }
    }
  }, [applySnapshot]);

  useEffect(() => {
    mounted.current = true;
    lifecycle.current += 1;
    readInFlight.current = false;
    busyRef.current = false;
    mcpInFlight.current = false;
    void refresh();
    return () => {
      mounted.current = false;
      lifecycle.current += 1;
      requestSequence.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    void invoke<EventStreamEndpoint>("agent_collaboration_event_stream")
      .then((endpoint) => {
        if (!cancelled) setEventStreamUrl(endpoint.url);
      })
      .catch(() => {
        if (!cancelled) setEventStreamStatus("fallback");
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // 不做后台定时轮询；只在用户切回窗口时静默补一次最新状态。
    const refreshOnFocus = () => { void refresh(true); };
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [refresh]);

  const mutate = async (action: string, payload: unknown, onSuccess?: (next: Snapshot) => void) => {
    if (!mounted.current || busyRef.current) return;
    busyRef.current = true;
    const epoch = lifecycle.current;
    // 写操作开始后，之前的只读响应即使较晚到达也不能覆盖新状态。
    const sequence = ++requestSequence.current;
    setBusy(action);
    setActionError("");
    setNotice("");
    const refreshesCodex = action === "connect_codex" || action === "refresh_codex";
    if (refreshesCodex) setRuntime(null);
    try {
      const next = await invoke<Snapshot>("agent_collaboration_request", { action, payload });
      if (!mounted.current || lifecycle.current !== epoch || sequence !== requestSequence.current) return;
      applySnapshot(next, action === "save_config");
      setReadError("");
      onSuccess?.(next);
    } catch (error) {
      if (mounted.current && lifecycle.current === epoch) {
        setActionError(errorText(error));
        if (refreshesCodex) setRuntime({ status: "error", message: errorText(error), reloadSucceeded: false, toolsReady: false, toolCount: 0, threadVerified: false, cacheRefreshed: false });
      }
    } finally {
      if (mounted.current && lifecycle.current === epoch) {
        busyRef.current = false;
        setBusy("");
      }
    }
  };

  const editConfig = (next: CollaborationConfig) => {
    dirtyRef.current = true;
    setDirty(true);
    setDraft(next);
    setNotice("");
  };
  useEffect(() => { setRuntimeText(String(draft.maxRuntimeMinutes)); }, [draft.maxRuntimeMinutes]);
  const parsedRuntimeMinutes = (text: string) => {
    const trimmed = text.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const value = Number(trimmed);
    return value >= 1 && value <= maxRuntimeMinutesLimit ? value : null;
  };
  const editRuntimeText = (text: string) => {
    setRuntimeText(text);
    const value = parsedRuntimeMinutes(text);
    if (value === null) {
      dirtyRef.current = true;
      setDirty(true);
      setNotice("");
      return;
    }
    if (value !== draft.maxRuntimeMinutes) editConfig({ ...draft, maxRuntimeMinutes: value });
  };
  const editAgent = (id: string, patch: Partial<Agent>) => editConfig({ ...draft, agents: draft.agents.map((agent) => agent.id === id ? { ...agent, ...patch } : agent) });
  const saveConfig = () => {
    const invalid = draft.agents.find((agent) => agent.executable.trim() && !absolutePath(agent.executable));
    if (invalid) { setActionError(`请填写 ${invalid.name} 可执行文件的绝对路径。`); return; }
    if (parsedRuntimeMinutes(runtimeText) === null) {
      setActionError(`单个任务运行上限需填写 1 到 ${maxRuntimeMinutesLimit} 之间的整数分钟。`);
      return;
    }
    void mutate("save_config", { ...draft, agents: draft.agents.map((agent) => ({ ...agent, executable: agent.executable.trim(), model: agent.model.trim() })) }, () => {
      setNotice("子 Agent 设置已保存。");
      setMcpConfig(null);
      setCopied("");
    });
  };

  const tasks = [...(snapshot?.tasks ?? [])].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const selected = tasks.find((task) => task.id === selectedId);
  const continuation = tasks.find((task) => task.id === continueTaskId);
  const enabledAgents = snapshot?.config.agents.filter((agent) => agent.enabled) ?? [];
  const workflows = [...(snapshot?.workflows ?? [])].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedWorkflowId);
  const workflowDag = selectedWorkflow ? buildWorkflowDag(selectedWorkflow, tasks) : null;
  const mergeConflictTaskId = selectedWorkflow?.mergeConflictTaskId ?? "";
  const unresolvedMergeConflicts = (selectedWorkflow?.mergeConflicts ?? [])
    .filter((file) => !selectedWorkflow?.mergeResolutions?.[mergeConflictResolutionKey(mergeConflictTaskId, file)]);
  const selectedDagNode = workflowDag?.nodes.find((node) => node.subtask.id === selectedDagNodeId);
  useEffect(() => {
    const previews = selectedWorkflow?.mergeConflictPreviews ?? [];
    const taskId = selectedWorkflow?.mergeConflictTaskId ?? "";
    setManualConflictDrafts((current) => {
      const next: Record<string, string> = {};
      for (const preview of previews) {
        const key = mergeConflictResolutionKey(taskId, preview.file);
        next[key] = current[key] ?? preview.ours;
      }
      return next;
    });
  }, [selectedWorkflow?.id, selectedWorkflow?.mergeConflictTaskId, selectedWorkflow?.mergeConflictPreviews]);
  useEffect(() => {
    setDagScale(1);
    setDagOffset({ x: 0, y: 0 });
    setSelectedDagNodeId("");
    setLoadedConflictPreviews({});
    setLoadingConflictPreview("");
  }, [selectedWorkflow?.id]);
  useEffect(() => {
    if (!selectedWorkflow) {
      setWorkflowEvents([]);
      setEventStreamStatus("connecting");
      return;
    }
    let cancelled = false;
    let afterSeq = 0;
    let inFlight = false;
    const appendEvents = (incoming: WorkflowEvent[], reset = false) => {
      if (cancelled) return;
      setWorkflowEvents((current) => {
        if (reset) return incoming;
        const seen = new Set(current.map((event) => event.seq));
        return [...current, ...incoming.filter((event) => !seen.has(event.seq))].slice(-200);
      });
      const latest = incoming.at(-1)?.seq;
      if (latest !== undefined) afterSeq = Math.max(afterSeq, latest);
    };
    const load = async (reset: boolean) => {
      if (inFlight) return false;
      inFlight = true;
      let succeeded = false;
      try {
        const result = await invoke<{ events: WorkflowEvent[]; nextSeq: number }>("agent_collaboration_events", {
          workflowId: selectedWorkflow.id,
          afterSeq,
          limit: 100,
          tail: reset,
        });
        afterSeq = result.nextSeq ?? afterSeq;
        appendEvents(result.events ?? [], reset);
        succeeded = true;
      } catch {
        if (!cancelled && reset) setWorkflowEvents([]);
      } finally {
        inFlight = false;
      }
      return succeeded;
    };
    let removeFallbackListener: (() => void) | null = null;
    const activateFallback = (reset: boolean) => {
      if (cancelled) return;
      setEventStreamStatus("fallback");
      void load(reset);
      if (!removeFallbackListener) {
        const refreshOnVisible = () => {
          if (document.visibilityState === "visible") void load(false);
        };
        document.addEventListener("visibilitychange", refreshOnVisible);
        removeFallbackListener = () => {
          document.removeEventListener("visibilitychange", refreshOnVisible);
          removeFallbackListener = null;
        };
      }
    };
    if (!eventStreamUrl) {
      activateFallback(true);
      return () => {
        cancelled = true;
        removeFallbackListener?.();
      };
    }
    if (["completed", "failed", "cancelled"].includes(selectedWorkflow.phase)) {
      setEventStreamStatus("snapshot");
      void load(true);
      return () => { cancelled = true; };
    }
    setEventStreamStatus("connecting");
    let source: EventSource | null = null;
    const connect = async () => {
      const loaded = await load(true);
      if (cancelled) return;
      if (!loaded) {
        activateFallback(false);
        return;
      }
      source = new EventSource(`${eventStreamUrl}${encodeURIComponent(selectedWorkflow.id)}&afterSeq=${afterSeq}`);
      source.onopen = () => {
        if (!cancelled) setEventStreamStatus("live");
      };
      source.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as WorkflowEvent;
          appendEvents([event]);
          if (["task_submitted", "phase_changed", "task_terminal", "merge_conflict_resolved", "merge_retry_requested"].includes(event.kind)) {
            void refresh(true);
          }
        } catch {
          // Ignore malformed events and keep the stream alive.
        }
      };
      source.onerror = () => {
        source?.close();
        activateFallback(false);
      };
    };
    void connect();
    return () => {
      cancelled = true;
      source?.close();
      removeFallbackListener?.();
    };
  }, [eventStreamEpoch, eventStreamUrl, refresh, selectedWorkflow?.id, selectedWorkflow?.phase]);
  const targetId = continuation?.agentId ?? (enabledAgents.some((agent) => agent.id === agentId) ? agentId
    : enabledAgents.find((agent) => agent.id === snapshot?.config.defaultAgentId)?.id ?? enabledAgents[0]?.id ?? "");
  const targetAgent = enabledAgents.find((agent) => agent.id === targetId);
  const targetUnavailable = snapshot?.availability?.find((item) => item.id === targetId)?.available === false;
  // 同一 Agent 运行中的任务未达并发上限时直接启动，达到上限时排队、任一结束后按提交顺序启动；
  // 只有排队已满才禁止提交（#2772、#2800）。
  const reportedConcurrencyMax = snapshot?.capabilities?.maxConcurrentTasksLimit;
  const concurrencyMax = Number.isInteger(reportedConcurrencyMax) && (reportedConcurrencyMax as number) > 0
    ? reportedConcurrencyMax as number : DEFAULT_MAX_CONCURRENT_TASKS_LIMIT;
  const concurrencyLimit = (id: string) => normalizeConcurrency(snapshot?.config.agents.find((agent) => agent.id === id)?.maxConcurrentTasks);
  const targetQueue = agentQueueState(tasks, targetId, snapshot?.capabilities?.maxQueuedPerAgent, concurrencyLimit(targetId));
  const targetCwd = continuation?.cwd ?? cwd;
  const workflowAgent = (preferred: string, fallbackIndex: number) => enabledAgents.some((agent) => agent.id === preferred)
    ? preferred : enabledAgents[fallbackIndex]?.id ?? enabledAgents[0]?.id ?? "";
  const plannerTargetId = workflowAgent(workflowPlannerId, 0);
  const reviewerTargetId = workflowAgent(workflowReviewerId, 1);
  const executorTargetId = workflowAgent(workflowExecutorId, 0);
  const workflowDisabledReason = !snapshot ? "正在读取协作配置。"
    : !snapshot.config.enabled ? "请先启用外部子 Agent 并保存设置。"
    : enabledAgents.length < 2 ? "三省流程至少需要启用两个不同 Agent。"
    : !plannerTargetId || !reviewerTargetId || !executorTargetId ? "请为规划、审核和执行选择可用 Agent。"
    : plannerTargetId === reviewerTargetId ? "规划 Agent 与独立审核 Agent 必须不同。"
    : !cwd.trim() ? "请填写工作目录。"
    : !absolutePath(cwd) ? "请填写工作目录的绝对路径。"
    : !workflowObjective.trim() ? "请填写三省工作流目标。"
    : "";
  // 并发任务共用工作目录时只提示、不阻止（#2800）。
  const trimmedCwd = (value: string) => value.trim().replace(/[\\/]+$/, "");
  const sameCwdRunning = targetCwd.trim() ? tasks.filter((task) => task.status === "running" && trimmedCwd(task.cwd) === trimmedCwd(targetCwd)).length : 0;
  const formDisabledReason = !snapshot ? "正在读取协作配置。"
    : !snapshot.config.enabled ? "请先启用外部子 Agent 并保存设置。"
    : !targetAgent ? "请先启用至少一个 CLI 并保存配置。"
    : targetUnavailable ? "目标 CLI 的可执行文件不可用，请检查路径并保存。"
    : targetQueue.full ? tf("此 Agent 的排队任务已达上限（{0} 个），请等待前面的任务结束或取消部分排队任务。", [targetQueue.limit])
    : continuation && (continuation.status !== "completed" || !continuation.sessionId) ? "该任务目前无法续聊，请创建新任务。"
    : "";
  const agentName = (id: string) => snapshot?.config.agents.find((agent) => agent.id === id)?.name ?? id;
  // 任务列表顶部按 Agent 汇总并发与排队情况（#2800）：只列出有未结束任务的 Agent。
  const agentLoads = (snapshot?.config.agents ?? [])
    .map((agent) => ({ agent, state: agentQueueState(tasks, agent.id, snapshot?.capabilities?.maxQueuedPerAgent, concurrencyLimit(agent.id)) }))
    .filter(({ state }) => state.active > 0);
  const runningTaskCount = tasks.filter((task) => task.status === "running").length;
  const queuedTaskCount = tasks.filter((task) => task.status === "queued").length;
  const completedTaskCount = tasks.filter((task) => task.status === "completed").length;
  const activeTaskCount = runningTaskCount + queuedTaskCount;
  const runtimeRefreshing = busy === "connect_codex" || busy === "refresh_codex";
  const runtimeSucceeded = runtimeReady(runtime);
  const connectCodex = () => {
    if (dirtyRef.current) { setActionError("请先保存子 Agent 设置，再接入 Codex。"); return; }
    void mutate("connect_codex", {}, (next) => {
      if (next.integration?.status === "connected") {
        setNotice(runtimeReady(next.runtime)
          ? "已接入配置，Codex 工具已刷新。刷新后的工具从下一轮消息起可用。"
          : "已接入配置；运行中的 Codex 工具是否已刷新，请查看下方运行状态。");
      } else {
        setActionError(next.integration?.message || "尚未完成 Codex 接入，请检查配置后重试。");
      }
    });
  };
  const refreshCodex = () => {
    if (dirtyRef.current) { setActionError("请先保存子 Agent 设置，再刷新 Codex 工具。"); return; }
    void mutate("refresh_codex", {}, (next) => {
      if (runtimeReady(next.runtime)) setNotice("Codex 工具已刷新。刷新后的工具从下一轮消息起可用。");
      else if (!next.runtime) setActionError("未取得 Codex 工具刷新结果，请重试或手动重新加载 MCP。");
    });
  };

  const submitTask = (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current || formDisabledReason) return;
    if (!absolutePath(targetCwd)) { setActionError("请填写工作目录的绝对路径。"); return; }
    if (!prompt.trim()) { setActionError("请填写要交给 Agent 的任务。"); return; }
    const previousIds = new Set(tasks.map((task) => task.id));
    void mutate("submit", {
      agentId: targetId,
      prompt: prompt.trim(),
      cwd: targetCwd.trim(),
      ...(continuation ? { continueTaskId: continuation.id } : {}),
    }, (next) => {
      const created = [...next.tasks].sort((a, b) => b.createdAtMs - a.createdAtMs).find((task) => !previousIds.has(task.id));
      if (created) setSelectedId(created.id);
      setPrompt("");
      setContinueTaskId("");
      setCwd(targetCwd);
      setNotice(targetQueue.willQueue ? t("任务已提交并进入排队，前面的任务结束后自动启动。") : "任务已提交，可在下方查看执行状态。");
    });
  };
  const dispatchWorkflow = (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current || workflowDisabledReason) return;
    const previousIds = new Set(workflows.map((workflow) => workflow.id));
    void mutate("sansheng_dispatch", {
      objective: workflowObjective.trim(),
      cwd: cwd.trim(),
      plannerAgentId: plannerTargetId,
      reviewerAgentId: reviewerTargetId,
      executorAgentId: executorTargetId,
      allowedAgentIds: [...new Set([plannerTargetId, reviewerTargetId, executorTargetId])],
      maxReviewRounds: Number(workflowMaxReviewRounds) === 1 ? 1 : 2,
    }, (next) => {
      const created = [...(next.workflows ?? [])].sort((a, b) => b.createdAtMs - a.createdAtMs).find((workflow) => !previousIds.has(workflow.id));
      if (created) setSelectedWorkflowId(created.id);
      setWorkflowObjective("");
      setNotice("三省工作流已启动；流程会自动规划、审核、执行并停在待宰相验收。");
    });
  };
  const decideWorkflow = (workflow: WorkflowRecord, approved: boolean) => {
    void mutate("sansheng_accept", {
      workflowId: workflow.id,
      controllerId: workflow.controllerId,
      approved,
      notes: approved ? "宰相最终验收通过" : "宰相最终验收驳回，请检查门下省意见和执行结果。",
    }, () => setNotice(approved ? "宰相已准奏；如需自动合并，工作流会继续执行。" : "宰相已驳回，工作流终止。"));
  };
  const retryMerge = (workflow: WorkflowRecord) => {
    void mutate("sansheng_retry_merge", {
      workflowId: workflow.id,
      controllerId: workflow.controllerId,
    }, () => setNotice("已请求重新执行自动合并。"));
  };
  const resolveConflict = (workflow: WorkflowRecord, file: string, choice: "ours" | "theirs" | "custom", content?: string) => {
    void mutate("sansheng_resolve_conflict", {
      workflowId: workflow.id,
      controllerId: workflow.controllerId,
      file,
      choice,
      ...(choice === "custom" ? { content: content ?? "" } : {}),
    }, () => setNotice(`已记录 ${file} 的冲突决定。全部选择完成后可重新合并。`));
  };
  const loadConflictPreview = async (workflow: WorkflowRecord, file: string) => {
    const key = mergeConflictResolutionKey(workflow.mergeConflictTaskId ?? "", file);
    if (loadingConflictPreview === key) return;
    setLoadingConflictPreview(key);
    try {
      const preview = await invoke<MergeConflictPreview>("agent_collaboration_conflict_preview", {
        workflowId: workflow.id,
        file,
      });
      if (!mounted.current) return;
      setLoadedConflictPreviews((current) => ({ ...current, [key]: preview }));
      setManualConflictDrafts((current) => {
        const inline = workflow.mergeConflictPreviews?.find((item) => item.file === file);
        return current[key] === undefined || current[key] === inline?.ours
          ? { ...current, [key]: preview.ours }
          : current;
      });
    } catch (error) {
      setActionError(`加载 ${file} 冲突差异失败：${errorText(error)}`);
    } finally {
      if (mounted.current) setLoadingConflictPreview((current) => current === key ? "" : current);
    }
  };
  const clampDagScale = (value: number) => Math.min(1.8, Math.max(0.5, value));
  const zoomDag = (delta: number) => setDagScale((current) => clampDagScale(current + delta));
  const startDagPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".agent-collaboration-dag-node")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dagDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: dagOffset.x,
      originY: dagOffset.y,
    };
  };
  const moveDagPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dagDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setDagOffset({
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    });
  };
  const endDagPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dagDragRef.current?.pointerId !== event.pointerId) return;
    dagDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const resetDagView = () => {
    setDagScale(1);
    setDagOffset({ x: 0, y: 0 });
  };
  useEffect(() => {
    const viewport = dagViewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      setDagScale((current) => clampDagScale(current + (event.deltaY > 0 ? -0.1 : 0.1)));
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, []);
  const cancelWorkflow = (workflow: WorkflowRecord) => {
    void mutate("sansheng_cancel", {
      workflowId: workflow.id,
      controllerId: workflow.controllerId,
    }, () => setNotice("已请求取消三省工作流及其未完成子任务。"));
  };
  const continueTask = (task: TaskRecord) => {
    setContinueTaskId(task.id);
    setAgentId(task.agentId);
    setCwd(task.cwd);
    setPrompt("");
    setActionError("");
    setNotice("");
    promptRef.current?.focus();
  };
  const loadMcpConfig = async () => {
    if (mcpInFlight.current) return;
    mcpInFlight.current = true;
    const epoch = lifecycle.current;
    setMcpLoading(true);
    setMcpError("");
    setCopied("");
    try {
      const result = await invoke<McpConfig>("agent_collaboration_request", { action: "mcp_config", payload: {} });
      if (mounted.current && lifecycle.current === epoch) setMcpConfig(result);
    } catch (error) {
      if (mounted.current && lifecycle.current === epoch) setMcpError(errorText(error));
    } finally {
      if (mounted.current && lifecycle.current === epoch) {
        mcpInFlight.current = false;
        setMcpLoading(false);
      }
    }
  };
  const copyText = async (value: string, label: string) => {
    const epoch = lifecycle.current;
    try {
      await navigator.clipboard.writeText(value);
      if (mounted.current && lifecycle.current === epoch) { setCopied(label); setMcpError(""); }
    } catch (error) {
      if (mounted.current && lifecycle.current === epoch) setMcpError(`复制失败：${errorText(error)}`);
    }
  };

  return <div className="mg-page agent-collaboration-page">
    <PageHeader icon={<ArrowRightLeft size={20} strokeWidth={1.5} />} title="Agent 编排台" actions={
      <button className="mg-button" type="button" onClick={() => void refresh()} disabled={refreshing || Boolean(busy)}>
        <RefreshCw size={15} className={refreshing ? "agent-collaboration-spin" : ""} />{refreshing ? "刷新中…" : "刷新"}
      </button>
    } />
    <div className="agent-collaboration-content" aria-busy={!snapshot && refreshing}>
      <div className="agent-collaboration-intro">
        <p>Codex++ 作为总调度，把任务派给 Codex、DeepSeek Harness 与 Claude Code，并在这里集中查看队列、执行状态和结果。</p>
        <div className="agent-collaboration-examples" aria-label="在 Codex 对话中的用法"><span>“让 DeepSeek 实现这个功能”</span><span>“让 Claude Code 审核这次改动”</span><span>“让 WorkBuddy 做第二轮审阅”</span><span>“让 Trae 处理这个项目任务”</span></div>
        <p className="agent-collaboration-hint">先启用 Agent 并接入 Codex，然后直接派发任务；并发任务请使用不同的工作目录或 worktree。</p>
      </div>

      <section className="agent-collaboration-overview" aria-labelledby="agent-collaboration-overview-title">
        <div className="agent-collaboration-overview-head">
          <div><h2 id="agent-collaboration-overview-title">编排概览</h2><p>先看谁在运行、谁在排队，再进入任务详情。</p></div>
          <span className="agent-collaboration-status" data-status={activeTaskCount > 0 ? "running" : "completed"}>{activeTaskCount > 0 ? `${activeTaskCount} 个活动任务` : "当前空闲"}</span>
        </div>
        <div className="agent-collaboration-overview-stats">
          {[
            ["运行中", runningTaskCount],
            ["队列中", queuedTaskCount],
            ["已完成", completedTaskCount],
            ["启用 Agent", enabledAgents.length],
          ].map(([label, value]) => <div className="agent-collaboration-overview-stat" key={label}><strong>{value}</strong><span>{label}</span></div>)}
        </div>
        <div className="agent-collaboration-overview-agents" aria-label="Agent 状态">
          {enabledAgents.length > 0 ? enabledAgents.map((agent) => {
            const load = agentLoads.find((item) => item.agent.id === agent.id)?.state;
            const availability = snapshot?.availability?.find((item) => item.id === agent.id);
            return <div className="agent-collaboration-overview-agent" key={agent.id}>
              <strong>{agent.name}</strong>
              <span data-state={availability?.available === false ? "warning" : availability?.available === true ? "ready" : "idle"}>{availability?.available === false ? "CLI 不可用" : availability?.available === true ? "CLI 就绪" : "待检测"}</span>
              <small>{load ? `运行 ${load.running}/${load.concurrency} · 排队 ${load.queued}` : "空闲"}</small>
            </div>;
          }) : <p className="agent-collaboration-hint">尚未启用任何子 Agent。</p>}
        </div>
      </section>

      {readError && <p className="agent-collaboration-error" role="alert">读取协作状态失败：{readError}</p>}
      {actionError && <p className="agent-collaboration-error" role="alert">操作失败：{actionError}</p>}
      {notice && <p className="agent-collaboration-notice" role="status">{notice}</p>}
      {!snapshot && refreshing && <p className="agent-collaboration-loading" role="status"><Loader2 size={15} className="agent-collaboration-spin" />正在读取协作配置…</p>}

      <section className="agent-collaboration-section" aria-labelledby="agent-collaboration-config-title">
        <div className="agent-collaboration-section-head">
          <div><h2 id="agent-collaboration-config-title">子 Agent 配置</h2><p>选择可调用的 CLI、MCP 适配器与默认模型。路径留空时自动查找已安装的程序。</p></div>
          <button type="button" className="mg-button mg-primary" disabled={!snapshot || !dirty || Boolean(busy)} onClick={saveConfig}>
            {busy === "save_config" ? <Loader2 size={15} className="agent-collaboration-spin" /> : <Save size={15} />}{busy === "save_config" ? "保存中…" : "保存配置"}
          </button>
        </div>
        <label className="agent-collaboration-enable">
          <input type="checkbox" checked={draft.enabled} disabled={!snapshot || busy === "save_config"} onChange={(event) => editConfig({ ...draft, enabled: event.target.checked })} />
          <span><strong>启用外部子 Agent</strong><small>默认关闭，保存后生效。</small></span>
          <span className="mg-badge">{snapshot?.config.enabled ? "已启用" : "未启用"}</span>
        </label>
        <div className="agent-collaboration-default">
          <div className="mg-field"><span>默认子 Agent</span><AppSelect ariaLabel="默认子 Agent" disabled={!snapshot || busy === "save_config"} id="agent-collaboration-default" onChange={(next) => editConfig({ ...draft, defaultAgentId: next })} options={draft.agents.map((agent) => ({ value: agent.id, label: `${agent.name}${agent.enabled ? "" : "（未启用）"}` }))} value={draft.defaultAgentId} /></div>
          <label className="mg-field" htmlFor="agent-collaboration-runtime"><span>单个任务运行上限（分钟）</span><input id="agent-collaboration-runtime" type="number" min={1} max={maxRuntimeMinutesLimit} step={1} value={runtimeText} disabled={!snapshot || busy === "save_config"} aria-invalid={parsedRuntimeMinutes(runtimeText) === null} onChange={(event) => editRuntimeText(event.target.value)} onBlur={() => { if (parsedRuntimeMinutes(runtimeText) === null) setRuntimeText(String(draft.maxRuntimeMinutes)); }} /></label>
          <p className="agent-collaboration-hint">说“交给默认子 Agent”时使用此选择；直接说“让 DeepSeek”或“让 Claude Code”时使用指定的子 Agent。子 Agent 任务超过运行上限（1–240 分钟，默认 10）会被终止。{draft.enabled && !draft.agents.some((agent) => agent.id === draft.defaultAgentId && agent.enabled) && " 所选默认子 Agent 尚未启用，默认分派不可用；仍可点名调用其他已启用的子 Agent。"}</p>
        </div>
        <div className="agent-collaboration-agents">
          {draft.agents.map((agent) => {
            const savedAgent = snapshot?.config.agents.find((item) => item.id === agent.id);
            const savedPath = savedAgent?.executable === agent.executable.trim();
            const availability = savedPath ? snapshot?.availability?.find((item) => item.id === agent.id) : undefined;
            const available = availability?.available;
            return <div className="agent-collaboration-agent" key={agent.id}>
              <label className="agent-collaboration-agent-title"><input type="checkbox" checked={agent.enabled} disabled={!snapshot || busy === "save_config"} onChange={(event) => editAgent(agent.id, { enabled: event.target.checked })} /><strong>{agent.name}</strong></label>
              <label className="mg-field" htmlFor={`agent-collaboration-path-${agent.id}`}><span>可执行文件或适配器路径（可选）</span><input id={`agent-collaboration-path-${agent.id}`} value={agent.executable} disabled={!snapshot || busy === "save_config"} placeholder={availability?.path || (agent.id === "workbuddy" ? "留空自动查找 WorkBuddy MCP 桥接" : agent.id === "trae" ? "留空自动查找 Trae CN CLI" : "留空自动查找已安装的 CLI")} spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(event) => editAgent(agent.id, { executable: event.target.value })} /></label>
              <label className="mg-field" htmlFor={`agent-collaboration-model-${agent.id}`}><span>{agent.id === "deepseek" ? "模型路由（可选）" : agent.id === "workbuddy" ? "WorkBuddy 起始模型" : agent.id === "trae" ? "Trae 模型（由窗口选择）" : "模型（可选）"}</span><input id={`agent-collaboration-model-${agent.id}`} value={agent.model} disabled={!snapshot || busy === "save_config" || agent.id === "trae"} placeholder={agent.id === "deepseek" ? "deepseek-account/deepseek-flash" : agent.id === "workbuddy" ? "hy3 / hy4-preview / glm-5.3-flash" : agent.id === "trae" ? "请在 Trae 窗口内选择模型" : "留空沿用该 CLI 默认模型"} spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-describedby={agent.id === "deepseek" ? "agent-collaboration-deepseek-model-hint" : agent.id === "workbuddy" ? "agent-collaboration-workbuddy-model-hint" : undefined} onChange={(event) => editAgent(agent.id, { model: event.target.value })} />{agent.id === "deepseek" && <small id="agent-collaboration-deepseek-model-hint">使用 provider/model 格式。账户登录用 deepseek-account，API 密钥用 deepseek-official；留空沿用 headless 默认模型。</small>}{agent.id === "workbuddy" && <small id="agent-collaboration-workbuddy-model-hint">默认从 hy3 开始；凌晨自动把 hy4-preview 加入候选；两者额度都不可用时切到 glm-5.3-flash。WorkBuddy 是纯文字适配器。</small>}{agent.id === "trae" && <small>Trae 的模型由已打开的 Agent 窗口决定，这里不注入模型名。</small>}</label>
              <div className="mg-field"><span>{t("同时执行任务数")}</span><AppSelect ariaLabel={tf("{0} 同时执行任务数", [agent.name])} disabled={!snapshot || busy === "save_config"} id={`agent-collaboration-concurrency-${agent.id}`} onChange={(next) => editAgent(agent.id, { maxConcurrentTasks: normalizeConcurrency(Number(next), concurrencyMax) })} options={Array.from({ length: concurrencyMax }, (_, index) => ({ value: String(index + 1), label: index === 0 ? t("1（逐个执行，其余排队）") : String(index + 1) }))} value={String(agent.maxConcurrentTasks)} /><small className="agent-collaboration-agent-note">{t("同一 Agent 最多同时运行的任务数。超出时排队，任一任务结束后按提交顺序启动下一个；并发任务请使用不同的工作目录，避免互相修改相同文件。")}</small></div>
              <small className="agent-collaboration-agent-state" data-unavailable={available === false}>{!savedPath ? "路径尚未保存" : availability?.recovered ? "已保存的路径已失效（应用更新后目录可能变化），本次自动使用当前路径；清空路径保存可一直自动查找" : available === true ? agent.id === "workbuddy" ? "已找到 MCP 桥接；登录状态在执行时验证" : agent.id === "trae" ? "已找到 Trae CLI；工作区与账号额度在执行时验证" : "已找到执行文件" : availability?.configuredMissing ? "已保存的路径不存在；清空路径保存可自动查找，或重新填写" : available === false ? "未找到执行文件" : agent.executable.trim() ? "已配置，执行任务时验证" : "留空自动查找已安装的程序"}{availability?.path && <code>{availability.path}</code>}</small>
              {agent.id === "deepseek" && <>
                <label className="agent-collaboration-auth"><input type="checkbox" checked={agent.reuseSavedAuth} disabled={!snapshot || busy === "save_config"} aria-describedby="agent-collaboration-deepseek-auth-hint" onChange={(event) => editAgent(agent.id, { reuseSavedAuth: event.target.checked })} /><span>复用 DSH 已保存的登录与密钥</span></label>
                <small id="agent-collaboration-deepseek-auth-hint" className="agent-collaboration-agent-note">默认关闭。开启后由 dsh 自行读取已保存的认证，Codex++ 不读取或保存登录与密钥；不会自动选择桌面当前使用的模型。</small>
              </>}
            </div>;
          })}
        </div>
        <p className="agent-collaboration-hint">路径检测只确认 CLI 文件存在，登录状态在执行任务时验证。{dirty && " 有未保存的修改；子 Agent 使用已保存的配置。"}</p>
      </section>

      <section className="agent-collaboration-section agent-collaboration-integration" aria-labelledby="agent-collaboration-mcp-title">
        <div className="agent-collaboration-section-head"><div><h2 id="agent-collaboration-mcp-title">在 Codex 对话中使用</h2><p>接入会登记子 Agent 工具，并尝试在本机 Codex 中刷新。已登记配置可单独刷新工具。</p></div><div className="agent-collaboration-integration-actions">
          <button type="button" className="mg-button" disabled={!snapshot || Boolean(busy) || dirty} onClick={refreshCodex}>{busy === "refresh_codex" ? <Loader2 size={15} className="agent-collaboration-spin" /> : <RefreshCw size={15} />}{busy === "refresh_codex" ? "刷新中…" : "刷新 Codex 工具"}</button>
          <button type="button" className="mg-button mg-primary" disabled={!snapshot || Boolean(busy) || dirty} onClick={connectCodex}>{busy === "connect_codex" ? <Loader2 size={15} className="agent-collaboration-spin" /> : <ArrowRightLeft size={15} />}{busy === "connect_codex" ? "接入并刷新中…" : "一键接入并刷新"}</button>
        </div></div>
        <div className="agent-collaboration-integration-state" data-status={snapshot?.integration?.status ?? "not_connected"} role="status"><strong>{!snapshot ? "正在读取接入状态…" : snapshot.integration?.status === "connected" ? "已接入配置" : snapshot.integration?.status === "conflict" ? "接入配置有冲突" : snapshot.integration?.status === "not_connected" ? "尚未接入 Codex" : "尚未检测到接入配置"}</strong><span>{snapshot?.integration?.message || "保存子 Agent 设置后，点击“一键接入并刷新”。"}</span></div>
        {(snapshot?.integration?.home || snapshot?.integration?.configPath) && <p className="agent-collaboration-hint">{snapshot?.integration?.home ? "Codex 配置目录：" : "Codex 配置文件："}<code>{snapshot?.integration?.home || snapshot?.integration?.configPath}</code></p>}
        <div className="agent-collaboration-runtime-state" data-status={runtimeRefreshing ? "refreshing" : runtimeSucceeded ? "ready" : runtime?.status === "ready" ? "partial" : runtime?.status ?? "unchecked"} role="status" aria-busy={runtimeRefreshing}>
          <small>运行中的 Codex · 最近一次工具刷新</small>
          <strong>{runtimeRefreshing ? "正在刷新 Codex 工具…" : runtimeSucceeded ? "Codex 工具已刷新" : runtime?.status === "unavailable" ? "暂未连接到 Codex 运行时" : runtime?.status === "error" ? "工具刷新失败" : runtime?.toolsReady ? "子 Agent 工具已就绪，列表待确认" : runtime ? "工具刷新尚未完成" : "尚未检查运行中的 Codex 工具"}</strong>
          <span>{runtimeRefreshing ? "正在重新加载本机 MCP 配置、检查子 Agent 工具并刷新列表缓存。" : runtime?.message || "点击“刷新 Codex 工具”，检查子 Agent 工具是否已在本机 Codex 中加载。"}</span>
          {runtime && !runtimeRefreshing && <div className="agent-collaboration-runtime-steps"><span data-complete={runtime.reloadSucceeded === true}>{runtime.reloadSucceeded ? "MCP 已重载" : "MCP 重载未确认"}</span><span data-complete={runtime.toolsReady === true}>{runtime.toolsReady ? `已找到子 Agent 工具${runtime.toolCount > 0 ? `（${runtime.toolCount} 个）` : ""}` : "子 Agent 工具未确认"}</span><span data-complete={runtime.cacheRefreshed === true}>{runtime.cacheRefreshed ? "工具列表缓存已刷新" : "工具列表刷新待确认"}</span></div>}
          {runtime?.status === "unavailable" && !runtimeRefreshing && <span>请用 Codex++ 启动或接管 Codex 后重试，也可在 Codex 中手动重新加载 MCP。</span>}
        </div>
        <p className="agent-collaboration-hint">Codex 的 MCP 工具列表可能缓存约 5 分钟，刷新会重新加载配置并更新列表缓存。</p>
        <p className="agent-collaboration-hint">刷新后的工具从下一轮消息起可用，当前正在进行的回合不会中途增加工具。也可手动重新加载 MCP 或开启新对话。{dirty && " 请先保存设置，再接入或刷新。"}</p>
        <details className="agent-collaboration-manual"><summary>手动接入与配置导出</summary><div className="agent-collaboration-manual-body">
          <p className="agent-collaboration-hint">也可以复制配置，合并到对应客户端的 MCP 设置后重新连接。</p>
          <button type="button" className="mg-button" disabled={mcpLoading || !snapshot || Boolean(busy)} onClick={() => void loadMcpConfig()}>{mcpLoading ? <Loader2 size={15} className="agent-collaboration-spin" /> : <Copy size={15} />}{mcpLoading ? "读取中…" : mcpConfig ? "重新生成配置" : "生成手动配置"}</button>
          {mcpError && <p className="agent-collaboration-error" role="alert">{mcpError}</p>}
          {copied && <p className="agent-collaboration-notice" role="status">{copied}已复制。</p>}
          {mcpConfig && <div className="agent-collaboration-mcp-configs">
            {[{ label: "Codex 配置", value: mcpConfig.codexToml }, { label: "Claude 配置", value: mcpConfig.claudeJson }].map((item) => <div className="agent-collaboration-mcp-code" key={item.label}><div><h3>{item.label}</h3><button type="button" className="mg-button" onClick={() => void copyText(item.value, item.label)}>{copied === item.label ? <Check size={14} /> : <Copy size={14} />}复制</button></div><pre tabIndex={0} aria-label={item.label}>{item.value}</pre></div>)}
            <details className="agent-collaboration-mcp-command"><summary>其他 MCP 客户端的启动参数</summary><pre tabIndex={0}>{JSON.stringify({ command: mcpConfig.command, args: mcpConfig.args }, null, 2)}</pre></details>
          </div>}
        </div></details>
      </section>

      <section className="agent-collaboration-run-console" aria-labelledby="agent-collaboration-console-title">
      <div className="agent-collaboration-run-console-head"><div><h2 id="agent-collaboration-console-title">任务编排</h2><p>派发任务、控制队列并查看每个 Agent 的返回结果。</p></div><span className="agent-collaboration-count">{tasks.length} 个任务</span></div>
      <div className="agent-collaboration-run-console-body">
      <section className="agent-collaboration-section agent-collaboration-workflows" aria-labelledby="agent-collaboration-workflows-title">
        <div className="agent-collaboration-section-head"><div><h2 id="agent-collaboration-workflows-title">三省工作流 <span className="agent-collaboration-count">{workflows.length}</span></h2><p>规划、独立审核、执行、结果复核自动推进；root 只做方向裁定和最终验收。</p></div></div>
        <form className="agent-collaboration-workflow-form" onSubmit={dispatchWorkflow}>
          <div className="agent-collaboration-workflow-agent-grid">
            <div className="mg-field"><span>中书 · 规划</span><AppSelect ariaLabel="三省规划 Agent" disabled={Boolean(busy) || !enabledAgents.length} id="agent-collaboration-workflow-planner" onChange={setWorkflowPlannerId} options={enabledAgents.map((agent) => ({ value: agent.id, label: agent.name }))} placeholder="请先启用 Agent" value={plannerTargetId} /></div>
            <div className="mg-field"><span>门下 · 审核</span><AppSelect ariaLabel="三门下审核 Agent" disabled={Boolean(busy) || !enabledAgents.length} id="agent-collaboration-workflow-reviewer" onChange={setWorkflowReviewerId} options={enabledAgents.map((agent) => ({ value: agent.id, label: agent.name }))} placeholder="请先启用 Agent" value={reviewerTargetId} /></div>
            <div className="mg-field"><span>尚书 · 执行</span><AppSelect ariaLabel="三省执行 Agent" disabled={Boolean(busy) || !enabledAgents.length} id="agent-collaboration-workflow-executor" onChange={setWorkflowExecutorId} options={enabledAgents.map((agent) => ({ value: agent.id, label: agent.name }))} placeholder="请先启用 Agent" value={executorTargetId} /></div>
            <div className="mg-field"><span>封驳上限</span><AppSelect ariaLabel="方案审核轮数" disabled={Boolean(busy)} id="agent-collaboration-workflow-rounds" onChange={setWorkflowMaxReviewRounds} options={[{ value: "1", label: "1 轮" }, { value: "2", label: "2 轮" }]} value={workflowMaxReviewRounds} /></div>
          </div>
          <label className="mg-field" htmlFor="agent-collaboration-workflow-cwd"><span>工作目录</span><input id="agent-collaboration-workflow-cwd" value={cwd} disabled={Boolean(busy)} placeholder="F:\\absolute\\path" spellCheck={false} onChange={(event) => setCwd(event.target.value)} /></label>
          <label className="mg-field" htmlFor="agent-collaboration-workflow-objective"><span>总目标与验收边界</span><textarea id="agent-collaboration-workflow-objective" rows={4} value={workflowObjective} disabled={Boolean(busy)} placeholder="写清目标、范围、限制和什么结果算完成；规划代理会产出结构化子任务。" onChange={(event) => setWorkflowObjective(event.target.value)} /></label>
          <div className="agent-collaboration-workflow-submit"><p className="agent-collaboration-hint">{workflowDisabledReason || "规划和审核必须使用不同 Agent；执行默认 Agent 可复用其中之一。"}</p><button type="submit" className="mg-button mg-primary" disabled={Boolean(busy) || Boolean(workflowDisabledReason)}>{busy === "sansheng_dispatch" ? <Loader2 size={15} className="agent-collaboration-spin" /> : <Play size={15} />}{busy === "sansheng_dispatch" ? "启动中…" : "启动三省工作流"}</button></div>
        </form>
        {workflows.length > 0 && <div className="agent-collaboration-workflow-workspace">
          <ul className="agent-collaboration-workflow-list" aria-label="三省工作流">
            {workflows.map((workflow) => <li key={workflow.id}><button type="button" aria-pressed={workflow.id === selectedWorkflowId} onClick={() => setSelectedWorkflowId(workflow.id)}><span><strong>{workflow.phase === "awaiting_acceptance" ? "待准奏：" : ""}{workflow.objective}</strong><small>{workflow.phase === "planning" ? "规划" : workflow.phase === "plan_review" ? `审议 ${workflow.reviewRound}/${workflow.maxReviewRounds}` : workflow.phase === "executing" ? `执行 ${workflow.plan?.subtasks.length ?? 0} 项` : workflow.phase === "result_review" ? "结果复核" : workflowPhaseLabels[workflow.phase]}</small></span><span className="agent-collaboration-status" data-status={workflow.phase === "completed" ? "completed" : workflow.phase === "failed" || workflow.phase === "blocked" || workflow.phase === "merge_conflict" ? "failed" : workflow.phase === "cancelled" ? "cancelled" : "running"}>{workflowPhaseLabels[workflow.phase]}</span></button></li>)}
          </ul>
          {selectedWorkflow && <div className="agent-collaboration-workflow-detail" key={selectedWorkflow.id}>
            <div className="agent-collaboration-detail-head"><div><h3>{selectedWorkflow.objective}</h3><span className="agent-collaboration-status" data-status={selectedWorkflow.phase === "completed" ? "completed" : selectedWorkflow.phase === "failed" || selectedWorkflow.phase === "blocked" || selectedWorkflow.phase === "merge_conflict" ? "failed" : selectedWorkflow.phase === "cancelled" ? "cancelled" : "running"}>{workflowPhaseLabels[selectedWorkflow.phase]}</span></div><div className="agent-collaboration-detail-actions">
              {selectedWorkflow.phase === "awaiting_acceptance" && <><button type="button" className="mg-button mg-primary" disabled={Boolean(busy)} onClick={() => decideWorkflow(selectedWorkflow, true)}><Check size={13} />准奏</button><button type="button" className="mg-button" disabled={Boolean(busy)} onClick={() => decideWorkflow(selectedWorkflow, false)}>驳回</button></>}
              {selectedWorkflow.phase === "merge_conflict" && <button type="button" className="mg-button mg-primary" disabled={Boolean(busy) || unresolvedMergeConflicts.length > 0} title={unresolvedMergeConflicts.length ? "请先为全部冲突文件选择处理方式" : "重新执行自动合并"} onClick={() => retryMerge(selectedWorkflow)}><RefreshCw size={13} />重新合并</button>}
              {!["completed", "failed", "cancelled"].includes(selectedWorkflow.phase) && <button type="button" className="mg-button" disabled={Boolean(busy) || selectedWorkflow.cancelRequested} onClick={() => cancelWorkflow(selectedWorkflow)}><Square size={13} />取消工作流</button>}
            </div></div>
            <dl className="agent-collaboration-task-meta"><dt>规划 / 审核 / 执行</dt><dd>{agentName(selectedWorkflow.plannerAgentId)} / {agentName(selectedWorkflow.reviewerAgentId)} / {agentName(selectedWorkflow.executorAgentId)}</dd><dt>工作目录</dt><dd>{selectedWorkflow.cwd}</dd><dt>计划版本</dt><dd>{selectedWorkflow.planRevision} · {selectedWorkflow.plan?.subtasks.length ?? 0} 个子任务</dd><dt>审核 / 修复</dt><dd>{selectedWorkflow.reviewRound}/{selectedWorkflow.maxReviewRounds} · 结果复核 {selectedWorkflow.resultReviewRound} · 修复 {selectedWorkflow.repairCount}</dd><dt>更新时间</dt><dd>{formatTime(selectedWorkflow.updatedAtMs)}</dd></dl>
            {selectedWorkflow.plan && <div className="agent-collaboration-output">
              <h4>依赖图与执行状态</h4>
              {workflowDag && workflowDag.nodes.length > 0 && <>
                <div className="agent-collaboration-dag-toolbar">
                  <span>{Math.round(dagScale * 100)}%</span>
                  <button type="button" className="mg-icon-button" aria-label="缩小依赖图" title="缩小" onClick={() => zoomDag(-0.1)}><ZoomOut size={14} /></button>
                  <button type="button" className="mg-icon-button" aria-label="放大依赖图" title="放大" onClick={() => zoomDag(0.1)}><ZoomIn size={14} /></button>
                  <button type="button" className="mg-icon-button" aria-label="重置依赖图视图" title="重置视图" onClick={resetDagView}><Maximize2 size={14} /></button>
                </div>
                <div
                  className="agent-collaboration-dag-viewport"
                  ref={dagViewportRef}
                  role="region"
                  aria-label="可拖拽和缩放的依赖图"
                  onPointerDown={startDagPan}
                  onPointerMove={moveDagPan}
                  onPointerUp={endDagPan}
                  onPointerCancel={endDagPan}
                >
                  <div
                    className="agent-collaboration-dag-stage"
                    style={{
                      width: workflowDag.width,
                      height: workflowDag.height,
                      transform: `translate(${dagOffset.x}px, ${dagOffset.y}px) scale(${dagScale})`,
                    }}
                  >
                    <svg aria-hidden="true" width={workflowDag.width} height={workflowDag.height} viewBox={`0 0 ${workflowDag.width} ${workflowDag.height}`}>
                      {workflowDag.edges.map(({ source, target }) => {
                        const x1 = source.x + source.width;
                        const y1 = source.y + source.height / 2;
                        const x2 = target.x;
                        const y2 = target.y + target.height / 2;
                        const bend = Math.max(20, (x2 - x1) / 2);
                        return <g key={`${source.subtask.id}-${target.subtask.id}`}><path d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`} /><circle cx={x2} cy={y2} r="3" /></g>;
                      })}
                    </svg>
                    {workflowDag.nodes.map((node) => <button
                      type="button"
                      className="agent-collaboration-dag-node"
                      data-status={displayWorkflowStatus(node.status)}
                      aria-pressed={selectedDagNodeId === node.subtask.id}
                      key={node.subtask.id}
                      style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
                      title={`${node.subtask.id} · ${node.subtask.title} · ${workflowSubtaskStatusLabels[node.status] ?? node.status}`}
                      onClick={() => setSelectedDagNodeId(node.subtask.id)}
                    >
                      <strong>{node.subtask.id} · {node.subtask.title}</strong>
                      <span>{agentName(node.subtask.agentId || selectedWorkflow.executorAgentId)} · {workflowSubtaskStatusLabels[node.status] ?? node.status}</span>
                    </button>)}
                  </div>
                </div>
                {selectedDagNode && <div className="agent-collaboration-dag-inspector">
                  <div><strong>{selectedDagNode.subtask.id} · {selectedDagNode.subtask.title}</strong><span className="agent-collaboration-status" data-status={displayWorkflowStatus(selectedDagNode.status)}>{workflowSubtaskStatusLabels[selectedDagNode.status] ?? selectedDagNode.status}</span></div>
                  <p>{selectedDagNode.subtask.expectedOutput}</p>
                  <small>执行：{agentName(selectedDagNode.subtask.agentId || selectedWorkflow.executorAgentId)} · 前置：{selectedDagNode.subtask.dependsOn?.join("、") || "无"}</small>
                  {selectedWorkflow.subtaskWorktrees?.[selectedDagNode.subtask.id] && <small>工作树：{selectedWorkflow.subtaskWorktrees[selectedDagNode.subtask.id].branchName} · {selectedWorkflow.subtaskWorktrees[selectedDagNode.subtask.id].changedFiles.length} 个变更文件</small>}
                </div>}
              </>}
              <ol className="agent-collaboration-subtask-list">{selectedWorkflow.plan.subtasks.map((subtask) => {
                const dependencies = subtask.dependsOn ?? [];
                const worktree = selectedWorkflow.subtaskWorktrees?.[subtask.id];
                const status = workflowSubtaskStatus(selectedWorkflow, subtask, tasks);
                return <li key={subtask.id}><div className="agent-collaboration-subtask-head"><strong>{subtask.id} · {subtask.title}</strong><span className="agent-collaboration-status" data-status={displayWorkflowStatus(status)}>{workflowSubtaskStatusLabels[status] ?? status}</span></div><span>{subtask.agentId ? agentName(subtask.agentId) : agentName(selectedWorkflow.executorAgentId)} · {subtask.expectedOutput}</span><small>{dependencies.length ? `前置：${dependencies.join("、")}` : "无前置依赖，可进入当前并行层"}{subtask.mergeMode === "auto" ? ` · 准奏后自动合并（${subtask.mergeStrategy || "merge"}）` : ""}</small>{worktree && <small>工作树：{worktree.path} · {worktree.branchName} · {worktree.changedFiles.length} 个变更文件 · {worktree.status}</small>}</li>;
              })}</ol>
            </div>}
            {(selectedWorkflow.mergeSummary || selectedWorkflow.mergeConflicts?.length) && <div className="agent-collaboration-output">
              <h4>自动合并结果</h4>
              {selectedWorkflow.mergeSummary && <span>{selectedWorkflow.mergeSummary}</span>}
              {selectedWorkflow.mergeCommit && <small>提交：{selectedWorkflow.mergeCommit}</small>}
              {Boolean(selectedWorkflow.mergeConflicts?.length) && selectedWorkflow.phase === "merge_conflict" && <div className="agent-collaboration-conflicts">
                {selectedWorkflow.mergeConflictTaskId && <small>冲突子任务：{selectedWorkflow.mergeConflictTaskId}</small>}
                {(selectedWorkflow.mergeConflicts ?? []).map((file) => {
                  const resolution = selectedWorkflow.mergeResolutions?.[mergeConflictResolutionKey(mergeConflictTaskId, file)];
                  const draftKey = mergeConflictResolutionKey(mergeConflictTaskId, file);
                  const inlinePreview = selectedWorkflow.mergeConflictPreviews?.find((item) => item.file === file);
                  const preview = loadedConflictPreviews[draftKey] ?? inlinePreview;
                  const draft = manualConflictDrafts[draftKey] ?? preview?.ours ?? "";
                  return <div className="agent-collaboration-conflict" key={file}>
                    <div className="agent-collaboration-conflict-head">
                      <code>{file}</code>
                      <div role="group" aria-label={`${file} 冲突处理方式`}>
                        <button type="button" className="mg-button" aria-pressed={resolution === "ours"} disabled={Boolean(busy)} onClick={() => resolveConflict(selectedWorkflow, file, "ours")}><GitMerge size={13} />保留集成版</button>
                        <button type="button" className="mg-button" aria-pressed={resolution === "theirs"} disabled={Boolean(busy)} onClick={() => resolveConflict(selectedWorkflow, file, "theirs")}><GitMerge size={13} />采用任务版</button>
                      </div>
                    </div>
                    <details className="agent-collaboration-conflict-editor" onToggle={(event) => {
                      if (event.currentTarget.open && (!preview || (preview.truncated && !loadedConflictPreviews[draftKey]))) {
                        void loadConflictPreview(selectedWorkflow, file);
                      }
                    }}>
                      <summary>{preview ? preview.binary ? "查看二进制冲突信息" : "查看三份版本并手工编辑" : "按需加载三份版本"}</summary>
                      {!preview && <><p className="agent-collaboration-hint">{loadingConflictPreview === draftKey ? "正在读取冲突版本…" : "打开后会从 Git 分支按需读取，不写入主分支。"}</p><button type="button" className="mg-button" disabled={loadingConflictPreview === draftKey} onClick={() => void loadConflictPreview(selectedWorkflow, file)}>{loadingConflictPreview === draftKey ? "读取中…" : "加载差异"}</button></>}
                      {preview?.binary ? <p className="agent-collaboration-hint">该文件是二进制、非 UTF-8 或预览无法安全解码，只能选择保留集成版或采用任务版。</p> : preview ? <>
                        <div className="agent-collaboration-conflict-columns">
                          <section><strong>共同基线</strong><pre tabIndex={0}>{preview.baseExists ? preview.base || "（空文件）" : "（基线中不存在）"}</pre></section>
                          <section><strong>当前集成版</strong><pre tabIndex={0}>{preview.oursExists ? preview.ours || "（空文件）" : "（集成版中不存在）"}</pre></section>
                          <section><strong>任务提交版</strong><pre tabIndex={0}>{preview.theirsExists ? preview.theirs || "（空文件）" : "（任务版中不存在）"}</pre></section>
                        </div>
                        {preview.truncated && <p className="agent-collaboration-hint">该版本超过预览上限，内容已截断；手工提交仍以 512 KiB 为上限。</p>}
                        <label className="mg-field agent-collaboration-conflict-draft"><span>最终文件内容</span><textarea rows={10} maxLength={524288} value={draft} spellCheck={false} onChange={(event) => { const value = event.target.value; setManualConflictDrafts((current) => ({ ...current, [draftKey]: value })); }} /></label>
                        <div className="agent-collaboration-conflict-editor-actions">
                          <button type="button" className="mg-button" disabled={Boolean(busy)} onClick={() => setManualConflictDrafts((current) => ({ ...current, [draftKey]: preview.ours }))}>填入集成版</button>
                          <button type="button" className="mg-button" disabled={Boolean(busy)} onClick={() => setManualConflictDrafts((current) => ({ ...current, [draftKey]: preview.theirs }))}>填入任务版</button>
                          <button type="button" className="mg-button mg-primary" aria-pressed={resolution === "custom"} disabled={Boolean(busy)} onClick={() => resolveConflict(selectedWorkflow, file, "custom", draft)}><Check size={13} />应用手工结果</button>
                        </div>
                      </> : null}
                    </details>
                  </div>;
                })}
                <small>{unresolvedMergeConflicts.length ? `还有 ${unresolvedMergeConflicts.length} 个冲突文件未选择。` : "全部冲突文件已选择，可重新合并。"}</small>
              </div>}
            </div>}
            {workflowEvents.length > 0 && <div className="agent-collaboration-output"><h4>事件流 <span className="agent-collaboration-event-transport" data-status={eventStreamStatus}>{eventStreamStatus === "live" ? "SSE 实时" : eventStreamStatus === "connecting" ? "正在连接 SSE" : eventStreamStatus === "snapshot" ? "已结束 · 快照" : "游标回退"}</span>{eventStreamStatus === "fallback" && !["completed", "failed", "cancelled"].includes(selectedWorkflow.phase) && <button type="button" className="mg-icon-button" aria-label="重新连接 SSE" title="重新连接 SSE" onClick={() => setEventStreamEpoch((value) => value + 1)}><RefreshCw size={12} /></button>}</h4><ol className="agent-collaboration-event-list" aria-live="polite">{workflowEvents.slice(-30).map((event) => <li key={event.seq}><strong>#{event.seq} · {event.kind}</strong><span>{formatTime(event.createdAtMs)} · {event.phase} · {event.message || "—"}</span></li>)}</ol></div>}
            {selectedWorkflow.reviewNotes && <div className="agent-collaboration-output"><h4>门下省意见</h4><pre tabIndex={0}>{selectedWorkflow.reviewNotes}</pre></div>}
            {selectedWorkflow.resultSummary && <div className="agent-collaboration-output"><h4>执行汇总</h4><pre tabIndex={0}>{selectedWorkflow.resultSummary}</pre></div>}
            {selectedWorkflow.error && <div className="agent-collaboration-output agent-collaboration-output-error"><h4>错误信息</h4><pre tabIndex={0}>{selectedWorkflow.error}</pre></div>}
          </div>}
        </div>}
      </section>
      <p className="agent-collaboration-hint">任务会绑定工作目录和 Agent。运行超限会进入队列；支持原生会话的 CLI 可继续同一任务，WorkBuddy 和 Trae 每次创建新交接。</p>
      <section className="agent-collaboration-section" aria-labelledby="agent-collaboration-create-title">
        <div className="agent-collaboration-section-head"><div><h2 id="agent-collaboration-create-title">{continuation ? "继续任务" : "派发任务"}</h2><p>选择执行 Agent、工作目录和验收目标；Codex++ 负责排队、取消与结果留存。</p></div></div>
        {continuation && <div className="agent-collaboration-continuation"><div><strong>续聊 {agentName(continuation.agentId)} 的任务</strong><span>{continuation.prompt}</span><small>任务 {continuation.id} · 沿用原会话与工作目录</small></div><button type="button" className="mg-button" disabled={busy === "submit"} onClick={() => { setContinueTaskId(""); setPrompt(""); }}>返回新任务</button></div>}
        <form className="agent-collaboration-form" onSubmit={submitTask}>
          <div className="agent-collaboration-form-row">
            <div className="mg-field"><span>执行 Agent</span><AppSelect
              ariaLabel="执行 Agent"
              disabled={Boolean(continuation) || busy === "submit" || !enabledAgents.length}
              id="agent-collaboration-target"
              onChange={(next) => setAgentId(next)}
              options={continuation ? [{ value: continuation.agentId, label: agentName(continuation.agentId) }] : enabledAgents.map((agent) => ({ value: agent.id, label: agent.name }))}
              placeholder="请先启用一个 CLI"
              value={targetId}
            /></div>
            <label className="mg-field" htmlFor="agent-collaboration-cwd"><span>工作目录</span><input id="agent-collaboration-cwd" value={targetCwd} disabled={Boolean(continuation) || busy === "submit"} placeholder="/absolute/path/to/project" spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(event) => setCwd(event.target.value)} /></label>
          </div>
          <label className="mg-field" htmlFor="agent-collaboration-prompt"><span>{continuation ? "追加任务或问题" : "任务内容"}</span><textarea id="agent-collaboration-prompt" ref={promptRef} rows={4} value={prompt} disabled={busy === "submit"} placeholder={continuation ? "基于刚才的结果，继续…" : "描述目标、需要检查的文件，以及希望返回的结果…"} onChange={(event) => setPrompt(event.target.value)} /></label>
          <div className="agent-collaboration-form-footer"><p className="agent-collaboration-hint" id="agent-collaboration-submit-hint">{formDisabledReason || (targetQueue.willQueue ? tf("此 Agent 还有 {0} 个任务未结束，新任务会排队，前面的结束后按提交顺序自动启动。", [targetQueue.active]) : targetQueue.running ? tf("此 Agent 正在执行 {0} 个任务（同时最多 {1} 个），新任务会直接并发启动。", [targetQueue.running, targetQueue.concurrency]) : "新任务会创建 CLI 会话。已有任务可在结果区选择“继续该任务”。")}{!formDisabledReason && sameCwdRunning > 0 && tf(" 同一工作目录已有 {0} 个任务在运行，并发执行可能互相修改相同文件，建议使用不同的工作目录。", [sameCwdRunning])}</p><button type="submit" className="mg-button mg-primary" aria-describedby="agent-collaboration-submit-hint" disabled={Boolean(busy) || Boolean(formDisabledReason) || !prompt.trim() || !targetCwd.trim()}>{busy === "submit" ? <Loader2 size={15} className="agent-collaboration-spin" /> : <Play size={15} />}{busy === "submit" ? "提交中…" : continuation ? "发送并续聊" : "提交任务"}</button></div>
        </form>
      </section>

      <section className="agent-collaboration-section" aria-labelledby="agent-collaboration-tasks-title">
        <div className="agent-collaboration-section-head"><div><h2 id="agent-collaboration-tasks-title">执行记录与结果 <span className="agent-collaboration-count">{tasks.length}</span></h2><p role="status">{eventStreamStatus === "live" ? "SSE 事件到达时实时更新，不做后台轮询。" : "SSE 不可用时改为手动刷新或切回窗口更新。"}</p>{agentLoads.length > 0 && <p className="agent-collaboration-hint" aria-label={t("各 Agent 并发情况")}>{agentLoads.map(({ agent, state }) => tf("{0}：执行中 {1}/{2}，排队 {3}", [agent.name, state.running, state.concurrency, state.queued])).join("；")}</p>}</div></div>
        {!tasks.length ? <div className="agent-collaboration-empty">还没有子 Agent 任务。接入后，在 Codex 对话中分派第一个任务。</div> : <div className="agent-collaboration-task-workspace">
          <ul className="agent-collaboration-task-list" aria-label="协作任务">
            {tasks.map((task) => <li key={task.id}><button type="button" className="agent-collaboration-task-select" aria-pressed={task.id === selectedId} onClick={() => setSelectedId(task.id)}><span className="agent-collaboration-task-title"><strong>{agentName(task.agentId)}</strong><span className="agent-collaboration-status" data-status={task.status}>{statusLabels[task.status] ?? task.status}</span></span><span className="agent-collaboration-task-prompt">{task.prompt}</span><small>{formatTime(task.createdAtMs)}{task.parentTaskId ? " · 续聊" : ""}</small></button></li>)}
          </ul>
          {selected && <div className="agent-collaboration-task-detail" key={selected.id}>
            <div className="agent-collaboration-detail-head"><div><h3>{agentName(selected.agentId)}</h3><span className="agent-collaboration-status" data-status={selected.status} role="status">{selected.cancelRequested && unfinished(selected) ? "正在取消…" : statusLabels[selected.status] ?? selected.status}</span></div><div className="agent-collaboration-detail-actions">
              {unfinished(selected) ? <button type="button" className="mg-button" disabled={Boolean(busy) || selected.cancelRequested} onClick={() => void mutate("cancel", { id: selected.id }, () => setNotice("已请求取消任务，状态将在任务停止后更新。"))}><Square size={13} />{busy === "cancel" || selected.cancelRequested ? "正在取消…" : "取消任务"}</button> : selected.status === "completed" && Boolean(selected.sessionId) && <button type="button" className="mg-button" disabled={Boolean(busy)} onClick={() => continueTask(selected)}>继续该任务</button>}
            </div></div>
            <dl className="agent-collaboration-task-meta"><dt>工作目录</dt><dd>{selected.cwd}</dd><dt>任务 ID</dt><dd>{selected.id}</dd><dt>更新时间</dt><dd>{formatTime(selected.updatedAtMs)}</dd>{selected.sessionId && <><dt>会话 ID</dt><dd>{selected.sessionId}</dd></>}{selected.parentTaskId && <><dt>接续任务</dt><dd>{selected.parentTaskId}</dd></>}</dl>
            <div className="agent-collaboration-output"><h4>任务内容</h4><pre tabIndex={0}>{selected.prompt}</pre></div>
            {selected.progress && <div className="agent-collaboration-output"><h4>执行进度</h4><pre tabIndex={0} aria-label="执行进度">{selected.progress}</pre></div>}
            {selected.answer && <div className="agent-collaboration-output"><h4>结果</h4><pre tabIndex={0} aria-label="任务结果">{selected.answer}</pre></div>}
            {selected.error && <div className="agent-collaboration-output agent-collaboration-output-error"><h4>错误信息</h4><pre tabIndex={0} aria-label="任务错误">{selected.error}</pre></div>}
            {selected.status === "handed_off" && <p className="agent-collaboration-hint">Trae 窗口已交付，但 Codex++ 没在等待时间内确认最终答复。请查看 Trae 窗口；不要把这个状态当成成功。</p>}
            {!selected.progress && !selected.answer && !selected.error && <p className="agent-collaboration-hint">{unfinished(selected) ? "等待 Agent 返回输出…" : "该任务没有返回文本输出。"}</p>}
            {!unfinished(selected) && selected.status !== "handed_off" && (selected.status !== "completed" || !selected.sessionId) && <p className="agent-collaboration-hint">只有已完成且有会话 ID 的任务可以续聊。可创建新任务继续处理。</p>}
          </div>}
        </div>}
      </section>

      </div></section>
      <p className="agent-collaboration-hint agent-collaboration-footnote">外部 CLI 与桌面适配器；Trae 通过隐藏结果文件交接，只有已完成状态才代表成功。</p>
    </div>
  </div>;
}
