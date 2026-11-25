#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["PyYAML>=6.0"]
# ///
"""Statically validate an E2E DSL v1 bundle and optionally verify diagram sync."""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bundle import (  # noqa: E402
    PRIMARY_ACTION_KEYS,
    UI_ACTION_KEYS,
    VALID_OUTCOMES,
    VALID_PARTICIPANT_TYPES,
    VALID_PROTOCOLS,
    iter_scenarios,
    load_suite,
    require,
)
from render_diagrams import sync_diagrams  # noqa: E402


def strings_in(value):
    if isinstance(value, dict):
        for v in value.values():
            yield from strings_in(v)
    elif isinstance(value, list):
        for item in value:
            yield from strings_in(item)
    elif isinstance(value, str):
        yield value


def check_expression_refs(step: dict, fixtures: dict, defined_vars: set[str], ctx: str):
    records = fixtures.get("records", {})
    for text in strings_in(step):
        if text.startswith("$fixtures."):
            parts = text.split(".")
            require(len(parts) >= 3, f"{ctx}: malformed fixture ref {text!r}")
            record_key, field = parts[1], parts[2]
            require(record_key in records, f"{ctx}: unknown fixture record {record_key!r}")
            require(field in records[record_key].get("values", {}), f"{ctx}: unknown fixture field {text!r}")
        elif text.startswith("$vars."):
            parts = text.split(".")
            require(len(parts) >= 2, f"{ctx}: malformed var ref {text!r}")
            var_name = parts[1]
            require(var_name in defined_vars, f"{ctx}: reference to undefined var {var_name!r}")


