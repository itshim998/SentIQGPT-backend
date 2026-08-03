#!/usr/bin/env python3
"""Analyze bounded Fast-mode production probes and content-free latency logs."""

from __future__ import annotations

import json
import math
import os
import re
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

PROBE_PATH = Path(os.getenv("SENTIQ_BASELINE_PROBE_OUTPUT", "fast-latency-probes.jsonl"))
LOG_PATH = Path(os.getenv("SENTIQ_BASELINE_LOG_OUTPUT", "fast-latency-console.log"))
SUMMARY_JSON_PATH = Path(os.getenv("SENTIQ_BASELINE_SUMMARY_JSON", "fast-latency-summary.json"))
SUMMARY_MD_PATH = Path(os.getenv("SENTIQ_BASELINE_SUMMARY_MD", "fast-latency-summary.md"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    if not path.exists():
        return output
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            output.append(value)
    return output


def parse_json_candidates(line: str) -> Iterable[dict[str, Any]]:
    candidates = [line.strip()]
    first_brace = line.find("{")
    if first_brace >= 0:
        candidates.append(line[first_brace:].strip())
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if not isinstance(value, dict):
            continue
        yield value
        for key in ("Log", "log", "message", "Message"):
            nested = value.get(key)
            if not isinstance(nested, str):
                continue
            nested = nested.strip()
            try:
                nested_value = json.loads(nested)
            except json.JSONDecodeError:
                match = re.search(r"\{.*\}", nested)
                if not match:
                    continue
                try:
                    nested_value = json.loads(match.group(0))
                except json.JSONDecodeError:
                    continue
            if isinstance(nested_value, dict):
                yield nested_value


def read_latency_events(path: Path, trace_ids: set[str]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    if not path.exists():
        return events
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        for value in parse_json_candidates(line):
            if value.get("scope") != "fast_latency":
                continue
            trace_id = str(value.get("trace_id") or "")
            if trace_id in trace_ids:
                events.append(value)
    return events


def number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def percentile(values: list[float], percentile_value: float) -> float | None:
    clean = sorted(value for value in values if math.isfinite(value))
    if not clean:
        return None
    if len(clean) == 1:
        return round(clean[0], 1)
    rank = (len(clean) - 1) * percentile_value
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return round(clean[lower], 1)
    weight = rank - lower
    return round(clean[lower] * (1 - weight) + clean[upper] * weight, 1)


def summarize(values: list[float]) -> dict[str, Any]:
    clean = [round(value, 1) for value in values if math.isfinite(value) and value >= 0]
    return {
        "count": len(clean),
        "p50_ms": percentile(clean, 0.50),
        "p75_ms": percentile(clean, 0.75),
        "p95_ms": percentile(clean, 0.95),
        "p99_ms": percentile(clean, 0.99),
        "mean_ms": round(statistics.fmean(clean), 1) if clean else None,
        "max_ms": round(max(clean), 1) if clean else None,
    }


def phase_event(events: list[dict[str, Any]], phase: str) -> dict[str, Any] | None:
    matches = [event for event in events if event.get("phase") == phase]
    if not matches:
        return None
    return min(matches, key=lambda event: number(event.get("epoch_ms")) or float("inf"))


def phase_elapsed(events: list[dict[str, Any]], phase: str) -> float | None:
    event = phase_event(events, phase)
    return number(event.get("elapsed_ms")) if event else None


def duration_between(events: list[dict[str, Any]], start_phase: str, end_phase: str) -> float | None:
    start = phase_elapsed(events, start_phase)
    end = phase_elapsed(events, end_phase)
    if start is None or end is None or end < start:
        return None
    return round(end - start, 1)


def billing_total(events: list[dict[str, Any]]) -> float | None:
    durations = [
        number(event.get("duration_ms"))
        for event in events
        if event.get("phase") == "server.billing_rpc_completed"
    ]
    clean = [value for value in durations if value is not None and value >= 0]
    return round(sum(clean), 1) if clean else None


def auth_fallback_total(events: list[dict[str, Any]]) -> float | None:
    durations = [
        number(event.get("duration_ms"))
        for event in events
        if event.get("phase") == "server.auth_fallback_completed"
    ]
    clean = [value for value in durations if value is not None and value >= 0]
    return round(sum(clean), 1) if clean else 0.0


def safety_duration(events: list[dict[str, Any]]) -> float | None:
    direct = phase_event(events, "python.safety_request_completed")
    if direct:
        duration = number(direct.get("duration_ms"))
        if duration is not None:
            return round(duration, 1)
    return duration_between(events, "python.safety_request_started", "python.safety_request_completed")


def provider_duration(events: list[dict[str, Any]]) -> float | None:
    return duration_between(events, "python.provider_request_started", "python.provider_first_visible_delta")


def safe_difference(end: float | None, start: float | None) -> float | None:
    if end is None or start is None or end < start:
        return None
    return round(end - start, 1)


def build_trace_rows(probes: list[dict[str, Any]], events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    events_by_trace: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in events:
        events_by_trace[str(event.get("trace_id") or "")].append(event)

    rows: list[dict[str, Any]] = []
    for probe in probes:
        trace_id = str(probe.get("trace_id") or "")
        trace_events = events_by_trace.get(trace_id, [])
        gateway_start = phase_elapsed(trace_events, "server.internal_gateway_started")
        gateway_first_chunk = phase_elapsed(trace_events, "server.internal_gateway_first_chunk_received")
        first_sse = phase_elapsed(trace_events, "server.first_sse_token_written")
        billing = billing_total(trace_events)
        auth = auth_fallback_total(trace_events)
        pre_gateway_residual = None
        if gateway_start is not None:
            pre_gateway_residual = round(max(0.0, gateway_start - (billing or 0.0) - (auth or 0.0)), 1)

        row = {
            "trace_id": trace_id,
            "outcome": probe.get("outcome"),
            "status_code": probe.get("status_code"),
            "request_to_headers_ms": number(probe.get("request_to_headers_ms")),
            "headers_to_first_token_ms": number(probe.get("headers_to_first_token_ms")),
            "request_to_first_token_ms": number(probe.get("request_to_first_token_ms")),
            "request_total_ms": number(probe.get("request_total_ms")),
            "server_to_headers_ms": phase_elapsed(trace_events, "server.response_headers_sent"),
            "billing_total_ms": billing,
            "auth_fallback_total_ms": auth,
            "server_pre_gateway_ms": gateway_start,
            "pre_gateway_residual_ms": pre_gateway_residual,
            "gateway_to_first_chunk_ms": safe_difference(gateway_first_chunk, gateway_start),
            "first_chunk_to_first_sse_ms": safe_difference(first_sse, gateway_first_chunk),
            "server_to_first_sse_ms": first_sse,
            "python_safety_ms": safety_duration(trace_events),
            "python_provider_to_visible_ms": provider_duration(trace_events),
            "python_to_provider_start_ms": phase_elapsed(trace_events, "python.provider_request_started"),
            "event_count": len(trace_events),
            "has_node": any(event.get("layer") == "node" for event in trace_events),
            "has_python": any(event.get("layer") == "python" for event in trace_events),
        }
        rows.append(row)
    return rows


def metric_values(rows: list[dict[str, Any]], key: str) -> list[float]:
    output: list[float] = []
    for row in rows:
        value = number(row.get(key))
        if value is not None and value >= 0:
            output.append(value)
    return output


def choose_decision(metrics: dict[str, dict[str, Any]], coverage: dict[str, Any]) -> dict[str, Any]:
    if coverage["successful_probes"] < 5:
        return {
            "decision": "Do not optimize yet",
            "reason": "Fewer than five successful production probes completed.",
            "next_action": "Repair the live probe path or production deployment before changing Fast-mode behavior.",
            "confidence": "high",
        }
    if coverage["python_traces"] < max(3, math.ceil(coverage["successful_probes"] * 0.6)):
        return {
            "decision": "Repair production trace coverage",
            "reason": "Most successful probes did not contain Python/provider attribution.",
            "next_action": "Verify the deployed observer image, trace-header propagation, and active revision before optimizing latency.",
            "confidence": "high",
        }

    candidates = {
        "billing": metrics.get("billing_total_ms", {}).get("p50_ms"),
        "pre_gateway_residual": metrics.get("pre_gateway_residual_ms", {}).get("p50_ms"),
        "safety": metrics.get("python_safety_ms", {}).get("p50_ms"),
        "provider": metrics.get("python_provider_to_visible_ms", {}).get("p50_ms"),
        "gateway_proxy": metrics.get("first_chunk_to_first_sse_ms", {}).get("p50_ms"),
    }
    valid = {key: value for key, value in candidates.items() if isinstance(value, (int, float))}
    if not valid:
        return {
            "decision": "Add one narrower attribution pass",
            "reason": "The trace reached production but additive component medians were incomplete.",
            "next_action": "Instrument the missing phase before modifying the request path.",
            "confidence": "medium",
        }

    dominant = max(valid, key=valid.get)
    dominant_value = valid[dominant]
    total = metrics.get("request_to_first_token_ms", {}).get("p50_ms") or 0
    share = round((dominant_value / total) * 100, 1) if total else None

    mapping = {
        "billing": (
            "Combine plan resolution and quota reservation",
            "Billing/database RPC time is the largest measured pre-token component.",
            "Implement one atomic reserve-and-resolve RPC, preserving the current quota rules and models.",
        ),
        "pre_gateway_residual": (
            "Reduce serial work before Python dispatch",
            "The unexplained Node pre-gateway remainder is the largest measured component after subtracting billing and auth fallback.",
            "Add narrow spans for context composition, prompt construction, and gateway readiness, then remove the largest proven serial gate.",
        ),
        "safety": (
            "Parallelize input safety with provider startup behind a release buffer",
            "The blocking input-safety request is the largest measured component.",
            "Start safety and Groq concurrently, buffer initial provider output, release only after safety passes, and cancel/discard on block.",
        ),
        "provider": (
            "Optimize provider prefill and scheduling without changing the model",
            "Provider request-to-first-visible-delta is the largest measured component.",
            "Stabilize the GPT-OSS prompt prefix, measure cached-token use, and benchmark supported Groq service tiers before changing routing.",
        ),
        "gateway_proxy": (
            "Remove internal streaming proxy delay",
            "The internal first-chunk-to-public-SSE interval is the largest measured component.",
            "Profile Node SSE parsing/backpressure and remove avoidable buffering before considering architectural proxy removal.",
        ),
    }
    decision, reason, action = mapping[dominant]
    return {
        "decision": decision,
        "reason": reason,
        "next_action": action,
        "dominant_component": dominant,
        "dominant_p50_ms": dominant_value,
        "dominant_share_of_runner_ttft_percent": share,
        "confidence": "medium" if coverage["successful_probes"] < 20 else "high",
    }


def format_ms(value: Any) -> str:
    parsed = number(value)
    return "—" if parsed is None else f"{parsed:.1f} ms"


def main() -> None:
    probes = read_jsonl(PROBE_PATH)
    trace_ids = {str(probe.get("trace_id") or "") for probe in probes if probe.get("trace_id")}
    events = read_latency_events(LOG_PATH, trace_ids)
    rows = build_trace_rows(probes, events)
    successful = [row for row in rows if row.get("outcome") == "complete" and row.get("request_to_first_token_ms") is not None]

    metric_keys = [
        "request_to_headers_ms",
        "headers_to_first_token_ms",
        "request_to_first_token_ms",
        "request_total_ms",
        "server_to_headers_ms",
        "billing_total_ms",
        "auth_fallback_total_ms",
        "server_pre_gateway_ms",
        "pre_gateway_residual_ms",
        "gateway_to_first_chunk_ms",
        "first_chunk_to_first_sse_ms",
        "server_to_first_sse_ms",
        "python_safety_ms",
        "python_provider_to_visible_ms",
        "python_to_provider_start_ms",
    ]
    metrics = {key: summarize(metric_values(successful, key)) for key in metric_keys}
    coverage = {
        "requested_probes": len(rows),
        "successful_probes": len(successful),
        "node_traces": sum(1 for row in successful if row.get("has_node")),
        "python_traces": sum(1 for row in successful if row.get("has_python")),
        "latency_events": len(events),
    }
    decision = choose_decision(metrics, coverage)
    summary = {
        "schema_version": 1,
        "coverage": coverage,
        "metrics": metrics,
        "decision": decision,
        "traces": rows,
    }
    SUMMARY_JSON_PATH.write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")

    important = [
        ("Runner request → first token", "request_to_first_token_ms"),
        ("Runner request → response headers", "request_to_headers_ms"),
        ("Headers → first token", "headers_to_first_token_ms"),
        ("Node ingress → Python gateway start", "server_pre_gateway_ms"),
        ("Billing RPC total", "billing_total_ms"),
        ("Node pre-gateway residual", "pre_gateway_residual_ms"),
        ("Python input safety", "python_safety_ms"),
        ("Provider request → visible delta", "python_provider_to_visible_ms"),
        ("Gateway first chunk → public SSE", "first_chunk_to_first_sse_ms"),
        ("Node ingress → public first SSE", "server_to_first_sse_ms"),
    ]
    lines = [
        "# Fast-mode production latency baseline",
        "",
        f"- Requested probes: **{coverage['requested_probes']}**",
        f"- Successful first-token probes: **{coverage['successful_probes']}**",
        f"- Successful traces with Node attribution: **{coverage['node_traces']}**",
        f"- Successful traces with Python attribution: **{coverage['python_traces']}**",
        f"- Correlated latency events: **{coverage['latency_events']}**",
        "",
        "## Percentiles",
        "",
        "| Segment | Samples | p50 | p75 | p95 | max |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for label, key in important:
        metric = metrics[key]
        lines.append(
            f"| {label} | {metric['count']} | {format_ms(metric['p50_ms'])} | "
            f"{format_ms(metric['p75_ms'])} | {format_ms(metric['p95_ms'])} | {format_ms(metric['max_ms'])} |"
        )
    lines.extend([
        "",
        "## Engineering decision",
        "",
        f"**{decision['decision']}**",
        "",
        decision["reason"],
        "",
        f"Next action: {decision['next_action']}",
        "",
        f"Confidence: **{decision['confidence']}**",
    ])
    if decision.get("dominant_component"):
        lines.append(
            f"Dominant measured component: `{decision['dominant_component']}` at "
            f"{format_ms(decision.get('dominant_p50_ms'))} p50."
        )
    SUMMARY_MD_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"event": "fast_latency_baseline_summary", **summary["coverage"], **decision}, sort_keys=True))
    print(SUMMARY_MD_PATH.read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
