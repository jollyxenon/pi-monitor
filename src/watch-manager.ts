import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ENDED_STATES } from "./constants.js";
import { ProcReader, WatcherInterruptError } from "./proc-reader.js";
import type {
  ProcessRecord,
  ProcStat,
  TerminalEvent,
  WatchConfig,
  WatchFinishEvent,
  WatchInterruptEvent,
} from "./types.js";

/** 状态文件版本号 */
const STATE_VERSION = 1;

/** 内部维护的活跃任务实例 */
interface ActiveWatchTask {
  config: WatchConfig;
  bootId: string;
  btime: number;
  processes: Map<string, ProcessRecord>;
  timer?: NodeJS.Timeout | undefined;
  scanning: boolean;
  statePath: string;
  terminalHandled: boolean;
}

/**
 * 本地进程树监控管理器。
 * 去子进程化，直接在 Node.js 事件循环中使用定时器周期性扫描 /proc。
 */
export class LocalWatchManager {
  private readonly active = new Map<string, ActiveWatchTask>();
  private readonly procReader = new ProcReader();

  public constructor(
    private readonly onTerminal: (config: WatchConfig, event: TerminalEvent) => void,
  ) {}

  /** 启动对一个本地任务进程树的监控 */
  public async start(config: WatchConfig): Promise<void> {
    if (this.active.has(config.watch_id)) {
      throw new Error(`watch 已在运行: ${config.watch_id}`);
    }

    const bootId = await this.procReader.readBootId();
    const btime = await this.procReader.readBtime();
    const statePath = this.resolveStatePath(config.session_id, config.watch_id);

    const task: ActiveWatchTask = {
      config,
      bootId,
      btime,
      processes: new Map(),
      scanning: false,
      statePath,
      terminalHandled: false,
    };
    this.active.set(config.watch_id, task);

    try {
      if (config.resume) {
        await this.loadPersistedState(task);
      } else {
        const rootStat = await this.procReader.readProcessStat(config.pid);
        if (rootStat && !ENDED_STATES.has(rootStat.state)) {
          this.rememberProcess(task, rootStat);
        }
        await this.writeStateFile(task, null);
      }

      // 如果启动时根进程已经不存在或结束，立即在下个 tick 触发一次扫描
      setImmediate(() => {
        void this.scan(config.watch_id);
      });

      // 启动定时轮询
      task.timer = setInterval(() => {
        void this.scan(config.watch_id);
      }, config.interval_seconds * 1000);
    } catch (error) {
      this.cancel(config.watch_id);
      throw error;
    }
  }

  /** 取消指定的任务监控 */
  public cancel(watchId: string): void {
    const task = this.active.get(watchId);
    if (!task) return;
    task.terminalHandled = true;
    if (task.timer) {
      clearInterval(task.timer);
      task.timer = undefined;
    }
    this.active.delete(watchId);
  }

  /** 关闭所有正在运行的监控定时器（在 session 切换或重载时调用） */
  public closeAll(): void {
    for (const task of this.active.values()) {
      task.terminalHandled = true;
      if (task.timer) {
        clearInterval(task.timer);
        task.timer = undefined;
      }
    }
    this.active.clear();
  }

