"""Bounded live provider smoke for SentIQ-owned model tool selection.

This script is intentionally direct: five selection prompts and three negative
prompts, with no credential rotation or automatic retry. It prints only
sanitized outcomes; prompts, arguments, credentials, and provider payloads are
never emitted.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Callable


CANONICAL_FLAGS = (
    "SENTIQ_MODEL_TOOL_REGISTRY_ENABLED",
    "SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED",
    "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED",
    "SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED",
    "SENTIQ_MODEL_IMAGE_SELECTION_ENABLED",
    "SENTIQ_MODEL_CHART_SELECTION_ENABLED",
    "SENTIQ_MODEL_FILE_SELECTION_ENABLED",
    "SENTIQ_MODEL_MEMORY_SELECTION_ENABLED",
    "SENTIQ_MODEL_TOOL_DIAGNOSTICS_ENABLED",
)
for flag in CANONICAL_FLAGS:
    os.environ[flag] = "true"

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import llm_adapter as adapter  # noqa: E402


POLICY = (
    "The available SentIQ tools are real executable capabilities. Call exactly one appropriate tool "
    "when the user explicitly requests it or the request genuinely requires it. Explicit downloadable "
    "file requests must call file_gen, explicit durable remember requests must call memory_update, and "
    "explicit image-generation requests must call image_gen. Answer normally for ordinary questions that "
    "only discuss files, memory, images, charts, or web search. Never claim completion without the "
    "corresponding tool call."
)


def object_schema(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": required,
    }


def text_property(description: str, *, values: list[str] | None = None) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "string",
        "minLength": 1,
        "maxLength": 12000,
        "description": description,
    }
    if values:
        schema["enum"] = values
    return schema


TOOLS = [
    {
        "name": "web_surf",
        "description": "Search live web sources when current or externally verified information is required.",
        "input_schema": object_schema({"query": text_property("The web research request.")}, ["query"]),
    },
    {
        "name": "image_gen",
        "description": "Generate an image when the user asks for a new visual asset.",
        "input_schema": object_schema({"prompt": text_property("The requested image.")}, ["prompt"]),
    },
    {
        "name": "chart_gen",
        "description": "Create a chart or data visualization explicitly requested by the user.",
        "input_schema": object_schema({"request": text_property("The requested chart and supplied data.")}, ["request"]),
    },
    {
        "name": "file_gen",
        "description": "Create a downloadable file explicitly requested by the user.",
        "input_schema": object_schema(
            {
                "request": text_property("The requested file and its material constraints."),
                "format": text_property("The optional output format.", values=["html", "txt", "xlsx", "pptx", "docx", "pdf"]),
            },
            ["request"],
        ),
    },
    {
        "name": "memory_update",
        "description": "Store an explicit request to remember a durable identity, preference, or project fact.",
        "input_schema": object_schema(
            {
                "content": text_property("The durable fact."),
                "type": text_property("The memory category.", values=["identity", "preference", "project"]),
                "scope": text_property("The memory scope.", values=["global", "chat"]),
            },
            ["content"],
        ),
    },
]

TOOL_REQUEST = {
    "registry_version": "2026-07-pass5-v2",
    "allowed_tool_fingerprint": "live-smoke",
    "tool_choice_policy": POLICY,
    "tools": TOOLS,
}


def safe_failure(error: BaseException) -> dict[str, str]:
    status = (
        getattr(error, "status_code", None)
        or getattr(error, "code", None)
        or getattr(error, "status", None)
    )
    output = {"error_class": error.__class__.__name__}
    if isinstance(status, int):
        output["status"] = str(status)
    return output


def is_transient(error: BaseException) -> bool:
    status = getattr(error, "status_code", None) or getattr(error, "code", None)
    return isinstance(status, int) and (status in {408, 409, 429} or status >= 500)


def validate_call(calls: Any, expected: str) -> None:
    if not isinstance(calls, list) or len(calls) != 1:
        raise AssertionError("provider did not return exactly one tool call")
    call = calls[0]
    if not isinstance(call, dict) or call.get("name") != expected:
        raise AssertionError("provider selected the wrong tool")
    arguments = call.get("arguments")
    if isinstance(arguments, str):
        arguments = json.loads(arguments)
    if not isinstance(arguments, dict) or not arguments:
        raise AssertionError("provider returned invalid tool arguments")


def consume_groq(prompt: str) -> dict[str, Any]:
    keys = adapter._get_round_robin_groq_keys()
    if not keys:
        raise RuntimeError("Groq is not configured")
    starts: dict[int, dict[str, Any]] = {}
    text_parts: list[str] = []
    for delta in adapter._call_groq_stream(
        prompt,
        keys[0],
        adapter.GROQ_CHAT_MODEL,
        max_output_tokens=700,
        execution_mode="fast",
        sentiq_tool_request=TOOL_REQUEST,
    ):
        if not isinstance(delta, dict):
            continue
        kind = delta.get("kind")
        if kind == "tool_call_start":
            index = int(delta.get("index", 0))
            starts[index] = {
                "id": str(delta.get("id") or f"groq_call_{index}"),
                "name": str(delta.get("name") or ""),
                "arguments": "",
            }
        elif kind == "tool_argument_delta":
            index = int(delta.get("index", 0))
            state = starts.setdefault(index, {"id": f"groq_call_{index}", "name": "", "arguments": ""})
            state["arguments"] += str(delta.get("text") or "")
        elif kind == "text_delta":
            text_parts.append(str(delta.get("text") or ""))
    if starts:
        return {"kind": "tool_calls", "calls": [starts[index] for index in sorted(starts)]}
    return {"kind": "assistant_text", "text": "".join(text_parts)}


def consume_gemini(prompt: str) -> dict[str, Any]:
    records = adapter._get_round_robin_gemini_records(adapter.GEMINI_STANDARD_MODEL)
    if not records:
        raise RuntimeError("Gemini is not configured")
    result = adapter._call_gemini(
        prompt,
        records[0].key,
        adapter.GEMINI_STANDARD_MODEL,
        max_output_tokens=700,
        execution_mode="fast",
        sentiq_tool_request=TOOL_REQUEST,
    )
    if not isinstance(result, dict):
        raise AssertionError("Gemini returned an unnormalized result")
    return result


def main() -> int:
    rows: list[dict[str, Any]] = []
    cases: list[tuple[str, str, Callable[[str], dict[str, Any]], str | None, str]] = [
        ("groq_web_selection", "groq", consume_groq, "web_surf", "Find the latest major AMD company news and cite live sources."),
        ("groq_chart_selection", "groq", consume_groq, "chart_gen", "Create a bar chart for Alpha 35, Beta 22, Gamma 14."),
        ("groq_memory_selection", "groq", consume_groq, "memory_update", "Remember globally that my preferred report style is concise bullet points."),
        ("gemini_image_selection", "gemini", consume_gemini, "image_gen", "Generate an image of a golden retriever puppy playing in fresh snow."),
        ("gemini_file_selection", "gemini", consume_gemini, "file_gen", "Create a downloadable txt file containing a short launch checklist."),
        ("groq_text_negative_web", "groq", consume_groq, None, "Explain at a high level how web search engines rank pages."),
        ("gemini_text_negative_image", "gemini", consume_gemini, None, "Explain how lazy-loaded images work in HTML."),
        ("groq_text_negative_chart", "groq", consume_groq, None, "When is a bar chart clearer than a line chart?"),
    ]
    requested_case = None
    if "--case" in sys.argv:
        index = sys.argv.index("--case")
        if index + 1 >= len(sys.argv):
            print(json.dumps({"live_provider_matrix": [{"name": "case_filter", "status": "FAIL", "error_class": "InvalidCase"}]}))
            return 1
        requested_case = sys.argv[index + 1]
        cases = [case for case in cases if case[0] == requested_case]
        if not cases:
            print(json.dumps({"live_provider_matrix": [{"name": "case_filter", "status": "FAIL", "error_class": "UnknownCase"}]}))
            return 1
    retried_provider = {"groq": False, "gemini": False}
    for name, provider, invoke, expected, prompt in cases:
        row: dict[str, Any] = {"name": name, "provider": provider}
        try:
            try:
                turn = invoke(prompt)
            except BaseException as first_error:
                if not is_transient(first_error) or retried_provider[provider]:
                    raise
                retried_provider[provider] = True
                row["transient_retry"] = True
                turn = invoke(prompt)
            if expected:
                if turn.get("kind") != "tool_calls":
                    raise AssertionError("provider returned text instead of a tool call")
                validate_call(turn.get("calls"), expected)
                row.update(status="PASS", outcome="tool_call", tool=expected)
            else:
                if turn.get("kind") != "assistant_text" or not str(turn.get("text") or "").strip():
                    raise AssertionError("provider returned a tool call or empty text for a negative case")
                row.update(status="PASS", outcome="assistant_text")
        except BaseException as error:  # sanitized release output by design
            row.update(status="FAIL", **safe_failure(error))
        rows.append(row)

    print(json.dumps({"live_provider_matrix": rows}, separators=(",", ":"), sort_keys=True))
    return 0 if all(row["status"] == "PASS" for row in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
