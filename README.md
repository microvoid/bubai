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

## 详细架构方案
请参阅完整文档：[docs/buzz-botmux-architecture.md](file:///Users/bytedance/Projects/github/bubai/docs/buzz-botmux-architecture.md)
