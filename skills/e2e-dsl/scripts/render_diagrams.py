#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["PyYAML>=6.0"]
# ///
"""Generate deterministic Mermaid sequence and flowchart diagrams from an E2E DSL bundle."""

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bundle import UI_ACTION_KEYS, iter_scenarios, load_suite, require  # noqa: E402


def sanitize_mermaid_text(text: str) -> str:
    return str(text).replace('"', "'").replace("\n", " ").strip()


def node_id(prefix: str, *parts: str) -> str:
    raw = "_".join([prefix, *parts])
    return re.sub(r"[^A-Za-z0-9_]", "_", raw)


def primary_action(step: dict) -> str:
    for key in (
        "navigate",
        "click",
        "fill",
        "select",
        "expectVisible",
        "expectText",
        "request",
        "expectResponse",
        "expectRecord",
        "wsSend",
        "expectEvent",
        "expectRow",
    ):
        if key in step:
            return key
    return "step"


def render_sequence(suite: dict) -> str:
    participants = suite["participants"]
    lines = ["sequenceDiagram", "    autonumber"]
    for p in participants:
        keyword = "actor" if p["type"] == "actor" else "participant"
        lines.append(f'    {keyword} {p["id"]} as {sanitize_mermaid_text(p["label"])}')

    actor_participant = next((p["id"] for p in participants if p["type"] == "actor"), participants[0]["id"])
    default_entry = next(
        (p["id"] for p in participants if p["type"] in {"frontend", "service"}),
        participants[-1]["id"],
    )

    for suite_name, scenario in iter_scenarios(suite):
        sc_id = scenario["id"]
        sc_title = sanitize_mermaid_text(scenario["title"])
        outcome = scenario.get("outcome", "success")
        entry = scenario.get("entryParticipant", default_entry)
        tag = "REJECTED" if outcome == "rejected" else "SUCCESS"

        lines.append("")
        lines.append(f"    Note over {participants[0]['id']},{participants[-1]['id']}: [{suite_name}] {sc_id} — {sc_title} ({tag})")

        prev_returned_to_actor = False
        for step in scenario["steps"]:
            step_id = step["id"]
            step_title = sanitize_mermaid_text(step["title"])
            action = primary_action(step)
            screenshot = step.get("screenshot")
            shot_suffix = f" [shot: {screenshot}]" if screenshot else ""
            exchanges = step.get("exchanges", [])

            if action in UI_ACTION_KEYS and actor_participant != entry:
                lines.append(f"    {actor_participant}->>{entry}: {step_title}{shot_suffix}")
            elif action == "request" and not any(ex["from"] == actor_participant for ex in exchanges):
                req = step["request"]
                op = f"{req.get('method', 'HTTP')} {req.get('path', req.get('operationId', ''))}".strip()
                lines.append(f"    {actor_participant}->>{entry}: [HTTP] {sanitize_mermaid_text(op)}{shot_suffix}")
            elif screenshot:
                lines.append(f"    Note over {entry}: {step_id}: {step_title}{shot_suffix}")

            step_returned_to_actor = False
            for ex in exchanges:
                proto = ex["protocol"].upper()
                op = sanitize_mermaid_text(ex["operation"])
                status = ex.get("status")
                lines.append(f"    {ex['from']}->>{ex['to']}: [{proto}] {op}")
                if status is not None:
                    lines.append(f"    {ex['to']}-->>{ex['from']}: {sanitize_mermaid_text(str(status))}")
                    if ex["from"] == actor_participant:
                        step_returned_to_actor = True

            if action == "expectResponse" and not exchanges and not prev_returned_to_actor:
                status = step["expectResponse"].get("status", "ok")
                lines.append(f"    {entry}-->>{actor_participant}: {sanitize_mermaid_text(str(status))}")

            prev_returned_to_actor = step_returned_to_actor

    lines.append("")
    return "\n".join(lines)


