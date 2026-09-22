import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "backend" / "llm_service.py").read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)


def assert_true(condition: bool, label: str) -> None:
    if not condition:
        raise AssertionError(label)
    print(f"PASS | {label}")


def find_async_function(name: str) -> ast.AsyncFunctionDef:
    for node in TREE.body:
        if isinstance(node, ast.AsyncFunctionDef) and node.name == name:
            return node
    raise AssertionError(f"async function {name} not found")


def awaited_threadpool_targets(function: ast.AsyncFunctionDef) -> set[str]:
    targets: set[str] = set()
    for node in ast.walk(function):
        if not isinstance(node, ast.Await):
            continue
        call = node.value
        if not isinstance(call, ast.Call):
            continue
        if not isinstance(call.func, ast.Name) or call.func.id != "run_in_threadpool":
            continue
        if not call.args:
            continue
        target = call.args[0]
        if isinstance(target, ast.Name):
            targets.add(target.id)
    return targets


def main() -> None:
    invoke_targets = awaited_threadpool_targets(find_async_function("invoke_llm"))
    stream_targets = awaited_threadpool_targets(find_async_function("stream_llm"))

    assert_true("from starlette.concurrency import run_in_threadpool" in SOURCE, "llm service imports run_in_threadpool")
    assert_true("check_input_safety" not in invoke_targets, "invoke input safety is bypassed")
    assert_true("reserve_llm_request_slot" in invoke_targets, "invoke quota reservation runs off the event loop")
    assert_true("call_llm_router" in invoke_targets, "invoke provider call runs off the event loop")
    assert_true("check_input_safety" not in stream_targets, "stream input safety is bypassed")

    print("\nLLM service threadpool regression validation passed.")


if __name__ == "__main__":
    main()
