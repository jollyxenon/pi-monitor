# pi-monitor 开发者与 Agent 指引

本项目为 Pi Agent 的本地进程树监控扩展，专为 Linux / WSL 环境设计。

## 架构核心原则

1. **去子进程化**：直接在 Node.js 扩展内使用定时器扫描 `/proc`，不启动额外的 Python 监控子进程。
2. **三元身份标识**：以 `boot_id + PID + start_ticks` 作为进程不可伪造的生命周期身份，防 PID 复用。
3. **全进程树追踪**：通过 `/proc/<pid>/task/*/children` 递归捕获所有子孙进程，避免根进程先退出引发的误报。
4. **会话级持久化与恢复**：通过 Pi 的 Custom Entry 记录 `started`、`finish`、`interrupt`、`cancelled` 事件，并在 `session_start` / `session_tree` 阶段恢复活跃任务。
5. **Steer 唤醒**：任务终态通过 `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })` 唤醒 Agent，提示词由指令与结构化元数据块两部分组成。

## 常用命令

- `npm run typecheck`：TypeScript 类型检查。
- `npm run build`：编译 TypeScript 源码到 `dist/`。
- `npm run pack:check`：检查打包文件完整性。
