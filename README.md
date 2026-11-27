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

## Docker Compose 部署

1. 按 `.env.example` 配置 `PUBLIC_URL`、`DATABASE_URL`、`BETTER_AUTH_SECRET`、`RESEND_API_KEY` 和使用已验证域名的 `EMAIL_FROM`。生产环境默认要求登录，登录验证码由 Resend 发出。
2. 升级已有实例前，备份 PostgreSQL 并在副本上演练升级。首次启动会将旧 `users` 表迁入 Better Auth 的 `user` 表并删除旧表。回滚到旧版本时需恢复升级前的数据库。没有组织归属的旧频道在生产登录模式下不可见，需先确定频道对应的 Community。
3. 运行 `docker compose build bubai` 构建镜像。发布时运行 `docker compose up -d --wait bubai`，然后检查 `/healthz`、邮件验证码登录和 Community 内的历史消息。

## 详细架构方案
请参阅完整文档：[docs/buzz-botmux-architecture.md](file:///Users/bytedance/Projects/github/bubai/docs/buzz-botmux-architecture.md)
