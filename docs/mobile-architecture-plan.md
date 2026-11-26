# Bubai 移动端架构与落地方案

本文档定义 **Bubai 移动端（iOS 先行，随后同步迁移 Android）** 的技术架构、目录拆分、连接模型、UI/交互规范与分阶段实施计划。

核心思路与桌面端一脉相承：
- **底层聊天架构与工程骨架**：参考 `references/agentes-chat/apps/mobile`（Expo + React Native + `expo-router`），洁净自研以规避 AGPL-3.0 协议传染。
- **UI、视觉体系与交互体验**：完整迁移 `references/buzz/mobile`（Apache-2.0）的设计语言、手势和页面流。
- **Bubai 专属能力**：无缝融合本地/远端 Botmux 的 **审批交互（Pending Asks）** 与 **原生终端接管（Terminal）**。

---

## 1. 总体架构与 Monorepo 规划

### 1.1 仓库目录拓扑

```text
bubai/
├── apps/
│   ├── server/                 # Bun + Hono + Drizzle/PGlite（统一网关 + Botmux 代理）
│   ├── web/                    # React 19 + Vite（桌面/Web 端）
│   └── mobile/                 # 【新增】Expo + React Native（iOS 先行 → Android 同步）
└── packages/
    ├── db/                     # Drizzle Schema & PGlite/Postgres
    ├── botmux-client/          # Botmux Daemon HTTP/SSE 客户端
    ├── chat-client/            # 【新增】Web 与 Mobile 共享的 REST/WS 客户端与领域类型
    └── design-tokens/          # 【新增】跨平台 Buzz Design Tokens（色板、圆角、字号、间距）
```

### 1.2 核心依赖选型（对齐 `agentes-chat/apps/mobile` 成熟方案）

| 能力域 | 选型 | 说明 |
| :--- | :--- | :--- |
| **应用框架与路由** | `expo` + `expo-router` | 与现有全栈 TS 统一；`expo prebuild` 按需生成 `ios/`、`android/`，不提交原生脏文件 |
| **高性能消息流** | `@legendapp/list` | 倒序消息列表、上拉加载历史锚点保持、新消息自动吸底 |
| **软键盘联动** | `react-native-keyboard-controller` | iOS/Android 原生级键盘跟手动画，配合底部胶囊输入框 |
| **原生弹层** | `@lodev09/react-native-true-sheet` | 原生 Bottom Sheet（Thread、Agent 详情、成员管理、长按菜单、审批） |
| **状态与缓存** | `@tanstack/react-query` | 接口缓存、乐观更新、前后台切换自动刷新 |
| **图片与媒体** | `expo-image` + `expo-image-picker` + `expo-document-picker` | 缓存渲染、相册拍照、附件上传、全屏手势预览 |
| **终端内嵌** | `react-native-webview` | 加载经 `apps/server` 代理的 Botmux Web Terminal |
| **原生手感** | `expo-haptics` + `react-native-reanimated` + `react-native-gesture-handler` | 长按、发送、审批确认的触觉反馈与流畅过渡 |

---

## 2. 连接与部署模型（Web / App 统一，面向公网）

### 2.1 单入口统一协议
App 与 Web 走**完全同一套连接方式**：
- 统一配置 `SERVER_URL`（如 `https://bubai.example.com`，开发期可切 `http://<host>:4000`）。
- 所有业务数据走 `${SERVER_URL}/api/*`，实时事件走 `wss://<host>/ws`。
- App 不直连数据库，也不直连 Botmux Daemon，保证后续部署到公网后零架构改动。

### 2.2 服务端必须补齐的 3 项公网就绪能力（`apps/server`）
1. **Botmux Web Terminal 反向代理（关键）**
   - 现状：`GET /api/sessions/:sid/write-link` 返回的是 `http://127.0.0.1:7891/...`，公网与手机无法直接访问。
   - 改造：在 `apps/server` 增加 `/api/terminal-proxy/:sessionId/*`（同时代理 HTTP 与 WebSocket），`write-link` 统一返回基于当前服务 Origin 的代理 URL。公网只需暴露 `apps/server` 一个域名即可同时支持聊天和终端接管。
2. **实例探测与鉴权准备**
   - 新增 `GET /api/instance` 返回服务名称、版本与认证方式；
   - 预留 Bearer Token / Session Cookie 鉴权中间件（为后续公网多用户登录做准备），移动端凭据存放在 `expo-secure-store`。
