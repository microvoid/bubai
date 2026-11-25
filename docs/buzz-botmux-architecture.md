# Buzz x Botmux 技术方案对比与落地架构

本文档记录将 **Buzz 风格人机协作界面**、**多人群聊逻辑** 与 **本地 Botmux 终端引擎** 结合的两种可行方案，以及为何放弃“Buzz 完整前端直接硬接 agentes-chat 后端”的缝合架构。

---

## 1. 为什么不建议“Buzz 完整前端 + agentes-chat 后端”直接硬拼？

1. **底层协议完全异构**：
   * `block/buzz-app`（Buzz 前端）深度耦合 **Nostr 协议**（公私钥身份 `npub/nsec`、NIP-01 事件签名、NIP-29 群组管理、Tauri 2 原生调用）。
   * `agentes-chat` 后端是标准的 Web 全栈架构（REST + 自定义 JSON WebSocket + 关系型数据库表）。
   * 硬拼需要把 Buzz 前端的网络层、鉴权层、状态管理层几乎全部拆毁重写，成本高于自建。
2. **开源协议风险**：
   * `agentes-chat` 采用强传染性的 **AGPL-3.0**，而 Buzz 采用宽松的 **Apache-2.0**。

---

## 2. 两种推荐落地方案对比

| 维度 | 方案一：轻量自建（Buzz 风格 UI + 极简群聊后端 + Botmux）⭐ 当前执行 | 方案二：整套复用 `agentes-chat`（换 Buzz 皮肤 + 接 Botmux） |
| :--- | :--- | :--- |
| **核心思路** | 只借鉴 Buzz 视觉交互与 `agentes-chat` 表结构，在 Turborepo 中构建轻量可控的全栈底座 | Fork `agentes-chat` 前后端整套代码，只改前端主题皮肤 + 新增 Botmux 执行器 |
| **开发工作量** | 中等（核心群聊约数百行代码，架构极简） | 短期最快出完整功能，但需消化原有代码与依赖 |
| **扩展自由度** | **极高**（协议、卡片、终端抽屉完全为 Botmux 量身定制） | 中等（受限于 `agentes-chat` 原有抽象与表结构） |
| **部署依赖** | 零外部重型依赖起步（本地 JSON/SQLite 持久化，可平滑升 Postgres） | 强依赖 Docker Compose + PostgreSQL + pgvector |
| **开源协议** | 完全自主可控（无 AGPL 传染） | 受 **AGPL-3.0** 约束 |
| **适用阶段** | 长期演进、深度定制“人机 + 终端接管”体验 | 快速验证完整团队 IM 功能 |

---

## 3. 方案二详细设计（备选参考：基于 `agentes-chat` 二开）

如果后续希望直接复用 `agentes-chat` 的完整功能（记忆向量检索、复杂权限、多模型路由、定时 Routine）：

1. **拉取与部署底座**：通过 `agentes-chat` 官方 Docker Compose 启动 Bun/Hono 服务端、React 前端及 Postgres + `pgvector`。
2. **新增 Botmux Agent Runtime**：
   * 在服务端 Agent 执行层新增 `runtimeType: 'botmux'`；
   * 当 Channel 中 `@Agent` 触发时，不调用 OpenAI/Anthropic SDK，而是通过 HTTP/WebSocket 将消息投递至本地 Botmux Daemon，并把 Botmux 返回的终端状态/审批事件转译为 `agentes-chat` 原生 Approval Card。
3. **前端 Buzz 风格改造与终端抽屉**：
   * 调整 `agentes-chat` 前端样式主题对齐 Buzz 风格；
   * 在消息卡片与 Agent 详情页增加 `[接管终端]` 按钮，侧滑抽屉嵌入 `xterm.js` 或直连 Botmux Web Terminal。

---

## 4. 方案一详细设计（当前执行架构）

### 4.1 整体架构拓扑

