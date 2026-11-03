import { LIFECYCLE_ENTRY_TYPE } from "./constants.js";
import type { WatchLifecycleRecord, WatchState } from "./types.js";

/**
 * 回放 Pi 当前会话分支中的所有生命周期条目，重建各个任务的最新状态。
 */
export function reconstructWatchStates(entries: readonly unknown[]): Map<string, WatchState> {
  const states = new Map<string, WatchState>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { type?: string; customType?: string; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== LIFECYCLE_ENTRY_TYPE || !isLifecycleRecord(entry.data)) {
      continue;
    }
    const record = entry.data;
    states.set(record.watch_id, {
      config: record.config,
      status: record.kind,
      updated_at: record.at,
      ...(record.event === undefined ? {} : { event: record.event }),
      ...(record.error === undefined ? {} : { error: record.error }),
    });
  }
  return states;
}

/** 校验生命周期持久化对象的结构是否合法 */
function isLifecycleRecord(value: unknown): value is WatchLifecycleRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<WatchLifecycleRecord>;
  return (
    record.version === 1 &&
    typeof record.watch_id === "string" &&
    typeof record.at === "string" &&
    !!record.config &&
    typeof record.config === "object" &&
    typeof record.config.watch_id === "string" &&
    (["started", "finish", "interrupt", "cancelled"] as const).includes(
      record.kind as never,
    )
  );
}