3. **前后台断线恢复**
   - 客户端监听 `AppState`（`background → active`）和 `expo-network` 网络变化：回到前台时自动重连 WebSocket，并拉取当前频道增量消息、未读数与最新 `pendingAsks`。

---

## 3. UI 与交互规划（完整对齐 `references/buzz/mobile`）

### 3.1 视觉规范（`packages/design-tokens`）
直接提取 `apps/web/src/shared/styles/tokens.css` 的语义化变量为 JS/TS Token：
- 完整支持 **Light / Dark 主题** 与 Buzz 品牌强调色；
- 保留 Buzz 标志性视觉元素：**Agent squircle 头像**、**人类圆形头像**、**右下角在线状态点**、**分段胶囊 Tab**、**分组圆角列表卡片**。

### 3.2 信息架构（底部 4 Tab，对照 Buzz `home_page.dart`）

1. **Messages（消息）**
   - 频道（Channels）与私聊（DMs）统一列表，带未读计数徽章与顶部筛选胶囊（全部 / 未读 / 频道 / 私聊）。
   - 右上角快捷操作：新建频道、发起私聊、全局搜索。
2. **Agents（智能体）**
   - 对照 Buzz `agents_page.dart` + `agent_card_grid.dart`：展示 Agent 卡片网格（squircle 头像、在线状态、CLI 标签、简介、活跃会话数），支持折叠查看已归档 Agent。
   - 点击卡片直接打开 **Agent 详情页**。
3. **Activity（动态与审批）**
   - 聚合展示：**Botmux 待审批请求（`pendingAsks`）置顶区** + 被 `@` 提及 + Thread 回复通知。
   - 手机端最高频场景之一是审批，点开即可一键「批准 / 拒绝」。
4. **Settings（设置）**
   - 当前身份切换 / 账号信息、服务器地址配置、深浅色与外观主题、推送通知开关（二期）。

### 3.3 核心页面交互细则

| 页面 / 浮层 | 对照 Buzz 移动端 | 核心交互与 Bubai 融合点 |
| :--- | :--- | :--- |
| **频道 / 私聊聊天页** | `channel_detail_page` | 气泡连续堆叠（`stackPrevious`/`stackNext`）、日期分隔线、Agent「执行中」动态气泡、Markdown + 代码块高亮、Emoji Reactions、置顶横幅、底部胶囊 Composer（`@Agent` 提及浮层 + 图片/文件上传） |
| **消息长按操作** | `channel_actions_sheet` | 长按消息触发 `expo-haptics` 轻震 → 顶部弹出常用表情快选条 + 底部 `TrueSheet`（回复 Thread、置顶、复制、编辑、删除） |
| **Thread 回复** | Inline / Sheet Thread | 点击消息回复数弹出 `TrueSheet` 或推入 Thread 详情页，独立拉取 `/api/channels/:id/threads/:rootId` 并支持跟手键盘回复 |
| **Agent 详情页** | `profile` + 桌面 `AgentProfilePanel` | Hero 头像与状态点 + 4 个圆角主操作磁贴（`Message` / `Terminal` / `Restart` / `Stop`）+ `Info / Channels / Runtime` 分段 Tab + 编辑资料 Sheet；点 `Terminal` 优先打开当前频道会话 |
| **Botmux 终端接管** | Bubai 专属（沿用 `TerminalPane`） | 全屏 Modal + `WebView` 加载代理后的终端；顶部保留语义化栏（Agent 头像 + 会话切换器 + `···` 菜单）；底部提供**原生触控快捷键条**（`Esc`、`Ctrl+C`、`Tab`、`↑`、`↓`、`Enter`） |
| **审批弹窗（Pending Asks）** | Bubai 专属 | 聊天页顶部高亮提醒条 + `TrueSheet` 审批卡片，一指完成确认，无需打开终端 |

---

## 4. 分阶段实施路线（五阶段：M1 → M5，iOS 先行 → Android 同步迁移）

每完成一个阶段，由原会话新开一条完全访问权限的独立 `agy` thread（`--dangerously-skip-permissions`）在当前工作树、真实模拟器与真实本地 Bubai 服务上进行独立验收；若发现未通过项，由原会话修复后复验。

