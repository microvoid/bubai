---
name: e2e-dsl
description: Design, statically validate, diagram, and verify full-stack E2E DSL bundles and real-user E2E reproduction/verification loops (features, bug fixes, troubleshooting, AI code review, refactoring/optimization). Use whenever implementing a feature, investigating a bug, reviewing AI-generated code, or refactoring so every issue is first reproduced from a real user's interaction perspective, fixed using the captured E2E context, and verified RED → GREEN with recorded artifacts.
---

# E2E DSL

Every engineering change — **feature/requirement delivery, bug fix, issue troubleshooting, AI-generated code review, or refactoring/optimization** — must be grounded in real-user E2E verification, not static guesswork. Express durable test contracts in YAML DSL, derive human-readable diagrams from them, and capture complete runtime artifacts on every execution so the entire flow can be inspected visually and replayed offline as a mock.

## Core Rule: Real-User E2E First (RED → Fix in Context → GREEN)

无论是排查问题、审查 AI 生成的代码、做需求开发、修 Bug 还是重构优化，都必须遵循以下闭环：

1. **先以真实用户交互视角跑 E2E 复现（RED）**
   - 禁止仅凭静态读代码盲猜或凭空加防御代码。
   - 针对真实运行栈（真实浏览器/UI，或真实 WebSocket + HTTP + DB + 下游服务）构造贴近真实用户操作的隔离场景（如刷新后立刻操作、连续发送、并发任务、边界回调等），跑出明确的复现证据（失败断言、实际响应/WS 帧、截图或 trace）。
   - 明确区分 **「已复现」** 与 **「未复现」** 的疑点：未复现且无确定性契约风险的理论猜想，不强行引入多余复杂度。
2. **基于 E2E 上下文定向修复**
   - 每一处代码改动都必须直接对应 E2E 捕获到的真实上下文（请求体、WS 事件、DB 状态、页面渲染结果）。
3. **重跑同一份 E2E 验证 RED → GREEN，并清理现场**
   - 修复后重跑完全相同的 E2E 场景，确认断言从 **RED 变为 GREEN**，同时补齐单测、`typecheck` 和 `build`。
   - 跑完后自动清理临时测试频道、临时会话与测试数据，保证用户环境整洁。

## Mandatory Deliverables

When implementing or modifying a feature, you **must** produce and keep in sync all five artifacts under the feature/project E2E bundle (rooted at `e2e.suite.yaml`):

1. **E2E DSL (`e2e.suite.yaml`, `fixtures/*.yaml`, `scenarios/*.yaml`)** — Declares participants (Browser, Frontend, Gateway, Services, External APIs, DB), actors, deterministic fixtures, recording policy, and isolated scenarios covering both the happy path and key rejection/edge paths. [DSL Specification](references/dsl-spec.md)
2. **Sequence Diagram (`diagrams/sequence.mmd`)** — Mermaid `sequenceDiagram` showing every actor and inter-module/service exchange (HTTP, WS, RPC, Event, DB) across the scenarios.
3. **Flowchart (`diagrams/flow.mmd`)** — Mermaid `flowchart TD` showing user actions, decision branches, state transitions, and success/rejection outcomes.
4. **Interaction Screenshots (`runs/<run-id>/screenshots/*.png`)** — Captured at every key UI interaction step (navigate, fill, click/submit, assert) and linked to `stepId` in the run manifest.
5. **Inter-Module Data Flow & Replayable Mock (`runs/<run-id>/trace.json` + `runs/<run-id>/mock-cassette.json`)** — Full request/response/message/DB-diff trace across all module/service boundaries, normalized into a self-contained mock cassette that can directly mock the entire flow offline without live backend or third-party dependencies. [Trace & Mock Specification](references/trace-and-mock-spec.md)

## Workflow

1. **Model topology, fixtures, and scenarios.**
   - Register all participating modules/services in `e2e.suite.yaml` under `participants` (e.g., `browser`, `web`, `gateway`, `orderService`, `paymentApi`, `db`).
   - Define `actors` and deterministic `records` in `fixtures/*.yaml`. Keep every scenario isolated (`isolation: perScenario`).
   - Author scenarios in `scenarios/*.yaml` (split via `$include`). For UI steps, use accessible semantic locators (`role` + `name` + optional `scope`) and declare `screenshot` checkpoints. For cross-service steps, declare expected `exchanges` (`from`, `to`, `protocol`, `operation`, `status`) so static checks and runtime trace verification share one contract.
   - Cover happy paths, permission/validation rejections (401/403/409/422), and zero-side-effect assertions on failures.
   - Use `$include` only as a sole-key mapping `{ $include: ./path.yaml }` resolving to a mapping or list inside the bundle. Reject cycles, duplicate keys, sibling keys, and scalar fragments.

2. **Generate and lock diagrams.**
   - Run `render_diagrams.py` to generate `diagrams/sequence.mmd` and `diagrams/flow.mmd` directly from the DSL so diagrams never drift from scenarios.
   - Keep `diagrams/` committed alongside the DSL. If you hand-tune layout, never contradict the DSL topology; prefer re-running `render_diagrams.py --check` to guarantee sync.

3. **Run E2E with recording enabled.**
   - Execute the target project's E2E runner (Playwright / API runner / service hooks) with screenshot capture and boundary-traffic recording turned on.
   - Write each run into `runs/<run-id>/` containing `manifest.json`, `screenshots/*.png`, `trace.json`, and `mock-cassette.json` (or generate `mock-cassette.json` from `trace.json` via `verify_trace.py --emit-mock`).
   - Redact sensitive secrets (`Authorization`, `Cookie`, tokens) with deterministic placeholders so the cassette remains safely committable and replayable.

4. **Validate statically and dynamically.**
   - Static DSL + diagram sync check:
     ```bash
     uv run scripts/check_e2e.py /abs/path/to/e2e-bundle --check-diagrams
     ```
     (Or `python3 scripts/check_e2e.py ...` in a Python 3.9+ environment with `PyYAML` installed.)
   - Render / refresh diagrams:
     ```bash
     uv run scripts/render_diagrams.py /abs/path/to/e2e-bundle
     ```
   - Verify run artifacts (screenshots + data-flow coverage + replayable mock cassette):
     ```bash
     uv run scripts/verify_trace.py /abs/path/to/e2e-bundle /abs/path/to/e2e-bundle/runs/<run-id> --emit-mock
     ```

## Resources

- [DSL Specification](references/dsl-spec.md) — Complete schema for `E2ESuite`, `E2EFixtures`, scenarios, actions, `exchanges`, `screenshot` checkpoints, expressions, and `$include` rules.
- [Trace & Mock Specification](references/trace-and-mock-spec.md) — Schema for `manifest.json`, `trace.json`, `mock-cassette.json`, redaction rules, and Playwright/MSW replay snippets.
- [Reference Example Bundle](assets/order-checkout/README.md) — A complete, validated full-stack checkout example (`e2e.suite.yaml`, fixtures, UI + API scenarios, generated `sequence.mmd` & `flow.mmd`, and a passing `runs/sample-run/` with screenshots, trace, and replayable mock cassette).