  /** 周期性扫描核心算法 */
  private async scan(watchId: string): Promise<void> {
    const task = this.active.get(watchId);
    if (!task || task.scanning || task.terminalHandled) return;
    task.scanning = true;

    try {
      const nowIso = new Date().toISOString();
      const activePids: number[] = [];

      // 1. 检查已记录的所有进程，更新存活状态
      for (const record of task.processes.values()) {
        if (record.ended_at) continue;
        const stat = await this.procReader.readProcessStat(record.pid);
        if (!stat || stat.start_ticks !== record.start_ticks || ENDED_STATES.has(stat.state)) {
          record.ended_at = nowIso;
        } else {
          activePids.push(record.pid);
        }
      }

      // 2. 递归查找并追踪存活进程的子进程
      const queue = [...activePids];
      const inspected = new Set<number>();
      while (queue.length > 0) {
        const currentPid = queue.shift()!;
        if (inspected.has(currentPid)) continue;
        inspected.add(currentPid);

        const children = await this.procReader.readChildren(currentPid);
        for (const childPid of children) {
          const childStat = await this.procReader.readProcessStat(childPid);
          if (childStat && !ENDED_STATES.has(childStat.state)) {
            const childKey = `${childStat.pid}:${childStat.start_ticks}`;
            if (!task.processes.has(childKey)) {
              this.rememberProcess(task, childStat);
              activePids.push(childPid);
              queue.push(childPid);
            } else if (activePids.includes(childPid)) {
              queue.push(childPid);
            }
          }
        }
      }

      // 如果扫描期间任务已被取消或重置，直接放弃后续落盘与通知
      if (this.active.get(watchId) !== task || task.terminalHandled) return;

      // 3. 判定是否已全部结束
      const isFinished = activePids.length === 0;
      await this.writeStateFile(task, isFinished ? "finish" : null);

      if (this.active.get(watchId) !== task || task.terminalHandled) return;

      if (isFinished) {
        task.terminalHandled = true;
        this.cancel(watchId);

        const finishEvent: WatchFinishEvent = {
          event: "finish",
          watch_id: task.config.watch_id,
          root_pid: task.config.pid,
          process_count: task.processes.size,
          observed_at: nowIso,
          state_file: task.statePath,
        };
        this.onTerminal(task.config, finishEvent);
      }
    } catch (error) {
      if (this.active.get(watchId) !== task || task.terminalHandled) return;
      task.terminalHandled = true;
      this.cancel(watchId);

      const errCode = error instanceof WatcherInterruptError ? error.code : "internal_error";
      const errMsg = error instanceof Error ? error.message : String(error);
      const interruptEvent: WatchInterruptEvent = {
        event: "interrupt",
        watch_id: task.config.watch_id,
        root_pid: task.config.pid,
        process_count: task.processes.size,
        observed_at: new Date().toISOString(),
        state_file: task.statePath,
        error_code: errCode,
        error: errMsg,
      };
      this.onTerminal(task.config, interruptEvent);
    } finally {
      task.scanning = false;
    }
  }

  /** 记录一个新发现的进程 */
  private rememberProcess(task: ActiveWatchTask, stat: ProcStat): ProcessRecord {
    const startedAtSec = task.btime + stat.start_ticks / this.procReader.clockTicks;
    const startedAt = new Date(startedAtSec * 1000).toISOString();
    const record: ProcessRecord = {
      pid: stat.pid,
      start_ticks: stat.start_ticks,
      started_at: startedAt,
    };
    task.processes.set(`${stat.pid}:${stat.start_ticks}`, record);
    return record;
  }

  /** 获取当前用户的状态文件落盘路径 */
  private resolveStatePath(sessionId: string, watchId: string): string {
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    return join(tmpdir(), `pi-monitor-${uid}`, sessionId, `${watchId}.json`);
  }

  /** 从持久化状态文件恢复进程树 */
  private async loadPersistedState(task: ActiveWatchTask): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(task.statePath, "utf8");
    } catch {
      throw new WatcherInterruptError("state_missing", "状态文件丢失，无法恢复任务状态");
    }

    try {
      const data = JSON.parse(content) as {
        version: number;
        boot_id: string;
        processes: ProcessRecord[];
      };
      if (data.version !== STATE_VERSION || data.boot_id !== task.bootId) {
        throw new WatcherInterruptError("boot_id_mismatch", "系统在会话断开期间发生过重启");
      }
      for (const p of data.processes) {
        task.processes.set(`${p.pid}:${p.start_ticks}`, { ...p });
      }
    } catch (error) {
      if (error instanceof WatcherInterruptError) throw error;
      throw new WatcherInterruptError("state_corrupt", "状态文件解析失败");
    }
  }

  /** 原子写入状态文件 */
  private async writeStateFile(task: ActiveWatchTask, terminal: string | null): Promise<void> {
    const dir = dirname(task.statePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const state = {
      version: STATE_VERSION,
      config: task.config,
      boot_id: task.bootId,
      processes: Array.from(task.processes.values()),
      last_scanned_at: new Date().toISOString(),
      terminal,
    };

    const tempPath = join(dir, `.${task.config.watch_id}.${Date.now()}.tmp`);
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, task.statePath);
  }
}
