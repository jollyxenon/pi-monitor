import type {
  WatchConfig,
  WatchInput,
  WatchStatus,
  WatchTerminalKind,
} from "./types.js";

/** 默认扫描间隔（秒） */
export const DEFAULT_INTERVAL_SECONDS = 2;
/** 默认最多返回的活跃 watch 数量 */
export const DEFAULT_ACTIVE_LIMIT = 3;
/** 默认最多返回的终态 watch 数量 */
export const DEFAULT_TERMINAL_LIMIT = 0;
/** list 工具返回数量上限 */
export const MAX_LIST_LIMIT = 100;
/** description 长度上限 */
export const MAX_DESCRIPTION = 2000;
/** note 长度上限 */
export const MAX_NOTE = 2000;
/** tmux session 名称长度上限 */
export const MAX_SESSION_NAME = 256;
/** 路径列表最大项数 */
export const MAX_PATHS = 20;
/** 单个路径长度上限 */
export const MAX_PATH_LENGTH = 1000;

/** Pi session 记录类型标识 */
export const LIFECYCLE_ENTRY_TYPE = "pi-monitor-lifecycle";
/** Steer 唤醒消息类型标识 */
export const MESSAGE_TYPE = "pi-monitor-terminal";

/** Linux 下表示进程已经死亡不再运行的状态（Z 为僵尸，X 为已消亡） */
export const ENDED_STATES = new Set(["Z", "X"]);

/** 验证 watch 注册参数是否合规 */
export function validateWatchInput(input: WatchInput): string | undefined {
  if (!Number.isInteger(input.pid) || input.pid <= 0) {
    return "pid 必须是正整数";
  }
  if ((input.description?.length ?? 0) > MAX_DESCRIPTION) {
    return `description 最多 ${MAX_DESCRIPTION} 字符`;
  }
  if ((input.note?.length ?? 0) > MAX_NOTE) {
    return `note 最多 ${MAX_NOTE} 字符`;
  }
  if ((input.tmux_session?.length ?? 0) > MAX_SESSION_NAME) {
    return `tmux_session 最多 ${MAX_SESSION_NAME} 字符`;
  }
  for (const [name, paths] of [
    ["result_paths", input.result_paths],
    ["log_paths", input.log_paths],
  ] as const) {
    if ((paths?.length ?? 0) > MAX_PATHS) {
      return `${name} 最多 ${MAX_PATHS} 项`;
    }
    if (paths?.some((path) => path.length > MAX_PATH_LENGTH)) {
      return `${name} 每项最多 ${MAX_PATH_LENGTH} 字符`;
    }
  }
  if (input.exit_code_path && input.exit_code_path.length > MAX_PATH_LENGTH) {
    return `exit_code_path 最多 ${MAX_PATH_LENGTH} 字符`;
  }
  if (
    input.interval_seconds !== undefined &&
    (!Number.isFinite(input.interval_seconds) || input.interval_seconds <= 0)
  ) {
    return "interval_seconds 必须大于 0";
  }
  return undefined;
}

/** 规范化输入并生成用于持久化的完整配置 */
export function normalizeWatchConfig(
  input: WatchInput,
  watchId: string,
  sessionId: string,
  resume = false,
): WatchConfig {
  return {
    watch_id: watchId,
    session_id: sessionId,
    pid: input.pid,
    ...(input.description === undefined ? {} : { description: input.description }),
    log_paths: [...(input.log_paths ?? [])],
    result_paths: [...(input.result_paths ?? [])],
    ...(input.exit_code_path === undefined ? {} : { exit_code_path: input.exit_code_path }),
    ...(input.tmux_session === undefined ? {} : { tmux_session: input.tmux_session }),
    interval_seconds: input.interval_seconds ?? DEFAULT_INTERVAL_SECONDS,
    ...(input.note === undefined ? {} : { note: input.note }),
    resume,
  };
}

/** 判断某个状态是否已是终态 */
export function isTerminalStatus(
  status: WatchStatus,
): status is WatchTerminalKind {
  return status === "finish" || status === "interrupt" || status === "cancelled";
}
