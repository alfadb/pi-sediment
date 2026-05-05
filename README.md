# pi-sediment

自动沉淀引擎 —— 从 coding agent 的每一轮对话中提取可复用洞察，自动路由到 [Pensieve](https://github.com/kingkongshot/Pensieve)（项目知识，需 `pi` 分支）和 [gbrain](https://github.com/garrytan/gbrain)（世界知识）。

## 一句话理解

> 不再依赖 agent 手动调用 `gbrain_put` 或 `/skill:pensieve self-improve`。pi-sediment 在后台自动评估每一轮对话，将项目级洞察写入 Pensieve，将通用工程原则写入 gbrain。

## 安装

```bash
pi install git:github.com/alfadb/pi-sediment
# 或作为 submodule
git submodule add -b main https://github.com/alfadb/pi-sediment agent/skills/pi-sediment
```

配置 `settings.json`（submodule 方式需手动声明路径）：

```json
{
  "extensions": [
    "~/.pi/agent/skills/pi-sediment/extensions/pi-sediment"
  ]
}
```

## 前置依赖

| 依赖 | 用途 | 必选 |
|------|------|------|
| [Pensieve](https://github.com/kingkongshot/Pensieve) | 项目级知识存储 | 否（自动检测 `.pensieve/` 目录，需 `pi` 分支） |
| [gbrain](https://github.com/garrytan/gbrain) | 跨项目世界知识存储 | 否（自动检测 `gbrain doctor`） |

至少一个目标可用时自动激活。不可用时静默跳过。

### 依赖安装

**Pensieve（需 `pi` 分支）：**

```bash
# 在项目根初始化（创建 .pensieve/ 目录）
git clone -b pi https://github.com/kingkongshot/Pensieve ~/.pensieve
cd ~/.pensieve && ./setup
# 然后在项目中：
pensieve init
```

**gbrain：**

```bash
# 安装并初始化
git clone https://github.com/garrytan/gbrain ~/.gbrain
cd ~/.gbrain && ./setup
```

安装后 pi-sediment 自动检测到目标即启用，无需额外配置。

## 与 pi-gstack 的协作

pi-sediment 是 [pi-gstack](https://github.com/alfadb/pi-gstack) 的写入层。

```
pi-gstack skill 执行
  ├─ Brain Context Load：gbrain_search / gbrain_get（启动前搜索）
  ├─ workflow 执行
  └─ （无手动写入指令）
        ↓
pi-sediment（自动，每轮对话后）
  ├─ evaluator 判定价值 → skip / sediment
  └─ writer 双写
        ├─ Pensieve：项目级洞察（架构决策、模块边界、已知陷阱）
        └─ gbrain：世界级原则（跨项目模式、RCA 模式、反模式）
```

**分工：** pi-gstack 负责「搜」——启动前用 gbrain_search/gbrain_get 加载上下文。pi-sediment 负责「写」——自动捕获并路由洞察，无需任何手动 `gbrain_put` 或 `/skill:pensieve self-improve`。

## 工作原理

```
agent_end（每轮对话结束）
  ↓
markPending(target)：记下本次 head entry id（0 token / 0 延迟）
  ↓
scheduler（每个 target 独立状态机：idle↔pending↔running）
  ↓
依据 checkpoint 构建窗口（lastProcessedEntryId → pendingHeadEntryId）
  → 冲突同一 target 只保留最新 head（coalescing）
  ↓
agent-loop 运行：默认 deepseek-v4-pro，reasoning=high，只读 tool（gbrain_search／pensieve_grep等）
  → SKIP / SKIP_DUPLICATE / NEW / UPDATE 语义输出
  ↓
Pensieve 与 gbrain 独立 pipeline 并行推进；失败按【可重试】／【永久】分类处理
```

### 关键设计

- **Coalescing checkpoint scheduler** — **不是 FIFO 队列**。每个 target 独立维护
  `lastProcessedEntryId → pendingHeadEntryId` 区间；worker 跑的时候新来的轮
  只更新 pendingHead 。这意味着长会话中连击 5 轮产生的是 1 个带 5 轮详
  情的窗口，而不是 5 个背背背背起背的零碎 LLM 调用。
- **In-process sidecar** — 调度和写入在 detached async 中完成，不污染主会话上下文
- **Read-only lookup tools 驱动 dedupe** — writer agent 在决定写之前必须
  `gbrain_search、pensieve_grep` 检查已存。到同样主题会选 UPDATE 而非新建。
- **冷启动加速** — gbrain < 10 页时，writer 更积极地判定 NEW
- **三态 RunResult** — `processed`/`failed_retryable`/`failed_permanent`。瀑布不
  谝入 5 次硬上限，只有多发 retry 失败才有；确定性失败下只推进一次。
- **零配置** — 检测到目标即启用，无需开关

## 配置

模型默认 `deepseek/deepseek-v4-pro`（reasoning: `xhigh`），通过以下方式覆盖（优先级从高到低）：

```bash
export PI_SEDIMENT_MODEL="anthropic/claude-sonnet-4"
export PI_SEDIMENT_REASONING="high"
```

或在项目根创建 `.pi-sediment/config.json`：

```json
{
  "model": "anthropic/claude-sonnet-4",
  "reasoning": "high"
}
```

`reasoning` 可选值：`off` | `high` | `xhigh`（默认）。

## 架构

```
pi-sediment/
├── package.json
└── extensions/pi-sediment/
    ├── index.ts            # 入口：session_start / agent_end，跳过不干净轮
    ├── detector.ts         # 自动检测 Pensieve + gbrain
    ├── scheduler.ts        # 每 target 独立的 coalescing checkpoint 状态机
    ├── agent-loop.ts       # 多轮 LLM 循环（醉服 completeSimple + tool dispatch）
    ├── lookup-tools.ts     # 只读探针：gbrain_search/get + pensieve_grep/read/list
    ├── gbrain-agent.ts     # gbrain pipeline：agent loop + 语义输出解析
    ├── pensieve-writer.ts  # pensieve pipeline：agent loop + .pensieve/ 写入
    ├── prompts.ts          # GBRAIN_AGENT_PROMPT + sanitizeContent（位置感知）
    ├── config.ts           # 模型配置（env > 项目 config > 默认）
    ├── types.ts            # 共享类型
    ├── utils.ts            # gbrainCommand / sanitizeSlug / isNonLatin / logLine
    └── targets/
        └── gbrain.ts       # gbrain put via CLI（含重试 + 预翻译纪律）
```

### 运营面

- `~/<project>/.pi-sediment/state.json` — checkpoint 持久化。原子写入（`.tmp` + rename）避免崩溃后起则丢状态。
- `~/<project>/.pi-sediment/sidecar.log` — 单行结构化日志，超 2MB 轮转。
- `~/<project>/.pi-sediment/parse-failures/` — 被 sanitize / 协议解析发出去的 raw payload，供事后检验。

## License

MIT
