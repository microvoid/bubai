# Buzz x Botmux Monorepo

这是一个将 **Buzz（团队人机混合对话工作空间）** 与 **Botmux（基于 tmux 的真实 AI 编程 CLI 终端托管引擎）** 深度整合的项目。

## 目录结构

```text
├── apps/
│   ├── web/          # Buzz 风格的现代化团队前端（React 19 + Tailwind + Vite）
│   └── gateway/      # 桥接网关（连接前端与本地已运行的 Botmux）
├── packages/
│   └── types/        # 前后端与 Botmux 协议契约共享包
├── docs/
│   └── buzz-botmux-architecture.md  # 详细技术方案与架构文档
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

## 快速开始

### 1. 安装依赖
```bash
pnpm install
```

### 2. 启动开发模式
```bash
pnpm dev
```
* **Web 前端** 默认运行于：`http://localhost:5173`
* **Gateway 网关** 默认运行于：`http://localhost:4000`（对接本地 Botmux）

## CLI

使用 Node.js 22 或更新版本安装 CLI。

```bash
npm install -g @bubx/cli
bub login
```

`bub` 默认连接 `https://bubai.app/`。使用 `--server` 或 `BUBAI_URL` 可指定其他服务地址。

## Docker Compose 部署

1. 按 `.env.example` 配置 `PUBLIC_URL`、`DATABASE_URL` 和 `BETTER_AUTH_SECRET`。生产环境默认要求登录，验证码通过 [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/get-started/send-emails/) 发出。在 Cloudflare 启用发件域名后，配置 `CLOUDFLARE_ACCOUNT_ID`、有 `Email Sending: Edit` 权限的 `CLOUDFLARE_EMAIL_API_TOKEN`，以及该域名下的 `EMAIL_FROM`。向任意收件人发信需要 Workers Paid。
2. 升级已有实例前，备份 PostgreSQL 并在副本上演练升级。首次启动会将旧 `users` 表迁入 Better Auth 的 `user` 表并删除旧表。回滚到旧版本时需恢复升级前的数据库。没有组织归属的旧频道在生产登录模式下不可见，需先确定频道对应的 Community。
3. 运行 `docker compose build bubai` 构建镜像。发布时运行 `docker compose up -d --wait bubai`，然后检查 `/healthz`、邮件验证码登录和 Community 内的历史消息。

## 详细架构方案
请参阅完整文档：[docs/buzz-botmux-architecture.md](file:///Users/bytedance/Projects/github/bubai/docs/buzz-botmux-architecture.md)