### M1：底座抽离与 iOS 骨架打通（2~3 天）
- **交付物**：
  1. 新增 `packages/chat-client`（抽离 REST/WS 客户端与类型）和 `packages/design-tokens`；
  2. `apps/server` 补齐 `GET /api/instance` 与 Botmux Terminal 反向代理；
  3. 初始化 `apps/mobile`（Expo + `expo-router`），在 **iOS 模拟器 / 真机** 跑通：连接 `apps/server` → 展示 4 Tab 导航与真实频道/DM/Agent 列表。
- **验收标准**：iOS 上能连上服务并实时收到频道、私聊、Agent 列表与在线状态更新。

### M2：Buzz 风格核心聊天闭环（4~5 天）
- **交付物**：
  1. 频道与私聊完整聊天页：倒序消息流 + 上拉加载历史 + Buzz 气泡堆叠 + 日期分隔线 + Agent「执行中」动态气泡 + Markdown/代码块渲染 + 附件/图片预览；
  2. 底部胶囊 Composer + 软键盘联动 + `@Agent` 提及自动补全 + 图片/文件上传 + 新建频道与发起私聊；
  3. 长按消息 Haptics + 快捷 Emoji Reactions + 底部动作 Sheet（回复 Thread、置顶/取消置顶、复制、编辑、删除）+ 独立 Thread 视图 + 频道置顶与成员管理（含 `autoReply` 开关）。
- **验收标准**：在 iOS 模拟器连接真实 Bubai 服务，完成发消息、`@Agent` 派活、查看实时回写、Thread 回复、表情回应、编辑/删除、置顶与私聊全链路。

### M3：Agents 详情 + Botmux 审批与终端接管闭环（3~4 天）
- **交付物**：
  1. Buzz 风格 Agents 卡片网格 + 完整 Agent 详情页（Hero 动作磁贴 `Message / Terminal / Restart / Stop` + `Info / Channels / Runtime` 分段 Tab + 编辑资料与归档）；
  2. `pendingAsks` 聊天顶部提醒条、Activity 审批列表与一键批准/拒绝 Sheet；
  3. 全屏 `WebView` 终端接管（经 `apps/server` 代理加载，带语义化顶栏、同 Agent 多会话切换器、Session 历史查看与底部触控快捷键条 `Esc / Ctrl+C / Tab / ↑↓ / Enter`）。
- **验收标准**：在 iOS 模拟器中完成「查看/编辑 Agent → 派活 → 处理审批 → 接管/重启终端 → 验收回复」完整闭环。

### M4：iOS 体验打磨、生命周期与发布准备（2~3 天）
- **交付物**：
  1. 前后台生命周期与弱网断线恢复（`AppState` + 网络监听自动重连 WS、增量刷新未读与待审批项）；
  2. iOS 原生手感打磨（深浅色主题持久化、7 色 Buzz Accent、Haptics 触觉反馈、Safe Area、消息搜索、空态/错误态与离线提示）；
  3. iOS 发布准备（`app.config.ts` / `eas.json` / Xcode Archive 与 TestFlight 构建配置、图标/启动屏、Push 通知注册接口预留，外部 Apple 账号/证书阻塞项清晰记录）；
  4. iOS 全链路独立验收。
- **验收标准**：iOS 真机/模拟器端体验稳定流畅，本地可复现 iOS 构建，所有本地可验证项全部通过。

### M5：Android 移植、适配、构建与模拟器验收（2~3 天）
- **交付物**：
  1. Android 专项适配：`edgeToEdge` 安全区与状态栏/导航栏适配、Android IME 软键盘抬升与输入框焦点、系统硬件返回键（Hardware Back）与手势导航处理；
  2. 底部弹层、长按菜单、WebView 终端缩放与触控快捷键条在 Android 上的兼容修复；
  3. Android 构建配置（`expo prebuild --platform android`、Gradle Debug/Preview APK 构建脚本与签名配置说明）；
  4. Android 模拟器独立安装、启动并连接本机 Bubai 服务完成核心聊天、Agent 详情与终端验收。
- **验收标准**：Android 模拟器实际安装运行通过，核心聊天、Agent 与终端流程无崩溃或键盘遮挡问题。

---

## 5. 下一步执行入口

方案确认后，建议直接按 **M1** 启动：
1. 先在 `packages/chat-client` 抽离共享类型与 API/WS 协议；
2. 服务端补齐 Botmux Terminal 反向代理；
3. 初始化 `apps/mobile`（Expo）并在 iOS 模拟器跑起首个可交互版本。
