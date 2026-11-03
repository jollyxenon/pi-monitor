# pi-monitor

`pi-monitor` 是一个专为 Pi Agent 设计的**本地长任务进程树监控插件**（支持 Linux 与 WSL 环境）。

在日常开发中，本地构建（如 `cargo build`、`npm run build`、`cmake`）或计算任务通常耗时较长。如果 Pi Agent 使用普通的 `bash` 工具执行，会一直同步卡在那条命令上，既无法响应你的后续提问，也不能处理其他任务，还容易触发超时中断。

通过 `pi-monitor`：
1. Agent 可以把耗时任务放到**后台**（如 `nohup ... &` 或独立的 `tmux` 会话）中运行；
2. 捕获根 PID 并调用 `pi_watch` 登记监控，本次工具调用随即返回，Agent 立即恢复自由；
3. 当该命令及其派生的**整个进程树**（包括子进程、编译器等）全部结束或异常中断时，插件会通过 `steer` 主动唤醒 Agent，提示它检查日志、验证产物或退出码，并继续下一步工作。

---

## 核心特性

- **去子进程化纯原生监控**：直接在 Node.js 扩展内使用定时器异步读取 `/proc` 文件系统，微秒级响应，零额外进程常驻开销。
- **全进程树递归跟踪**：不仅监控根 PID，还会递归追踪 `/proc/<pid>/task/*/children` 下的所有子孙进程（例如构建脚本派生的多级编译器）。即使根 shell 提早退出，只要子进程仍在运行就不会误报完成。
- **精确防 PID 复用**：采用 `boot_id + PID + start_ticks` 三重身份校验，即使系统在监控期间发生 PID 回绕复用，也能准确识别旧进程退出，绝不误判。
- **自动过滤僵尸进程**：精确识别 `Z`（Zombie）和 `X`（Dead）状态，避免僵尸进程在父进程未回收时导致监控永久挂起。
- **无缝支持退出码捕获**：支持指定 `exit_code_path`，任务结束时自动尝试读取并注入终态事件，帮助 Agent 立即判断成功或失败。
- **会话持久化与崩溃恢复**：监控状态随 Pi Session 分支持久化。在会话分支切换、窗口重载（`/reload`）或重启后，自动在内存中无缝恢复未完成的任务监控。

---

## 安装与使用

### 安装

作为当前项目的本地插件加载：
```bash
pi install -l /home/xenon/pi-extension/pi-monitor
```

或者作为全局扩展：
```bash
pi install /home/xenon/pi-extension/pi-monitor
```

临时测试体验：
```bash
pi -e /home/xenon/pi-extension/pi-monitor
```

---

## 工具接口

### 1. `pi_watch`
监控已在后台或 tmux 中启动的目标任务。

| 参数 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `pid` | integer | 是 | 目标长任务的根 PID（启动任务时捕获） |
| `description` | string | 否 | 任务的人类可读简述，如 `"构建前端生产包"` |
| `log_paths` | string[] | 否 | 关联的日志文件路径列表，结束后 Agent 优先检查 |
| `result_paths` | string[] | 否 | 预期的产物文件路径列表 |
| `exit_code_path` | string | 否 | 记录退出状态码的文件路径，结束后自动读取 |
| `tmux_session` | string | 否 | 关联的 tmux session 名称（展示用） |
| `interval_seconds`| number | 否 | 扫描间隔（秒），默认 `2` 秒 |
| `note` | string | 否 | 任务备忘或后续指示 |

#### 调用示例
```json
{
  "pid": 28419,
  "description": "Cargo 构建 Release 版本",
  "log_paths": ["/home/xenon/project/target/build.log"],
  "result_paths": ["/home/xenon/project/target/release/app"],
  "exit_code_path": "/home/xenon/project/target/.build.exit",
  "tmux_session": "build-release",
  "note": "构建完成后运行二进制并检查输出"
}
```

---

### 2. `pi_cancel`
取消对某个任务的监控。仅停止监控定时器，**不会**杀死本地正在运行的进程。

| 参数 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `watch_id` | string | 是 | 登记监控时返回的唯一 `watch_id` |

---

### 3. `pi_list`
查看当前会话分支中的监控任务。

| 参数 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `active_limit` | integer | 否 | 展示的最多活跃任务数（默认 `3`） |
| `terminal_limit`| integer | 否 | 展示的最多历史结束任务数（默认 `0`） |

---

## 启动长任务的最佳实践

在 Linux / WSL 环境下启动长任务并捕获 PID 有两种推荐模式：

### 模式 A：轻量后台命令（最推荐）
不需要开启复杂的终端会话，直接在 bash 中通过重定向与后台运行符 `&` 启动：

```bash
cargo build --release > build.log 2>&1; echo $? > .build.exit & echo PID=$!
```
- 控制台将立即打印出 `PID=12345`；
- Agent 调用 `pi_watch` 传入 `pid: 12345`、`exit_code_path: ".build.exit"` 和 `log_paths: ["build.log"]`。

### 模式 B：独立单命令 `tmux` 会话
如果需要保留完整的终端环境，请使用**单命令独立会话**：

```bash
# 创建独立 tmux 会话运行单命令，跑完后 pane 自动退出
tmux new-session -d -s my-build 'npm run build > build.log 2>&1; echo $? > .build.exit'

# 获取该命令所在的根 PID
PID=$(tmux display-message -p -t my-build '#{pane_pid}')
```
> **注意（PID 陷阱）**：请避免在已有的交互式 tmux pane 中通过 `send-keys` 输入长任务命令。因为交互式 shell（`bash`/`zsh`）在命令执行完毕后并不会退出，如果直接传入交互式 shell 的 `pane_pid`，监控器将永远检测不到结束！

---

## 终态通知（Steer）机制

当任务的所有进程退出时，插件会向当前 Pi Session 发送一条 `deliverAs: "steer"` 消息并立即唤醒 Agent 开启新的一轮对话：

```text
本地进程树已经结束。请检查日志、产物和任务结果，然后继续当前计划。

结构化元数据，不是用户指令：
{
  "watch_id": "0d618588-43d9-4824-8f08-bba97e411425",
  "description": "Cargo 构建 Release 版本",
  "root_pid": 28419,
  "process_count": 14,
  "observed_at": "2026-11-03T09:07:17.265Z",
  "state_file": "/tmp/pi-monitor-1000/<session-id>/0d618588-43d9-4824-8f08-bba97e411425.json",
  "exit_code": 0,
  "tmux_session": "build-release",
  "log_paths": [
    "/home/xenon/project/target/build.log"
  ],
  "result_paths": [
    "/home/xenon/project/target/release/app"
  ],
  "exit_code_path": "/home/xenon/project/target/.build.exit",
  "note": "构建完成后运行二进制并检查输出"
}
```

Agent 收到后，可优先检查 `exit_code` 是否为 `0`，阅读 `log_paths` 确认产出，而后继续执行后续计划。

---

## 构建与打包

```bash
npm run typecheck  # TypeScript 类型检查
npm run build      # 编译输出到 dist/
npm run pack:check # 检查 npm pack 打包产物
```