```text
┌────────────────────────────────────────────────────────────────────────┐
│                     Buzz 风格前端 (apps/web)                           │
│  - 多人类用户身份切换 / 在线状态 (Presence)                             │
│  - Channel 列表 & 新建频道 + Agent Fleet 独立状态栏                     │
│  - 实时 WebSocket 消息流、@Agent 提及、交互式审批卡片                   │
│  - 右侧滑出式 Terminal Drawer（直连 Botmux Web Terminal / 实时日志）    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ REST API + WebSocket (/ws)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│               极简群聊与 Botmux 桥接网关 (apps/gateway)                 │
│  ┌──────────────────────────────┐  ┌────────────────────────────────┐  │
│  │ 群聊核心层 (参考 agentes-chat)│  │ Botmux 桥接层 (BotmuxAdapter)  │  │
│  │ - users / agents 表          │  │ - 探测本地 Botmux 健康与状态    │  │
│  │ - channels / members 表      │  │ - Channel <-> Session 映射     │  │
│  │ - messages / cards 持久化    │  │ - @Agent 指令下发与审批注入     │  │
│  │ - WebSocket 房间广播中心     │  │ - 终端事件回流与卡片状态更新    │  │
│  └──────────────────────────────┘  └────────────────────────────────┘  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP / WebSocket (BOTMUX_ENDPOINT)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 本地已运行的 Botmux 守护进程 (Daemon)                   │
│       tmux 会话池 ──> Claude Code / Codex / Cursor CLI 等真实终端       │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.2 核心数据模型（借鉴 `agentes-chat` 精简设计）

1. **`Participant`（统一人类与 Agent 一等公民模型）**：
   * `id`, `name`, `role ('human' | 'agent')`, `status ('online' | 'busy' | 'offline')`, `agentMeta`（包含 `cliType`、`tmuxSessionId`、`capabilities`）。
2. **`Channel`（频道/群聊）**：
   * `id`, `name`, `topic`, `isPrivate`, `memberIds`, `createdAt`。
3. **`Message`（消息与交互卡片）**：
   * `id`, `channelId`, `threadId`, `senderId`, `type ('text' | 'card' | 'terminal_snapshot' | 'approval_request')`, `content`, `card`, `terminalSessionId`, `createdAt`。
4. **`TerminalSessionInfo`（频道与 Botmux 会话绑定）**：
   * `id`, `channelId`, `agentId`, `tmuxSessionName`, `status`, `webTerminalUrl`, `createdAt`。

### 4.3 实时通信协议（Gateway ↔ Web）

* **REST 接口**：
  * `GET /api/bootstrap`：一次性拉取 `channels`、`participants`、`sessions` 与 `botmuxStatus`。
  * `GET /api/channels/:id/messages`：拉取指定频道历史消息。
  * `POST /api/channels`：创建新频道。
  * `POST /api/botmux/webhook`：接收本地 Botmux 主动回调的终端输出或审批请求事件。
* **WebSocket 事件（`/ws`）**：
  * **Client → Server**：
    * `presence.identify`：声明当前浏览器标签页代表的人类用户身份（支持多标签页模拟多人协作）。
    * `message.send`：在频道发送消息（支持 `@Agent` 自动触发 Botmux 路由）。
    * `approval.respond`：点击审批卡片按钮（将 `y` / `n` / 自定义输入注入 Botmux）。
  * **Server → Client**：
    * `message.created` / `message.updated`：实时广播新消息与卡片状态变更。
    * `channel.created`：广播新建频道。
    * `presence.updated`：广播人类与 Agent 在线状态。
    * `terminal.output`：推送终端实时输出片段到抽屉。

### 4.4 本地 Botmux 对接策略

* 通过环境变量 `BOTMUX_ENDPOINT`（默认 `http://127.0.0.1:3000`）与 `BOTMUX_TOKEN`（可选）配置本地 Botmux 地址。
* `BotmuxAdapter` 封装：
  * `checkHealth()`：探测本地 Botmux 是否可达，在前端顶栏实时展示连接状态。
  * `dispatchPrompt(session, prompt)`：向 Botmux 投递群聊指令。
  * `sendApproval(session, payload)`：将审批按钮结果注入对应终端会话。
  * 若本地 Botmux 尚未开启对应的 REST 路由，Gateway 会优雅降级并在卡片中明确提示当前桥接状态，不阻塞多人群聊测试。

### 4.5 演进路线

* **Phase 1（本次落地）**：完成多人群聊持久化存储、WebSocket 广播中心、多用户身份切换、BotmuxAdapter 基础桥接与终端抽屉联调界面。
* **Phase 2**：根据本地 Botmux 实际暴露的 API/WebSocket 路径微调 `BotmuxAdapter`，接入真实 `xterm.js` 全双工终端接管。
* **Phase 3**：存储层平滑切换至 SQLite/PostgreSQL（Drizzle ORM），补齐 Thread 抽屉与权限控制。
