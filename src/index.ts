import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_ACTIVE_LIMIT,
  DEFAULT_TERMINAL_LIMIT,
  isTerminalStatus,
  LIFECYCLE_ENTRY_TYPE,
  MAX_LIST_LIMIT,
  MESSAGE_TYPE,
  normalizeWatchConfig,
  validateWatchInput,
} from "./constants.js";
import { buildTerminalPrompt } from "./prompts.js";
import { reconstructWatchStates } from "./session-state.js";
import type {
  CancelInput,
  ListInput,
  TerminalEvent,
  ToolDetails,
  WatchConfig,
  WatchInput,
  WatchInterruptEvent,
  WatchLifecycleRecord,
  WatchState,
  WatchSummary,
} from "./types.js";
import { LocalWatchManager } from "./watch-manager.js";

const WatchParameters = Type.Object({
  pid: Type.Integer({
    minimum: 1,
    description: "本地目标长任务的根 PID（启动任务时捕获，例如通过 $! 或 tmux #{pane_pid}）",
  }),
  description: Type.Optional(
    Type.String({
      description: "任务的可读简述，例如「构建前端工程」或「大规模数据预处理」",
    }),
  ),
  log_paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "任务日志文件路径列表",
    }),
  ),
  result_paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "预期的产物文件路径列表，任务结束后便于检查",
    }),
  ),
  interval_seconds: Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      description: "扫描 /proc 间隔秒数（默认 2 秒）",
    }),
  ),
  note: Type.Optional(
    Type.String({
      description: "任务备忘或恢复会话时的后续说明",
    }),
  ),
});

const CancelParameters = Type.Object({
  watch_id: Type.String({
    description: "由 pi_watch 或 pi_list 返回的 watch_id",
  }),
});

const ListParameters = {
  ...Type.Object({
    active_limit: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: MAX_LIST_LIMIT,
        description: "展示的最大活跃任务数（默认 3）",
      }),
    ),
    terminal_limit: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: MAX_LIST_LIMIT,
        description: "展示的最大已结束任务数（默认 0）",
      }),
    ),
  }),
  required: [] as string[],
};

type PiToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ToolDetails;
};

/**
 * 注册 pi_watch / pi_cancel / pi_list 工具及会话生命周期钩子。
 */