def render_flow(suite: dict) -> str:
    lines = ["flowchart TD"]
    lines.append('    classDef success fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20;')
    lines.append('    classDef rejected fill:#ffebee,stroke:#c62828,color:#b71c1c;')
    lines.append('    classDef decision fill:#fff8e1,stroke:#f57f17,color:#e65100;')

    for suite_name, scenario in iter_scenarios(suite):
        sc_id = scenario["id"]
        sc_title = sanitize_mermaid_text(scenario["title"])
        outcome = scenario.get("outcome", "success")
        sg_id = node_id("sg", sc_id)

        lines.append("")
        lines.append(f'    subgraph {sg_id}["{suite_name}: {sc_title} ({sc_id})"]')
        prev = node_id("start", sc_id)
        lines.append(f'        {prev}(["Actor: {sanitize_mermaid_text(scenario["actorRef"])}"])')

        for step in scenario["steps"]:
            step_id = step["id"]
            step_title = sanitize_mermaid_text(step["title"])
            action = primary_action(step)
            screenshot = step.get("screenshot")
            ex_count = len(step.get("exchanges", []))

            extras = []
            if screenshot:
                extras.append(f"shot:{screenshot}")
            if ex_count:
                extras.append(f"{ex_count} exchange{'s' if ex_count > 1 else ''}")
            extra_txt = f" ({', '.join(extras)})" if extras else ""

            curr = node_id("st", sc_id, step_id)
            branch = step.get("branch")
            if branch:
                dec = node_id("dec", sc_id, step_id)
                branch_label = sanitize_mermaid_text(branch["label"])
                lines.append(f'        {dec}{{"{branch_label}"}}')
                lines.append(f"        class {dec} decision")
                lines.append(f"        {prev} --> {dec}")
                edge_label = sanitize_mermaid_text(branch.get("outcome", "branch"))
                lines.append(f'        {curr}["{step_title} [{action}]{extra_txt}"]')
                lines.append(f'        {dec} -->|"{edge_label}"| {curr}')
            else:
                lines.append(f'        {curr}["{step_title} [{action}]{extra_txt}"]')
                lines.append(f"        {prev} --> {curr}")
            prev = curr

        end = node_id("end", sc_id)
        if outcome == "rejected":
            lines.append(f'        {end}(["Rejected / Safe Rollback"])')
            lines.append(f"        class {end} rejected")
        else:
            lines.append(f'        {end}(["Passed / State Verified"])')
            lines.append(f"        class {end} success")
        lines.append(f"        {prev} --> {end}")
        lines.append("    end")

    lines.append("")
    return "\n".join(lines)


def sync_diagrams(bundle_dir: Path, check_only: bool = False):
    bundle, suite, _ = load_suite(bundle_dir)
    diagrams = suite.get("diagrams")
    require(isinstance(diagrams, dict) and "sequence" in diagrams and "flow" in diagrams,
            "e2e.suite.yaml must declare diagrams.sequence and diagrams.flow")

    seq_path = bundle.path(bundle.root, diagrams["sequence"], {".mmd"}, must_exist=False)
    flow_path = bundle.path(bundle.root, diagrams["flow"], {".mmd"}, must_exist=False)

    seq_content = render_sequence(suite)
    flow_content = render_flow(suite)

    if check_only:
        for label, path, expected in (("sequence", seq_path, seq_content), ("flow", flow_path, flow_content)):
            require(path.is_file(), f"missing {label} diagram: {path.relative_to(bundle.root)}")
            actual = path.read_text(encoding="utf-8")
            require(actual == expected, f"{label} diagram out of sync: {path.relative_to(bundle.root)} (run render_diagrams.py)")
        return seq_path, flow_path

    seq_path.parent.mkdir(parents=True, exist_ok=True)
    flow_path.parent.mkdir(parents=True, exist_ok=True)
    seq_path.write_text(seq_content, encoding="utf-8")
    flow_path.write_text(flow_content, encoding="utf-8")
    return seq_path, flow_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path, help="directory containing e2e.suite.yaml")
    parser.add_argument("--check", action="store_true", help="verify diagrams match DSL without writing")
    args = parser.parse_args()
    try:
        seq_path, flow_path = sync_diagrams(args.bundle, check_only=args.check)
    except (KeyError, ValueError, TypeError, OSError) as error:
        parser.exit(1, f"Diagram {'check' if args.check else 'render'} failed: {error}\n")
    verb = "Diagrams in sync" if args.check else "Diagrams generated"
    print(f"{verb}: {seq_path.name}, {flow_path.name}")


if __name__ == "__main__":
    main()
