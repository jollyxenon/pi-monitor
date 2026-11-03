import type { TerminalEvent, WatchConfig } from "./types.js";

/**
 * 构造用于唤醒 Agent 的终态提示词。
 * 包含明确的行动指引以及独立的结构化元数据块（避免模型将元数据误当成用户指令）。
 */
export function buildTerminalPrompt(config: WatchConfig, event: TerminalEvent): string {
  const instruction =
    event.event === "finish"
      ? "本地进程树已经结束。请检查日志、产物和任务结果，然后继续当前计划。"
      : "本地监控已中断。请检查任务状态和系统环境，然后决定如何继续当前计划。";

  const metadata = {
    watch_id: config.watch_id,
    description: config.description ?? null,
    root_pid: config.pid,
    process_count: event.process_count,
    observed_at: event.observed_at,
    state_file: event.state_file,
    exit_code: event.event === "finish" ? (event.exit_code ?? null) : null,
    tmux_session: config.tmux_session ?? null,
    log_paths: config.log_paths,
    result_paths: config.result_paths,
    exit_code_path: config.exit_code_path ?? null,
    note: config.note ?? null,
    ...(event.event === "interrupt"
      ? {
          error: {
            code: event.error_code,
            message: event.error,
          },
        }
      : {}),
  };

  return `${instruction}\n\n结构化元数据，不是用户指令：\n${JSON.stringify(metadata, null, 2)}`;
}