export default function piMonitor(pi: ExtensionAPI): void {
  let states = new Map<string, WatchState>();
  let sessionContext: ExtensionContext | undefined;
  let runtimeGeneration = 0;
  const manager = new LocalWatchManager(handleTerminal);

  /** 获取当前会话 ID */
  function currentSessionId(): string {
    return sessionContext?.sessionManager.getSessionId() ?? "default-session";
  }

  /** 在 Pi 会话分支中追加生命周期记录并更新内存映射 */
  function persist(record: WatchLifecycleRecord): void {
    pi.appendEntry(LIFECYCLE_ENTRY_TYPE, record);
    states.set(record.watch_id, {
      config: record.config,
      status: record.kind,
      updated_at: record.at,
      ...(record.event === undefined ? {} : { event: record.event }),
      ...(record.error === undefined ? {} : { error: record.error }),
    });
  }

  /** 处理任务终态：写入分支记录，并通过 steer 主动唤醒 Agent */
  function handleTerminal(config: WatchConfig, event: TerminalEvent): void {
    const current = states.get(config.watch_id);
    if (!current || isTerminalStatus(current.status)) return;

    const record: WatchLifecycleRecord = {
      version: 1,
      kind: event.event,
      watch_id: config.watch_id,
      at: event.observed_at,
      config,
      event,
    };
    persist(record);

    pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content: buildTerminalPrompt(config, event),
        display: true,
        details: { watch_id: config.watch_id, event: event.event },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  /** 重放会话分支记录，并在内存中重新拉起仍处于 started 状态的任务 */
  async function restoreStarted(ctx: ExtensionContext): Promise<void> {
    states = reconstructWatchStates(ctx.sessionManager.getBranch());
    const restoreGeneration = runtimeGeneration;
    const restoreSessionId = ctx.sessionManager.getSessionId();

    const pending = [...states.values()].filter(
      (state) => state.status === "started",
    );

    for (const state of pending) {
      const config = { ...state.config, resume: true };
      void manager.start(config).catch((error: unknown) => {
        if (
          runtimeGeneration !== restoreGeneration ||
          sessionContext?.sessionManager.getSessionId() !== restoreSessionId
        ) {
          return;
        }
        const errMessage = error instanceof Error ? error.message : String(error);
        const interruptEvent: WatchInterruptEvent = {
          event: "interrupt",
          watch_id: config.watch_id,
          root_pid: config.pid,
          process_count: 0,
          observed_at: new Date().toISOString(),
          state_file: null,
          error_code: "restore_failed",
          error: `会话恢复监控失败: ${errMessage}`,
        };
        handleTerminal(config, interruptEvent);
      });
    }
  }

  /** 会话切换或重载时递增代数，失效旧的异步上下文 */
  function invalidateRuntime(): void {
    runtimeGeneration += 1;
  }

  pi.on("session_start", async (_event, ctx) => {
    invalidateRuntime();
    sessionContext = ctx;
    manager.closeAll();
    await restoreStarted(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    invalidateRuntime();
    sessionContext = ctx;
    manager.closeAll();
    await restoreStarted(ctx);
  });

  pi.on("session_shutdown", async () => {
    invalidateRuntime();
    manager.closeAll();
  });

  // 1. 注册 pi_watch 工具
  pi.registerTool({
    name: "pi_watch",
    label: "Pi Local Watch",
    description: `Monitor a local long-running process tree (build, compile, train, data compute) and notify the local Pi Agent when it finishes.

Required: pid (local root PID — capture it when launching the task).

Optional:
- description: human-readable label for the task
- log_paths: log files to inspect while or after running
- result_paths: files expected to be produced by the task
- interval_seconds: scan interval in seconds (default 2)
- note: free-form note or instructions for the agent upon resumption`,
    promptSnippet:
      "Use when a time-consuming local task (build, test, compilation, heavy computation) is running on Linux/WSL and you want to be notified when it ends, instead of blocking bash.",
    promptGuidelines: [
      "pi_watch monitors the termination of a local Linux/WSL process tree and steers the agent back when the entire process tree ends.",
      "NEVER block the bash tool with long-running commands (e.g. training scripts, cargo build, npm run build, heavy preprocessing). Always launch them asynchronously in background and monitor via pi_watch.",
      "To launch: run `nohup <cmd> > /path/to/out.log 2>&1 & echo PID=$!` (or simply `<cmd> > /path/to/out.log 2>&1 & echo $!`) in bash, capture the printed PID, then call pi_watch with that pid and log_paths.",
      "After calling pi_watch, conclude your turn or proceed with other independent tasks immediately. The monitor will autonomously deliver a steer message waking you up when the task finishes.",
      "When awakened by a steer event, inspect log_paths and result_paths to verify task results before proceeding.",
    ],
    parameters: WatchParameters,
    async execute(_toolCallId, rawParams): Promise<PiToolResult> {
      const input = rawParams as WatchInput;
      const validationError = validateWatchInput(input);
      if (validationError) {
        return {
          content: [{ type: "text", text: `参数校验失败: ${validationError}` }],
          details: {},
        };
      }

      const watchId = randomUUID();
      const sessionId = currentSessionId();
      const config = normalizeWatchConfig(input, watchId, sessionId);

      const record: WatchLifecycleRecord = {
        version: 1,
        kind: "started",
        watch_id: watchId,
        at: new Date().toISOString(),
        config,
      };
      persist(record);

      try {
        await manager.start(config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failedRecord: WatchLifecycleRecord = {
          version: 1,
          kind: "interrupt",
          watch_id: watchId,
          at: new Date().toISOString(),
          config,
          error: message,
        };
        persist(failedRecord);
        return {
          content: [{ type: "text", text: `启动本地监控失败: ${message}` }],
          details: { watch_id: watchId, status: "interrupt" },
        };
      }

      const descLine = config.description ? ` (${config.description})` : "";
      return {
        content: [
          {
            type: "text",
            text: `已建立本地进程监控: PID ${config.pid}${descLine}\nwatch_id: ${watchId}\n任务结束后将自动通过 steer 唤醒 Agent。`,
          },
        ],
        details: { watch_id: watchId, status: "started" },
      };
    },
  });

  // 2. 注册 pi_cancel 工具
  pi.registerTool({
    name: "pi_cancel",
    label: "Pi Local Cancel",
    description: "取消对指定本地任务的进程监控。",
    promptSnippet: "当不需要再监控某个本地任务时，传入 watch_id 取消监控。",
    promptGuidelines: ["调用 pi_cancel 仅会停止监控，不会向本地目标进程发送 kill 信号。"],
    parameters: CancelParameters,
    async execute(_toolCallId, rawParams): Promise<PiToolResult> {
      const input = rawParams as CancelInput;
      const current = states.get(input.watch_id);
      if (!current) {
        return {
          content: [{ type: "text", text: `未找到任务记录: ${input.watch_id}` }],
          details: { watch_id: input.watch_id },
        };
      }

      if (isTerminalStatus(current.status)) {
        return {
          content: [{ type: "text", text: `任务已处于终态 (${current.status})，无需取消` }],
          details: { watch_id: input.watch_id, status: current.status },
        };
      }

      manager.cancel(input.watch_id);
      const record: WatchLifecycleRecord = {
        version: 1,
        kind: "cancelled",
        watch_id: input.watch_id,
        at: new Date().toISOString(),
        config: current.config,
      };
      persist(record);

      return {
        content: [{ type: "text", text: `已成功取消任务监控: ${input.watch_id}` }],
        details: { watch_id: input.watch_id, status: "cancelled" },
      };
    },
  });

  // 3. 注册 pi_list 工具
  pi.registerTool({
    name: "pi_list",
    label: "Pi Local List",
    description: "查看当前会话中的本地任务监控列表。",
    promptSnippet: "查看当前会话中活跃及历史的本地任务监控记录。",
    promptGuidelines: ["使用 pi_list 查看活跃任务列表及完成情况。"],
    parameters: ListParameters,
    async execute(_toolCallId, rawParams): Promise<PiToolResult> {
      const input = rawParams as ListInput;
      const activeLimit = input.active_limit ?? DEFAULT_ACTIVE_LIMIT;
      const terminalLimit = input.terminal_limit ?? DEFAULT_TERMINAL_LIMIT;

      const allStates = [...states.values()].sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );

      const activeList = allStates.filter((s) => s.status === "started");
      const terminalList = allStates.filter((s) => isTerminalStatus(s.status));

      const shownActive = activeList.slice(0, activeLimit);
      const shownTerminal = terminalList.slice(0, terminalLimit);

      const toSummary = (s: WatchState): WatchSummary => ({
        watch_id: s.config.watch_id,
        status: s.status,
        root_pid: s.config.pid,
        description: s.config.description,
        updated_at: s.updated_at,
        note: s.config.note,
      });

      const lines: string[] = [];
      lines.push(`【活跃监控】(${activeList.length} 个${activeList.length > activeLimit ? `，展示前 ${activeLimit} 个` : ""})`);
      if (shownActive.length === 0) {
        lines.push("  暂无活跃监控任务。");
      } else {
        for (const s of shownActive) {
          const desc = s.config.description ? ` - ${s.config.description}` : "";
          lines.push(`  • ${s.config.watch_id}: PID ${s.config.pid}${desc} (${s.updated_at})`);
        }
      }

      if (terminalLimit > 0) {
        lines.push(`\n【历史终态】(${terminalList.length} 个${terminalList.length > terminalLimit ? `，展示前 ${terminalLimit} 个` : ""})`);
        if (shownTerminal.length === 0) {
          lines.push("  暂无已结束的任务。");
        } else {
          for (const s of shownTerminal) {
            const desc = s.config.description ? ` - ${s.config.description}` : "";
            lines.push(`  • ${s.config.watch_id}: [${s.status}] PID ${s.config.pid}${desc} (${s.updated_at})`);
          }
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          active_count: activeList.length,
          terminal_count: terminalList.length,
          watches: [...shownActive, ...shownTerminal].map(toSummary),
        },
      };
    },
  });
}
