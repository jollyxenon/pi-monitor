import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ProcStat } from "./types.js";

/** 自定义异常：通知 Watcher 发生了需要中断监控的底层错误 */
export class WatcherInterruptError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WatcherInterruptError";
  }
}

/**
 * 封装对 Linux /proc 虚拟文件系统的底层读取与解析操作。
 * 在 WSL / Linux 环境下直接读取内存文件，速度极快（微秒级）。
 */
export class ProcReader {
  public constructor(
    private readonly procRoot: string = "/proc",
    public readonly clockTicks: number = 100,
  ) {}

  /** 读取系统开机全局唯一随机 ID，若系统重启该 ID 会改变 */
  public async readBootId(): Promise<string> {
    const bootIdPath = join(this.procRoot, "sys/kernel/random/boot_id");
    try {
      const content = await fs.readFile(bootIdPath, "utf8");
      const trimmed = content.trim();
      if (!trimmed) {
        throw new WatcherInterruptError("proc_parse_error", "boot_id 内容为空");
      }
      return trimmed;
    } catch (error) {
      if (error instanceof WatcherInterruptError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new WatcherInterruptError("proc_read_error", `无法读取 boot_id: ${message}`);
    }
  }

  /** 从 /proc/stat 读取系统启动时间戳（btime） */
  public async readBtime(): Promise<number> {
    const statPath = join(this.procRoot, "stat");
    try {
      const content = await fs.readFile(statPath, "utf8");
      for (const line of content.split("\n")) {
        if (line.startsWith("btime ")) {
          const parts = line.trim().split(/\s+/);
          const btime = Number(parts[1]);
          if (Number.isFinite(btime) && btime > 0) {
            return btime;
          }
        }
      }
      throw new WatcherInterruptError("proc_parse_error", "未在 /proc/stat 中找到有效 btime");
    } catch (error) {
      if (error instanceof WatcherInterruptError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new WatcherInterruptError("proc_read_error", `无法读取系统 btime: ${message}`);
    }
  }

  /** 读取指定 PID 的状态信息，若进程已退出则返回 null */
  public async readProcessStat(pid: number): Promise<ProcStat | null> {
    const statPath = join(this.procRoot, String(pid), "stat");
    try {
      const content = await fs.readFile(statPath, "utf8");
      return this.parseProcStat(content);
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT" || nodeError.code === "ESRCH") {
        return null;
      }
      if (nodeError.code === "EACCES" || nodeError.code === "EPERM") {
        throw new WatcherInterruptError("proc_permission_denied", `无权限读取 PID ${pid} 的 stat`);
      }
      throw new WatcherInterruptError("proc_read_error", `读取 PID ${pid} stat 失败: ${nodeError.message}`);
    }
  }

  /** 解析 /proc/<pid>/stat 行内容，正确处理进程名包含括号和空格的情况 */
  public parseProcStat(text: string): ProcStat {
    const left = text.indexOf("(");
    const right = text.lastIndexOf(")");
    if (left <= 0 || right <= left) {
      throw new WatcherInterruptError("proc_parse_error", "stat 格式异常：未找到进程名括号");
    }
    const pid = Number(text.slice(0, left).trim());
    const rest = text.slice(right + 1).trim();
    const fields = rest.split(/\s+/);
    if (fields.length <= 19) {
      throw new WatcherInterruptError("proc_parse_error", "stat 格式异常：字段数不足");
    }
    const state = fields[0];
    const startTicks = Number(fields[19]);
    if (!state || state.length !== 1 || !Number.isFinite(startTicks)) {
      throw new WatcherInterruptError("proc_parse_error", "stat 格式异常：状态或启动时间无效");
    }
    return {
      pid,
      state,
      start_ticks: startTicks,
    };
  }

  /** 读取一个进程下所有线程的 children 文件，获取所有直属子进程 PID */
  public async readChildren(pid: number): Promise<number[]> {
    const taskDirPath = join(this.procRoot, String(pid), "task");
    let threadDirs: string[];
    try {
      threadDirs = await fs.readdir(taskDirPath);
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT" || nodeError.code === "ESRCH") {
        return [];
      }
      return [];
    }

    const childrenSet = new Set<number>();
    for (const tid of threadDirs) {
      const childrenPath = join(taskDirPath, tid, "children");
      try {
        const content = await fs.readFile(childrenPath, "utf8");
        for (const token of content.trim().split(/\s+/)) {
          if (!token) continue;
          const childPid = Number(token);
          if (Number.isInteger(childPid) && childPid > 0) {
            childrenSet.add(childPid);
          }
        }
      } catch {
        // 单个线程退出或文件不存在属于正常竞态，安全跳过
        continue;
      }
    }
    return Array.from(childrenSet).sort((a, b) => a - b);
  }
}
