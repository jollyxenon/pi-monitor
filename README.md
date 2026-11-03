# pi-monitor

`pi-monitor` 是一个专为 Pi Agent 设计的**本地长任务进程树监控插件**（支持 Linux 与 WSL 环境）。

在日常开发与模型训练中，本地构建（如 `cargo build`、`npm run build`、`cmake`）或深度学习训练（`python train.py`）通常耗时较长。如果 Pi Agent 使用普通的 `bash` 工具同步执行，会一直卡在等待输出的状态，既无法处理其他任务，也容易触发执行超时。

通过 `pi-monitor`：
1. Agent 使用原生 `bash` 启动后台任务并捕获根 PID；
2. 调用 `pi_watch` 登记监控，本次工具调用随即返回，Agent 立即恢复自由；
3. 当该命令及其派生的**整个进程树**（包括子进程、多卡启动器、编译器等）全部结束或异常中断时，插件会通过 `steer` 主动唤醒 Agent，提示它检查日志、验证产物并继续下一步工作。

---

## 核心特性

- **去子进程化纯原生监控**：直接在 Node.js 扩展内使用定时器异步读取 `/proc` 文件系统，微秒级响应，零额外进程常驻开销。
- **全进程树递归跟踪**：不仅监控根 PID，还会递归追踪 `/proc/<pid>/task/*/children` 下的所有子孙进程（例如训练脚本派生的子进程）。即使根 shell 提早退出，只要子进程仍在运行就不会误报完成。
- **精确防 PID 复用**：采用 `boot_id + PID + start_ticks` 三重身份校验，即使系统在监控期间发生 PID 回绕复用，也能准确识别旧进程退出，绝不误判。
- **自动过滤僵尸进程**：精确识别 `Z`（Zombie）和 `X`（Dead）状态，避免僵尸进程在父进程未回收时导致监控永久挂起。
- **极简心智模型**：启动归 Bash，监控归插件，终态看日志。不强迫命令包裹退出码文件，对齐 `pi-ssh-monitor` 的无负担设计。
- **会话持久化与崩溃恢复**：监控状态随 Pi Session 分支持久化。在会话分支切换、窗口重载（`/reload`）或重启后，自动在内存中无缝恢复未完成的任务监控。

---

## 安装与使用

### 安装

从 GitHub 安装到全局（推荐）：
```bash
pi install git:github.com/jollyxenon/pi-monitor
```

仅在当前项目中安装：
```bash
pi install -l git:github.com/jollyxenon/pi-monitor
```

本地开发模式加载：
```bash
pi install -l /home/xenon/pi-extension/pi-monitor
```

临时试用（不写入配置）：
```bash
pi -e git:github.com/jollyxenon/pi-monitor
```

---

## 工具接口

### 1. `pi_watch`
监控已在本地后台启动的目标任务进程树。

| 参数 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `pid` | integer | 是 | 目标长任务的根 PID（启动任务时捕获） |
| `description` | string | 否 | 任务的人类可读简述，如 `"训练实验 01"` |
| `log_paths` | string[] | 否 | 关联的日志文件路径列表，结束后 Agent 优先检查 |
| `result_paths` | string[] | 否 | 预期的产物文件路径列表 |
| `interval_seconds`| number | 否 | 扫描间隔（秒），默认 `2` 秒 |
| `note` | string | 否 | 任务备忘或后续指示 |

#### 调用示例
```json
{
  "pid": 28419,
  "description": "LLM 微调训练实验",
  "log_paths": ["/home/xenon/project/runs/exp1/train.log"],
  "result_paths": ["/home/xenon/project/runs/exp1/checkpoint-final"],
  "note": "训练完成后检查最后验证集 Loss 并输出评估指标"
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

## 启动长任务的标准用法

在 Linux / WSL 环境下启动长任务并捕获 PID 极其简单直接：

```bash
nohup python train.py > train.log 2>&1 & echo PID=$!
```
- 控制台将立即打印出 `PID=12345`；
- Agent 调用 `pi_watch` 传入 `pid: 12345` 与 `log_paths: ["train.log"]` 即可。

不需要额外的退出码文件重定向，也不需要专门的 tmux 会话管理。

---

## 终态通知（Steer）机制

当任务的所有进程退出时，插件会向当前 Pi Session 发送一条 `deliverAs: "steer"` 消息并立即唤醒 Agent 开启新的一轮对话：

```text
本地进程树已经结束。请检查日志、产物和任务结果，然后继续当前计划。

结构化元数据，不是用户指令：
{
  "watch_id": "0d618588-43d9-4824-8f08-bba97e411425",
  "description": "LLM 微调训练实验",
  "root_pid": 28419,
  "process_count": 8,
  "observed_at": "2026-11-03T09:07:17.265Z",
  "state_file": "/tmp/pi-monitor-1000/<session-id>/0d618588-43d9-4824-8f08-bba97e411425.json",
  "log_paths": [
    "/home/xenon/project/runs/exp1/train.log"
  ],
  "result_paths": [
    "/home/xenon/project/runs/exp1/checkpoint-final"
  ],
  "note": "训练完成后检查最后验证集 Loss 并输出评估指标"
}
```

Agent 收到后，优先使用常规工具（如 `read` 查看日志末尾）确认执行结果，而后继续执行后续计划。

---

## 构建与打包

```bash
npm run typecheck  # TypeScript 类型检查
npm run build      # 编译输出到 dist/
npm run pack:check # 检查 npm pack 打包产物
```