def check_bundle(bundle_dir: Path, check_diagrams: bool = False):
    bundle, suite, fixtures = load_suite(bundle_dir)

    # 1. Validate participants
    participants = suite.get("participants")
    require(isinstance(participants, list) and len(participants) >= 2,
            "participants must list at least 2 modules/actors")
    participant_ids = set()
    for p in participants:
        require(isinstance(p, dict) and p.get("id") and p.get("label"), "each participant needs id and label")
        require(p["id"] not in participant_ids, f"duplicate participant id {p['id']!r}")
        require(p.get("type") in VALID_PARTICIPANT_TYPES, f"participant {p['id']}: invalid type {p.get('type')!r}")
        participant_ids.add(p["id"])

    # 2. Validate fixtures
    actors = fixtures.get("actors", {})
    records = fixtures.get("records", {})
    require(isinstance(actors, dict) and actors, "fixtures.actors must be non-empty")
    require(isinstance(records, dict), "fixtures.records must be a mapping")
    for name, rec in records.items():
        require(rec.get("model") and isinstance(rec.get("values"), dict),
                f"fixture record {name!r} requires 'model' and 'values'")
    for name, actor in actors.items():
        if actor.get("auth") != "none":
            account_ref = actor.get("accountRef")
            if account_ref is not None:
                require(account_ref in records, f"actor {name!r}: unknown accountRef {account_ref!r}")

    # 3. Validate recording & diagram declarations
    recording = suite.get("recording", {})
    require(isinstance(recording, dict), "recording section is required")
    screenshots_cfg = recording.get("screenshots", {})
    trace_cfg = recording.get("trace", {})
    mock_cfg = recording.get("mock", {})
    require(screenshots_cfg.get("enabled") is True, "recording.screenshots.enabled must be true")
    require(trace_cfg.get("enabled") is True, "recording.trace.enabled must be true")
    require(mock_cfg.get("enabled") is True, "recording.mock.enabled must be true")
    require(set(trace_cfg.get("protocols", [])) <= VALID_PROTOCOLS, "recording.trace.protocols contains invalid protocol")

    diagrams = suite.get("diagrams", {})
    require(isinstance(diagrams, dict) and "sequence" in diagrams and "flow" in diagrams,
            "diagrams.sequence and diagrams.flow must be declared")

    # 4. Validate scenarios & steps
    scenario_ids = set()
    total_steps = 0
    total_exchanges = 0
    total_screenshots = 0
    seen_screenshots = set()

    for suite_name, scenario in iter_scenarios(suite):
        sc_id = scenario.get("id")
        require(isinstance(sc_id, str) and sc_id, f"suite {suite_name}: scenario missing id")
        require(sc_id not in scenario_ids, f"duplicate scenario id {sc_id!r}")
        scenario_ids.add(sc_id)
        require(scenario.get("title"), f"scenario {sc_id}: missing title")
        require(scenario.get("actorRef") in actors, f"scenario {sc_id}: unknown actorRef {scenario.get('actorRef')!r}")
        outcome = scenario.get("outcome", "success")
        require(outcome in VALID_OUTCOMES, f"scenario {sc_id}: invalid outcome {outcome!r}")
        if "entryParticipant" in scenario:
            require(scenario["entryParticipant"] in participant_ids,
                    f"scenario {sc_id}: unknown entryParticipant {scenario['entryParticipant']!r}")

        steps = scenario.get("steps")
        require(isinstance(steps, list) and steps, f"scenario {sc_id}: steps must be a non-empty list")

        step_ids = set()
        defined_vars = set()
        has_ui_step = False
        scenario_shots = 0
        awaiting_response = False

        for step in steps:
            require(isinstance(step, dict), f"scenario {sc_id}: each step must be a mapping")
            step_id = step.get("id")
            require(isinstance(step_id, str) and step_id, f"scenario {sc_id}: step missing id")
            require(step_id not in step_ids, f"scenario {sc_id}: duplicate step id {step_id!r}")
            step_ids.add(step_id)
            require(step.get("title"), f"{sc_id}.{step_id}: missing title")

            actions = PRIMARY_ACTION_KEYS & step.keys()
            require(len(actions) == 1,
                    f"{sc_id}.{step_id}: expected exactly 1 action key, found {sorted(actions)}")
            action = next(iter(actions))
            if action in UI_ACTION_KEYS:
                has_ui_step = True

            if action == "request":
                req = step["request"]
                require(isinstance(req, dict) and (req.get("operationId") or (req.get("method") and req.get("path"))),
                        f"{sc_id}.{step_id}: request requires operationId or method+path")
                awaiting_response = True
            elif action == "expectResponse":
                require(awaiting_response, f"{sc_id}.{step_id}: expectResponse has no preceding request")
                awaiting_response = False

            check_expression_refs(step, fixtures, defined_vars, f"{sc_id}.{step_id}")

            # Register saveAs after checking refs so a step cannot reference its own output
            action_body = step[action]
            if isinstance(action_body, dict) and action_body.get("saveAs"):
                defined_vars.add(action_body["saveAs"])

            # Validate screenshot anchor
            if "screenshot" in step:
                shot = step["screenshot"]
                require(isinstance(shot, str) and shot.endswith((".png", ".jpg", ".jpeg", ".webp")),
                        f"{sc_id}.{step_id}: invalid screenshot filename {shot!r}")
                require("/" not in shot and "\\" not in shot,
                        f"{sc_id}.{step_id}: screenshot must be a flat filename under screenshots/")
                require(shot not in seen_screenshots,
                        f"{sc_id}.{step_id}: duplicate screenshot filename {shot!r}")
                seen_screenshots.add(shot)
                scenario_shots += 1
                total_screenshots += 1

            # Validate declared inter-module exchanges
            for ex in step.get("exchanges", []):
                require(isinstance(ex, dict), f"{sc_id}.{step_id}: exchange must be a mapping")
                require(ex.get("from") in participant_ids, f"{sc_id}.{step_id}: unknown exchange.from {ex.get('from')!r}")
                require(ex.get("to") in participant_ids, f"{sc_id}.{step_id}: unknown exchange.to {ex.get('to')!r}")
                require(ex.get("protocol") in VALID_PROTOCOLS, f"{sc_id}.{step_id}: invalid protocol {ex.get('protocol')!r}")
                require(ex.get("operation"), f"{sc_id}.{step_id}: exchange missing operation")
                total_exchanges += 1

            total_steps += 1

        if has_ui_step:
            require(scenario_shots > 0,
                    f"scenario {sc_id}: UI scenario must declare at least one screenshot checkpoint")

    if check_diagrams:
        sync_diagrams(bundle_dir, check_only=True)

    return {
        "participants": len(participant_ids),
        "scenarios": len(scenario_ids),
        "steps": total_steps,
        "exchanges": total_exchanges,
        "screenshots": total_screenshots,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path, help="directory containing e2e.suite.yaml")
    parser.add_argument("--check-diagrams", action="store_true", help="also verify sequence.mmd & flow.mmd match DSL")
    args = parser.parse_args()
    try:
        stats = check_bundle(args.bundle, check_diagrams=args.check_diagrams)
    except (KeyError, ValueError, TypeError, OSError) as error:
        parser.exit(1, f"E2E DSL check failed: {error}\n")
    print(
        f"E2E DSL valid: {stats['participants']} participants, {stats['scenarios']} scenarios, "
        f"{stats['steps']} steps, {stats['exchanges']} exchanges, {stats['screenshots']} screenshot checkpoints."
    )


if __name__ == "__main__":
    main()
