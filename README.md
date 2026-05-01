# pi-sediment

自动沉淀引擎 —— 从 coding agent 的每一轮对话中提取可复用洞察，自动路由到 [Pensieve](https://github.com/kingkongshot/Pensieve)（项目知识）和 [gbrain](https://github.com/garrytan/gbrain)（世界知识）。

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
| [Pensieve](https://github.com/kingkongshot/Pensieve) | 项目级知识存储 | 否（自动检测 `.pensieve/` 目录） |
| [gbrain](https://github.com/garrytan/gbrain) | 跨项目世界知识存储 | 否（自动检测 `gbrain doctor`） |

至少一个目标可用时自动激活。不可用时静默跳过。

## 工作原理

```
agent_end（每轮对话结束）
  ↓
推入队列（不阻塞主会话，0 token / 0 延迟）
  ↓
worker 逐条消费：
  evaluator（deepseek-v4-pro）→ skip / sediment
  ↓ sediment
  writer（单次调用，双输出）
  ├─ Pensieve 条目：项目级"怎么修"
  └─ gbrain 条目：世界级"怎么避免"
  ↓
Promise.all([写 Pensieve, 写 gbrain]) → 通知用户
```

### 关键设计

- **无正则预过滤** — 不做消息长度/问句匹配等启发式，全部交由模型判断
- **In-process sidecar** — 评估和写入在 detached async 中完成，不污染主会话上下文
- **队列消费** — 上限 20 条，串行处理，本条双写完成才消费下一条
- **冷启动加速** — gbrain < 10 页时，evaluator 更积极判定 sediment
- **零配置** — 检测到目标即启用，无需开关

## 配置

模型默认 `deepseek-v4-pro`，通过以下方式覆盖（优先级从高到低）：

```bash
export PI_SEDIMENT_MODEL="anthropic/claude-sonnet-4"
```

或在项目根创建 `.pi-sediment/config.json`：

```json
{
  "model": "anthropic/claude-sonnet-4"
}
```

## 架构

```
pi-sediment/
├── package.json
└── extensions/pi-sediment/
    ├── index.ts            # 入口：session_start/agent_end/before_agent_start
    ├── detector.ts         # 自动检测 Pensieve + gbrain
    ├── queue.ts            # 内存队列（上限 20，串行消费）
    ├── evaluator.ts        # 模型评估 skip/sediment
    ├── writer.ts           # 单次调用，双输出（Pensieve + gbrain）
    ├── prompts.ts          # evaluator + writer 的 prompt
    ├── config.ts           # 模型配置
    ├── utils.ts            # 共享工具
    └── targets/
        ├── pensieve.ts     # 写 .pensieve/short-term/
        └── gbrain.ts       # gbrain_put via CLI
```

## License

MIT
