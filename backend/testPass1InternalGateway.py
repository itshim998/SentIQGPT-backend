import sys
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException
from fastapi.testclient import TestClient

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from backend import llm_service


TEST_TOKEN = "pass1-test-token"
TOKEN_HEADER = {"X-SentIQ-Internal-Token": TEST_TOKEN}


def assert_true(condition: bool, label: str) -> None:
    if not condition:
        raise AssertionError(label)
    print(f"PASS | {label}")


def assert_raises(error_type: type[Exception], fn, label: str) -> None:
    try:
        fn()
    except error_type:
        print(f"PASS | {label}")
        return
    raise AssertionError(label)


@contextmanager
def gateway_config(
    *,
    token: str,
    runtime_env: str,
    unsafe_enabled: bool = False,
    host: str = "127.0.0.1",
) -> Generator[None, None, None]:
    original = (
        llm_service.INTERNAL_SERVICE_TOKEN,
        llm_service.RUNTIME_ENV,
        llm_service.UNSAFE_INTERNAL_ENDPOINTS_ENABLED,
        llm_service.LLM_SERVICE_HOST,
    )
    llm_service.INTERNAL_SERVICE_TOKEN = token
    llm_service.RUNTIME_ENV = runtime_env
    llm_service.UNSAFE_INTERNAL_ENDPOINTS_ENABLED = unsafe_enabled
    llm_service.LLM_SERVICE_HOST = host
    try:
        yield
    finally:
        (
            llm_service.INTERNAL_SERVICE_TOKEN,
            llm_service.RUNTIME_ENV,
            llm_service.UNSAFE_INTERNAL_ENDPOINTS_ENABLED,
            llm_service.LLM_SERVICE_HOST,
        ) = original


def assert_rejected(response, label: str) -> None:
    assert_true(response.status_code == 404, f"{label} returns generic 404")
    assert_true(response.json() == {"detail": "Not found"}, f"{label} returns generic body")


def main() -> None:
    assert_raises(
        RuntimeError,
        lambda: llm_service.validate_internal_service_configuration(
            runtime_env="production",
            internal_service_token="",
            llm_service_host="127.0.0.1",
        ),
        "production startup rejects missing internal token",
    )
    assert_raises(
        RuntimeError,
        lambda: llm_service.validate_internal_service_configuration(
            runtime_env="production",
            internal_service_token=TEST_TOKEN,
            unsafe_internal_endpoints_enabled=True,
            llm_service_host="127.0.0.1",
        ),
        "production startup rejects unsafe override",
    )
    assert_raises(
        RuntimeError,
        lambda: llm_service.validate_internal_service_configuration(
            runtime_env="production",
            internal_service_token=TEST_TOKEN,
            llm_service_host="0.0.0.0",
        ),
        "production startup rejects non-loopback Python bind",
    )
    llm_service.validate_internal_service_configuration(
        runtime_env="production",
        internal_service_token=TEST_TOKEN,
        llm_service_host="127.0.0.1",
    )
    print("PASS | production startup accepts tokened loopback configuration")

    llm_service.require_internal_service_token(
        None,
        runtime_env="development",
        internal_service_token="",
        unsafe_internal_endpoints_enabled=True,
    )
    print("PASS | local unsafe override remains explicit and development-only")
    assert_raises(
        HTTPException,
        lambda: llm_service.require_internal_service_token(
            None,
            runtime_env="production",
            internal_service_token="",
            unsafe_internal_endpoints_enabled=True,
        ),
        "production cannot use tokenless unsafe override",
    )

    sensitive_requests = [
        ("get", "/llm/health/details", None),
        ("post", "/llm/invoke", {}),
        ("post", "/llm/stream", {}),
        ("post", "/llm/vision", {}),
        ("post", "/llm/embed", {}),
        ("post", "/chart/render", {}),
        ("get", "/llm/safety/audit", None),
        ("get", "/llm/safety/health", None),
        ("get", "/openapi.json", None),
        ("get", "/docs", None),
        ("get", "/redoc", None),
    ]

    with gateway_config(token=TEST_TOKEN, runtime_env="production"):
        with TestClient(llm_service.app) as client:
            liveness = client.get("/llm/health")
            assert_true(liveness.status_code == 200, "minimal liveness remains public")
            assert_true(liveness.json() == {"status": "ok"}, "public liveness contains only status")

            for method, path, payload in sensitive_requests:
                request = getattr(client, method)
                kwargs = {"json": payload} if payload is not None else {}
                assert_rejected(request(path, **kwargs), f"{method.upper()} {path} without token")
                assert_rejected(
                    request(path, headers={"X-SentIQ-Internal-Token": "wrong-token"}, **kwargs),
                    f"{method.upper()} {path} with wrong token",
                )

            details = client.get("/llm/health/details", headers=TOKEN_HEADER)
            assert_true(details.status_code == 200, "valid token reaches detailed gateway health")
            assert_true(details.json().get("status") == "ok", "detailed gateway health remains available internally")

            assert_true(
                client.post("/llm/invoke", headers=TOKEN_HEADER, json={}).status_code == 422,
                "valid token reaches invoke validation",
            )
            assert_true(
                client.post("/llm/stream", headers=TOKEN_HEADER, json={}).status_code == 422,
                "valid token reaches stream validation",
            )
            assert_true(
                client.post("/llm/vision", headers=TOKEN_HEADER, json={}).status_code == 422,
                "valid token reaches vision validation",
            )
            assert_true(
                client.post("/llm/embed", headers=TOKEN_HEADER, json={"text": ""}).status_code == 400,
                "valid token reaches embedding validation",
            )
            assert_true(
                client.post("/chart/render", headers=TOKEN_HEADER, json={"code": ""}).status_code == 400,
                "valid token reaches chart validation",
            )
            assert_true(
                client.get("/llm/safety/audit", headers=TOKEN_HEADER).status_code == 200,
                "valid token reaches safety audit",
            )

            original_call_safety_model = llm_service.call_safety_model
            called_safety_model = False
            def safety_model_spy(*_args, **_kwargs):
                nonlocal called_safety_model
                called_safety_model = True
                raise AssertionError("safety model should not be invoked")
            try:
                llm_service.call_safety_model = safety_model_spy
                safety_health = client.get("/llm/safety/health", headers=TOKEN_HEADER)
                assert_true(safety_health.status_code == 200, "valid token reaches safety health")
                assert_true(
                    safety_health.json() == {"status": "disabled", "available": False, "execution": "disabled"},
                    "safety health reports disabled status without invoking safety model",
                )
                assert_true(not called_safety_model, "safety health does not invoke safety model")
            finally:
                llm_service.call_safety_model = original_call_safety_model

    print("\nPass 1 Python internal gateway validation passed.")


if __name__ == "__main__":
    main()
