# 订单结算全链路 E2E 示例（OrderCheckoutE2E）

本目录演示一套完整的 `e2e-dsl` 交付物，涵盖浏览器 UI 交互、API 网关、订单服务、第三方支付、WebSocket 实时推送与数据库持久化，并附带一次完整落盘的运行产物（截图 + 跨服务数据流转 + 可离线回放的 Mock Cassette）。

## 目录结构

- [e2e.suite.yaml](e2e.suite.yaml) — 套件入口、服务拓扑 `participants`、录制与图路径声明
- [fixtures/base.yaml](fixtures/base.yaml) — 角色身份与确定性种子数据
- [scenarios/checkout-ui.yaml](scenarios/checkout-ui.yaml) — 浏览器主流程场景（含 4 个交互截图点与跨服务流转声明）
- [scenarios/checkout-api.yaml](scenarios/checkout-api.yaml) — API 拒绝分支（库存不足 409 / 未登录 401）与无副作用断言
- [diagrams/sequence.mmd](diagrams/sequence.mmd) — 由 `render_diagrams.py` 自动生成的 Mermaid 时序图
- [diagrams/flow.mmd](diagrams/flow.mmd) — 由 `render_diagrams.py` 自动生成的 Mermaid 流程图
- [runs/sample-run/](runs/sample-run/manifest.json) — 一次完整运行落盘产物（`manifest.json`、`trace.json`、`mock-cassette.json`、`screenshots/*.png`）

## 校验命令

在 skill 根目录执行：

```bash
uv run scripts/render_diagrams.py assets/order-checkout
uv run scripts/check_e2e.py assets/order-checkout --check-diagrams
uv run scripts/verify_trace.py assets/order-checkout assets/order-checkout/runs/sample-run --emit-mock
```
