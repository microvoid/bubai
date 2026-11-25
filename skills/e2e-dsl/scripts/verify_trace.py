#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["PyYAML>=6.0"]
# ///
"""Verify E2E run artifacts (screenshots + inter-module trace) and emit/validate a replayable mock cassette."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bundle import VALID_PROTOCOLS, iter_scenarios, load_suite, require  # noqa: E402

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
JPEG_MAGIC = b"\xff\xd8\xff"


def check_image_file(path: Path):
    require(path.is_file(), f"missing screenshot file: {path}")
    data = path.read_bytes()
    require(len(data) >= 16, f"screenshot file too small/empty: {path}")
    if path.suffix.lower() == ".png":
        require(data.startswith(PNG_MAGIC), f"invalid PNG header in {path.name}")
    elif path.suffix.lower() in {".jpg", ".jpeg"}:
        require(data.startswith(JPEG_MAGIC), f"invalid JPEG header in {path.name}")


def check_redacted(headers: dict, redact_headers: set[str], ctx: str):
    if not isinstance(headers, dict):
        return
    for key, val in headers.items():
        if key.lower() in redact_headers and val not in (None, "", "<REDACTED>"):
            raise ValueError(f"{ctx}: sensitive header {key!r} is not redacted (expected '<REDACTED>')")


def build_cassette(suite: dict, trace: dict) -> dict:
    scenarios_map = {}
    for entry in trace["entries"]:
        sc_id = entry["scenarioId"]
        scenarios_map.setdefault(sc_id, {"interactions": []})
        req = entry["request"]
        resp = entry["response"]
        proto = entry["protocol"]

        if proto == "http":
            match = {
                "method": req.get("method"),
                "url": req.get("url"),
                "query": req.get("query", {}),
                "body": req.get("body"),
            }
            reply = {
                "status": resp.get("status"),
                "headers": resp.get("headers", {}),
                "body": resp.get("body"),
            }
        else:
            match = req
            reply = resp

        interaction = {
            "seq": entry["seq"],
            "stepId": entry["stepId"],
            "from": entry["from"],
            "to": entry["to"],
            "protocol": proto,
            "operation": entry["operation"],
            "match": match,
            "reply": reply,
        }
        if entry.get("stateDiff") is not None:
            interaction["stateDiff"] = entry["stateDiff"]
        scenarios_map[sc_id]["interactions"].append(interaction)

    return {
        "schemaVersion": 1,
        "format": suite["recording"]["mock"].get("format", "e2e-cassette-v1"),
        "suiteId": suite["id"],
        "sourceRunId": trace["runId"],
        "scenarios": scenarios_map,
    }


def verify_run(bundle_dir: Path, run_dir: Path, emit_mock: bool = False):
    _, suite, _ = load_suite(bundle_dir)
    run_dir = run_dir.resolve(strict=True)

    manifest_path = run_dir / "manifest.json"
    trace_path = run_dir / "trace.json"
    cassette_path = run_dir / "mock-cassette.json"

    require(manifest_path.is_file(), f"missing {manifest_path}")
    require(trace_path.is_file(), f"missing {trace_path}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    trace = json.loads(trace_path.read_text(encoding="utf-8"))

    require(manifest.get("suiteId") == suite["id"], "manifest.suiteId does not match e2e.suite.yaml")
    require(trace.get("suiteId") == suite["id"], "trace.suiteId does not match e2e.suite.yaml")
    require(manifest.get("runId") == trace.get("runId"), "manifest.runId differs from trace.runId")

    participant_ids = {p["id"] for p in suite["participants"]}
    redact_headers = {h.lower() for h in suite["recording"]["trace"].get("redactHeaders", [])}

    # 1. Validate trace entries structure, ordering, redaction, and replay completeness
    entries = trace.get("entries")
    require(isinstance(entries, list) and entries, "trace.json must contain at least one entry")
    last_seq = 0
    trace_index = {}
    for entry in entries:
        seq = entry.get("seq")
        require(isinstance(seq, int) and seq > last_seq, f"trace entry seq must strictly increase (got {seq!r})")
        last_seq = seq
        ctx = f"trace[{seq}]"
        require(entry.get("from") in participant_ids, f"{ctx}: unknown participant from={entry.get('from')!r}")
        require(entry.get("to") in participant_ids, f"{ctx}: unknown participant to={entry.get('to')!r}")
        require(entry.get("protocol") in VALID_PROTOCOLS, f"{ctx}: invalid protocol {entry.get('protocol')!r}")
        require(entry.get("operation"), f"{ctx}: missing operation")
        require(isinstance(entry.get("request"), dict), f"{ctx}: missing request payload (required for mock replay)")
        require(isinstance(entry.get("response"), dict), f"{ctx}: missing response payload (required for mock replay)")
        check_redacted(entry["request"].get("headers", {}), redact_headers, f"{ctx}.request")
        check_redacted(entry["response"].get("headers", {}), redact_headers, f"{ctx}.response")

        key = (entry["scenarioId"], entry["stepId"])
        trace_index.setdefault(key, []).append(entry)

    # 2. Validate every DSL scenario's screenshots and declared exchanges against run artifacts
    manifest_scenarios = {sc["id"]: sc for sc in manifest.get("scenarios", [])}
    verified_shots = 0
    verified_exchanges = 0

    for _, scenario in iter_scenarios(suite):
        sc_id = scenario["id"]
        require(sc_id in manifest_scenarios, f"scenario {sc_id!r} missing from manifest.json")
        m_sc = manifest_scenarios[sc_id]
        shot_by_step = {s["stepId"]: s["file"] for s in m_sc.get("screenshots", [])}

        for step in scenario["steps"]:
            step_id = step["id"]

            # Screenshot check
            if "screenshot" in step:
                expected_rel = f"screenshots/{step['screenshot']}"
                actual_rel = shot_by_step.get(step_id)
                require(actual_rel == expected_rel,
                        f"{sc_id}.{step_id}: manifest missing screenshot {expected_rel!r} (got {actual_rel!r})")
                check_image_file(run_dir / actual_rel)
                verified_shots += 1

            # Exchange coverage check
            recorded = trace_index.get((sc_id, step_id), [])
            for ex in step.get("exchanges", []):
                matched = [
                    e for e in recorded
                    if e["from"] == ex["from"]
                    and e["to"] == ex["to"]
                    and e["protocol"] == ex["protocol"]
                    and e["operation"] == ex["operation"]
                ]
                require(matched,
                        f"{sc_id}.{step_id}: declared exchange {ex['from']}->{ex['to']} [{ex['protocol']}] "
                        f"{ex['operation']!r} not found in trace.json")
                if ex.get("status") is not None:
                    expected_status = str(ex["status"])
                    require(
                        any(str(e["response"].get("status")) == expected_status for e in matched),
                        f"{sc_id}.{step_id}: exchange {ex['operation']!r} expected status {expected_status!r}",
                    )
                verified_exchanges += 1

    # 3. Emit or validate mock-cassette.json
    expected_cassette = build_cassette(suite, trace)
    if emit_mock:
        cassette_path.write_text(json.dumps(expected_cassette, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    else:
        require(cassette_path.is_file(), f"missing {cassette_path} (run with --emit-mock to generate)")
        actual_cassette = json.loads(cassette_path.read_text(encoding="utf-8"))
        require(actual_cassette == expected_cassette,
                "mock-cassette.json is out of sync with trace.json (re-run with --emit-mock)")

    return {
        "scenarios": len(manifest_scenarios),
        "screenshots": verified_shots,
        "exchanges": verified_exchanges,
        "trace_entries": len(entries),
        "cassette": cassette_path.name,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path, help="directory containing e2e.suite.yaml")
    parser.add_argument("run_dir", type=Path, help="directory containing manifest.json, trace.json, screenshots/")
    parser.add_argument("--emit-mock", action="store_true", help="generate/update mock-cassette.json from trace.json")
    args = parser.parse_args()
    try:
        stats = verify_run(args.bundle, args.run_dir, emit_mock=args.emit_mock)
    except (KeyError, ValueError, TypeError, OSError, json.JSONDecodeError) as error:
        parser.exit(1, f"Trace verification failed: {error}\n")
    print(
        f"Run artifacts valid: {stats['scenarios']} scenarios, {stats['screenshots']} screenshots, "
        f"{stats['exchanges']} DSL exchanges matched ({stats['trace_entries']} total trace entries), "
        f"replayable mock ready at {stats['cassette']}."
    )


if __name__ == "__main__":
    main()
