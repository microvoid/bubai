---
name: e2e-dsl
description: Design, statically validate, diagram, and verify full-stack E2E DSL bundles with mandatory sequence diagrams, flowcharts, interaction screenshots, and replayable cross-service data-flow mocks. Use whenever implementing a feature or requirement that must deliver E2E DSL, sequence/flow diagrams, and recorded execution artifacts (screenshots + full inter-module/service traffic capable of mocking the entire flow).
---

# E2E DSL

Every feature implementation must deliver a self-contained, verifiable E2E bundle alongside its code. Do not treat E2E as an afterthought or an opaque test script: express the test contract in YAML DSL, derive human-readable diagrams from it, and capture complete runtime artifacts on every execution so the entire flow can be inspected visually and replayed offline as a mock.

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
