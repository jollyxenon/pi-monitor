/** 任务监控的终态类型 */
export type WatchTerminalKind = "finish" | "interrupt" | "cancelled";

/** 任务监控的完整生命周期状态 */
export type WatchStatus = "started" | WatchTerminalKind;

/** 注册监控时的公开发起参数 */
export interface WatchInput {
  /** 目标根进程 PID */
  pid: number;
  /** 任务的可读描述 */
  description?: string | undefined;
  /** 关联的日志文件路径列表 */
  log_paths?: string[] | undefined;
  /** 预期的产物文件路径列表 */
  result_paths?: string[] | undefined;
  /** 扫描间隔秒数，默认 2 秒 */
  interval_seconds?: number | undefined;
  /** 补充说明或后续备忘 */
  note?: string | undefined;
}

/** 取消监控工具参数 */
export interface CancelInput {
  watch_id: string;
}

/** 查看监控列表工具参数 */
export interface ListInput {
  active_limit?: number | undefined;
  terminal_limit?: number | undefined;
}

/** 持久化保存与恢复监控所需的完整配置 */
export interface WatchConfig {
  watch_id: string;
  session_id: string;
  pid: number;
  description?: string | undefined;
  log_paths: string[];
  result_paths: string[];
  interval_seconds: number;
  note?: string | undefined;
  resume: boolean;
}

/** 从 /proc/<pid>/stat 读取的最小进程信息 */
export interface ProcStat {
  pid: number;
  state: string;
  start_ticks: number;
}

/** 单个被发现进程的稳定身份与生命周期时间 */
export interface ProcessRecord {
  pid: number;
  start_ticks: number;
  started_at: string;
  ended_at?: string | undefined;
}

/** 正常完成终态事件 */
export interface WatchFinishEvent {
  event: "finish";
  watch_id: string;
  root_pid: number;
  process_count: number;
  observed_at: string;
  state_file: string;
}

/** 异常中断终态事件 */
export interface WatchInterruptEvent {
  event: "interrupt";
  watch_id: string;
  root_pid: number;
  process_count: number;
  observed_at: string;
  state_file: string | null;
  error_code: string;
  error: string;
}

/** 统一的终态事件对象 */
export type TerminalEvent = WatchFinishEvent | WatchInterruptEvent;

/** 存储在 Pi custom entry 中的生命周期记录 */
export interface WatchLifecycleRecord {
  version: 1;
  kind: WatchStatus;
  watch_id: string;
  at: string;
  config: WatchConfig;
  event?: TerminalEvent | undefined;
  error?: string | undefined;
}

/** 内存中维护的任务状态 */
export interface WatchState {
  config: WatchConfig;
  status: WatchStatus;
  updated_at: string;
  event?: TerminalEvent | undefined;
  error?: string | undefined;
}

/** 列表输出摘要 */
export interface WatchSummary {
  watch_id: string;
  status: WatchStatus;
  root_pid: number;
  description?: string | undefined;
  updated_at: string;
  note?: string | undefined;
}

/** 工具返回结构 */
export interface ToolDetails {
  watch_id?: string | undefined;
  status?: WatchStatus | undefined;
  active_count?: number | undefined;
  terminal_count?: number | undefined;
  watches?: WatchSummary[] | undefined;
}
