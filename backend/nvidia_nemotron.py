"""NVIDIA NIM Nemotron transport for SentIQ Chat.

This module is intentionally independent from ``llm_adapter.py``.  It owns
indexed key discovery, health-aware selection, redacted diagnostics, and the
OpenAI-compatible streaming contract.  Hidden reasoning is counted and then
discarded; only visible text and aggregate usage leave this module.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Iterable, Iterator, Mapping, Optional

import requests


LOGGER = logging.getLogger("sentiq_chat.nvidia")
_INDEXED_KEY_PATTERN = re.compile(r"^NVIDIA_API_KEY_([1-9][0-9]*)$")


def _positive_int(value: object, default: int) -> int:
    try:
        parsed = int(str(value).strip())
        return parsed if parsed > 0 else default
    except Exception:
        return default


def _estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, (len(text.encode("utf-8")) + 2) // 3)


def _extract_visible_content(value: object) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""
    parts: list[str] = []
    for item in value:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, Mapping):
            text = item.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "".join(parts)


def parse_retry_after_ms(value: object, now_seconds: Optional[float] = None) -> Optional[int]:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        seconds = float(raw)
        return max(0, int(seconds * 1000))
    except Exception:
        pass
    try:
        retry_at = parsedate_to_datetime(raw)
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=timezone.utc)
        now = datetime.fromtimestamp(now_seconds if now_seconds is not None else time.time(), tz=timezone.utc)
        return max(0, int((retry_at - now).total_seconds() * 1000))
    except Exception:
        return None


@dataclass(frozen=True)
class NvidiaKeyRecord:
    index: int
    env_name: str
    key: str = field(repr=False)

    @property
    def slot_id(self) -> str:
        return f"nvidia-slot-{self.index}"


def discover_nvidia_key_records(
    environ: Optional[Mapping[str, str]] = None,
) -> list[NvidiaKeyRecord]:
    """Return unique, non-blank indexed keys in stable numeric slot order."""

    source = os.environ if environ is None else environ
    indexed_names: list[tuple[int, str]] = []
    for name in source:
        match = _INDEXED_KEY_PATTERN.match(str(name))
        if match:
            indexed_names.append((int(match.group(1)), str(name)))

    records: list[NvidiaKeyRecord] = []
    seen_values: set[str] = set()
    for index, name in sorted(indexed_names):
        key = str(source.get(name) or "").strip()
        if not key or key in seen_values:
            continue
        seen_values.add(key)
        records.append(NvidiaKeyRecord(index=index, env_name=name, key=key))
    return records


@dataclass
class NvidiaKeySlot:
    record: NvidiaKeyRecord
    enabled: bool = True
    in_flight: int = 0
    last_selected_ms: Optional[int] = None
    consecutive_failures: int = 0
    cooldown_until_ms: int = 0
    last_429_ms: Optional[int] = None
    last_success_ms: Optional[int] = None
    observed_first_chunk_ms: Optional[int] = None
    observed_completion_ms: Optional[int] = None

    @property
    def slot_id(self) -> str:
        return self.record.slot_id


class NvidiaConfigurationError(RuntimeError):
    pass


class NvidiaProviderError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        category: str = "transient",
        status_code: Optional[int] = None,
        retry_after_ms: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.category = category
        self.status_code = status_code
        self.retry_after_ms = retry_after_ms


class NvidiaAllKeysUnavailableError(NvidiaProviderError):
    pass


@dataclass(frozen=True)
class NvidiaPoolSettings:
    transient_cooldown_ms: int = 60_000
    rate_limit_cooldown_ms: int = 180_000
    auth_failure_cooldown_ms: int = 3_600_000


class NvidiaKeyPool:
    """Least-in-flight health-aware round robin with stable slot diagnostics."""

    def __init__(
        self,
        records: Iterable[NvidiaKeyRecord],
        *,
        settings: Optional[NvidiaPoolSettings] = None,
        now_ms: Optional[Callable[[], int]] = None,
    ) -> None:
        self._slots = [NvidiaKeySlot(record=record) for record in records]
        self._settings = settings or NvidiaPoolSettings()
        self._now_ms = now_ms or (lambda: int(time.time() * 1000))
        self._cursor = 0
        self._lock = threading.Lock()

    @property
    def size(self) -> int:
        return len(self._slots)

    def safe_slot_ids(self) -> list[str]:
        return [slot.slot_id for slot in self._slots]

    def _eligible_slots(
        self,
        attempted: set[str],
        now: int,
    ) -> list[tuple[int, NvidiaKeySlot]]:
        return [
            (position, slot)
            for position, slot in enumerate(self._slots)
            if slot.slot_id not in attempted
            and slot.enabled
            and slot.cooldown_until_ms <= now
        ]

    def acquire(self, attempted: Optional[set[str]] = None) -> Optional[NvidiaKeySlot]:
        attempted_ids = attempted or set()
        with self._lock:
            now = self._now_ms()
            eligible = self._eligible_slots(attempted_ids, now)
            if not eligible:
                return None
            minimum_in_flight = min(slot.in_flight for _, slot in eligible)
            least_loaded = [
                (position, slot)
                for position, slot in eligible
                if slot.in_flight == minimum_in_flight
            ]
            position, selected = min(
                least_loaded,
                key=lambda item: ((item[0] - self._cursor) % max(1, len(self._slots)), item[0]),
            )
            self._cursor = (position + 1) % max(1, len(self._slots))
            selected.in_flight += 1
            selected.last_selected_ms = now
            return selected

    def acquire_slot(self, slot_id: str) -> Optional[NvidiaKeySlot]:
        with self._lock:
            now = self._now_ms()
            for slot in self._slots:
                if slot.slot_id != slot_id:
                    continue
                if not slot.enabled or slot.cooldown_until_ms > now:
                    return None
                slot.in_flight += 1
                slot.last_selected_ms = now
                return slot
            return None

    def release_success(
        self,
        slot: NvidiaKeySlot,
        *,
        first_chunk_ms: Optional[int],
        completion_ms: int,
    ) -> None:
        with self._lock:
            now = self._now_ms()
            slot.in_flight = max(0, slot.in_flight - 1)
            slot.consecutive_failures = 0
            slot.cooldown_until_ms = 0
            slot.last_success_ms = now
            slot.observed_first_chunk_ms = first_chunk_ms
            slot.observed_completion_ms = completion_ms

    def release_cancelled(self, slot: NvidiaKeySlot) -> None:
        with self._lock:
            slot.in_flight = max(0, slot.in_flight - 1)

    def release_failure(self, slot: NvidiaKeySlot, error: BaseException) -> None:
        with self._lock:
            now = self._now_ms()
            slot.in_flight = max(0, slot.in_flight - 1)
            slot.consecutive_failures += 1
            category = getattr(error, "category", "transient")
            retry_after_ms = getattr(error, "retry_after_ms", None)

            if category == "auth":
                # Invalid credentials should not be retried again in this process.
                slot.enabled = False
                slot.cooldown_until_ms = now + self._settings.auth_failure_cooldown_ms
            elif category == "rate_limit":
                slot.last_429_ms = now
                slot.cooldown_until_ms = now + max(
                    self._settings.rate_limit_cooldown_ms,
                    int(retry_after_ms or 0),
                )
            else:
                slot.cooldown_until_ms = now + self._settings.transient_cooldown_ms

    def diagnostics(self) -> list[dict[str, object]]:
        with self._lock:
            return [
                {
                    "slot_id": slot.slot_id,
                    "enabled": slot.enabled,
                    "in_flight": slot.in_flight,
                    "last_selected_ms": slot.last_selected_ms,
                    "consecutive_failures": slot.consecutive_failures,
                    "cooldown_until_ms": slot.cooldown_until_ms,
                    "last_429_ms": slot.last_429_ms,
                    "last_success_ms": slot.last_success_ms,
                    "observed_first_chunk_ms": slot.observed_first_chunk_ms,
                    "observed_completion_ms": slot.observed_completion_ms,
                }
                for slot in self._slots
            ]


@dataclass(frozen=True)
class NvidiaProviderSettings:
    enabled: bool
    base_url: str = "https://integrate.api.nvidia.com/v1"
    model: str = "nvidia/nemotron-3-ultra-550b-a55b"
    total_timeout_ms: int = 120_000
    first_chunk_timeout_ms: int = 30_000
    stream_idle_timeout_ms: int = 45_000


@dataclass(frozen=True)
class NvidiaUsage:
    input_tokens: int
    output_tokens: int
    total_tokens: int
    hidden_reasoning_tokens: int
    source: str

    def as_internal_event(self, slot_id: str) -> dict[str, object]:
        return {
            "kind": "provider_usage",
            "usage": {
                "input_tokens": self.input_tokens,
                "output_tokens": self.output_tokens,
                "total_tokens": self.total_tokens,
                "hidden_reasoning_tokens": self.hidden_reasoning_tokens,
                "source": self.source,
            },
            "slot_id": slot_id,
        }


@dataclass(frozen=True)
class NvidiaCompletion:
    usage: NvidiaUsage
    first_chunk_ms: Optional[int]
    completion_ms: int


def _classify_http_failure(status_code: int) -> str:
    if status_code in {401, 403}:
        return "auth"
    if status_code == 429:
        return "rate_limit"
    return "transient"


def _set_response_idle_timeout(response: object, timeout_seconds: float) -> None:
    candidates = [
        getattr(getattr(response, "raw", None), "_fp", None),
        getattr(getattr(getattr(response, "raw", None), "_fp", None), "fp", None),
        getattr(getattr(getattr(getattr(response, "raw", None), "_fp", None), "fp", None), "raw", None),
    ]
    for candidate in candidates:
        socket = getattr(candidate, "_sock", None)
        if socket and hasattr(socket, "settimeout"):
            try:
                socket.settimeout(timeout_seconds)
                return
            except Exception:
                continue


class NvidiaNemotronProvider:
    def __init__(
        self,
        settings: NvidiaProviderSettings,
        pool: NvidiaKeyPool,
        *,
        request: Optional[Callable[..., object]] = None,
        monotonic: Optional[Callable[[], float]] = None,
    ) -> None:
        self.settings = settings
        self.pool = pool
        self._request = request or requests.post
        self._monotonic = monotonic or time.monotonic

    @classmethod
    def from_env(
        cls,
        *,
        environ: Optional[Mapping[str, str]] = None,
        request: Optional[Callable[..., object]] = None,
    ) -> "NvidiaNemotronProvider":
        source = os.environ if environ is None else environ
        enabled = str(source.get("SENTIQ_NVIDIA_PROVIDER_ENABLED") or "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        settings = NvidiaProviderSettings(
            enabled=enabled,
            base_url=str(source.get("NVIDIA_BASE_URL") or "https://integrate.api.nvidia.com/v1").rstrip("/"),
            model=str(source.get("NVIDIA_NEMOTRON_MODEL") or "nvidia/nemotron-3-ultra-550b-a55b").strip(),
            total_timeout_ms=_positive_int(source.get("SENTIQ_INTUITIVE_TOTAL_TIMEOUT_MS"), 120_000),
            first_chunk_timeout_ms=_positive_int(source.get("SENTIQ_NVIDIA_FIRST_CHUNK_TIMEOUT_MS"), 30_000),
            stream_idle_timeout_ms=_positive_int(source.get("SENTIQ_NVIDIA_STREAM_IDLE_TIMEOUT_MS"), 45_000),
        )
        pool_settings = NvidiaPoolSettings(
            transient_cooldown_ms=_positive_int(source.get("SENTIQ_NVIDIA_KEY_COOLDOWN_MS"), 60_000),
            rate_limit_cooldown_ms=_positive_int(source.get("SENTIQ_NVIDIA_429_COOLDOWN_MS"), 180_000),
            auth_failure_cooldown_ms=_positive_int(source.get("SENTIQ_NVIDIA_AUTH_FAILURE_COOLDOWN_MS"), 3_600_000),
        )
        records = discover_nvidia_key_records(source) if enabled else []
        return cls(settings, NvidiaKeyPool(records, settings=pool_settings), request=request)

    def safe_diagnostics(self) -> dict[str, object]:
        return {
            "enabled": self.settings.enabled,
            "configured_slots": self.pool.safe_slot_ids(),
            "slots": self.pool.diagnostics(),
        }

    def _assert_configured(self) -> None:
        if not self.settings.enabled:
            raise NvidiaConfigurationError("The Intuitive text provider is disabled.")
        if self.pool.size == 0:
            raise NvidiaConfigurationError(
                "The Intuitive text provider is enabled but has no usable indexed key slots."
            )
        if not self.settings.model:
            raise NvidiaConfigurationError("The Intuitive text provider model is not configured.")

    def _payload(
        self,
        prompt: str,
        *,
        max_tokens: int,
        reasoning_budget: int,
    ) -> dict[str, object]:
        return {
            "model": self.settings.model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": True,
            "stream_options": {"include_usage": True},
            "max_tokens": max(1, int(max_tokens)),
            "chat_template_kwargs": {"enable_thinking": True},
            "reasoning_budget": max(0, int(reasoning_budget)),
        }

    def _open_response(
        self,
        slot: NvidiaKeySlot,
        prompt: str,
        *,
        max_tokens: int,
        reasoning_budget: int,
    ) -> object:
        try:
            response = self._request(
                f"{self.settings.base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {slot.record.key}",
                    "Content-Type": "application/json",
                    "Accept": "text/event-stream",
                },
                json=self._payload(
                    prompt,
                    max_tokens=max_tokens,
                    reasoning_budget=reasoning_budget,
                ),
                timeout=(
                    max(0.001, self.settings.first_chunk_timeout_ms / 1000),
                    max(0.001, self.settings.first_chunk_timeout_ms / 1000),
                ),
                stream=True,
            )
        except TimeoutError as error:
            raise NvidiaProviderError("Intuitive provider request timed out.", category="transient") from error
        except Exception as error:
            raise NvidiaProviderError("Intuitive provider network request failed.", category="transient") from error

        status_code = int(getattr(response, "status_code", 0) or 0)
        if status_code >= 400:
            headers = getattr(response, "headers", {}) or {}
            retry_after_ms = parse_retry_after_ms(
                headers.get("Retry-After") if isinstance(headers, Mapping) else None,
            )
            try:
                response.close()
            except Exception:
                pass
            raise NvidiaProviderError(
                f"Intuitive provider request failed with status {status_code}.",
                category=_classify_http_failure(status_code),
                status_code=status_code,
                retry_after_ms=retry_after_ms,
            )
        return response

    def _stream_slot(
        self,
        slot: NvidiaKeySlot,
        prompt: str,
        *,
        max_tokens: int,
        reasoning_budget: int,
    ) -> Iterator[str]:
        started = self._monotonic()
        deadline = started + (self.settings.total_timeout_ms / 1000)
        response = self._open_response(
            slot,
            prompt,
            max_tokens=max_tokens,
            reasoning_budget=reasoning_budget,
        )
        first_chunk_ms: Optional[int] = None
        visible_parts: list[str] = []
        hidden_reasoning_tokens = 0
        reported_prompt_tokens: Optional[int] = None
        reported_completion_tokens: Optional[int] = None
        reported_total_tokens: Optional[int] = None

        try:
            try:
                lines = response.iter_lines(decode_unicode=True)
            except Exception as error:
                raise NvidiaProviderError("Intuitive provider stream could not start.") from error

            for raw_line in lines:
                if self._monotonic() > deadline:
                    raise NvidiaProviderError("Intuitive provider total timeout exceeded.")
                if raw_line is None:
                    continue
                line = raw_line.decode("utf-8", errors="replace") if isinstance(raw_line, bytes) else str(raw_line)
                line = line.strip()
                if not line or line.startswith(":") or not line.startswith("data:"):
                    continue
                payload_text = line[5:].strip()
                if payload_text == "[DONE]":
                    break
                try:
                    payload = json.loads(payload_text)
                except Exception as error:
                    raise NvidiaProviderError(
                        "Intuitive provider returned a malformed stream.",
                        category="malformed",
                    ) from error
                if not isinstance(payload, Mapping):
                    raise NvidiaProviderError(
                        "Intuitive provider returned a malformed stream.",
                        category="malformed",
                    )

                if first_chunk_ms is None:
                    first_chunk_ms = max(0, int((self._monotonic() - started) * 1000))
                    _set_response_idle_timeout(
                        response,
                        max(0.001, self.settings.stream_idle_timeout_ms / 1000),
                    )

                usage = payload.get("usage")
                if isinstance(usage, Mapping):
                    for key, target in (
                        ("prompt_tokens", "prompt"),
                        ("completion_tokens", "completion"),
                        ("total_tokens", "total"),
                    ):
                        value = usage.get(key)
                        if isinstance(value, (int, float)) and value >= 0:
                            if target == "prompt":
                                reported_prompt_tokens = int(value)
                            elif target == "completion":
                                reported_completion_tokens = int(value)
                            else:
                                reported_total_tokens = int(value)

                choices = payload.get("choices")
                if choices is None:
                    continue
                if not isinstance(choices, list):
                    raise NvidiaProviderError(
                        "Intuitive provider returned a malformed stream.",
                        category="malformed",
                    )
                if not choices:
                    continue
                choice = choices[0]
                if not isinstance(choice, Mapping):
                    continue
                delta = choice.get("delta")
                if not isinstance(delta, Mapping):
                    continue

                reasoning = delta.get("reasoning_content")
                if isinstance(reasoning, str) and reasoning:
                    hidden_reasoning_tokens += _estimate_tokens(reasoning)

                visible = _extract_visible_content(delta.get("content"))
                if visible:
                    visible_parts.append(visible)
                    yield visible
        except GeneratorExit:
            raise
        except NvidiaProviderError:
            raise
        except Exception as error:
            category = "transient"
            if isinstance(error, (ValueError, json.JSONDecodeError)):
                category = "malformed"
            raise NvidiaProviderError(
                "Intuitive provider stream failed.",
                category=category,
            ) from error
        finally:
            try:
                response.close()
            except Exception:
                pass

        visible_text = "".join(visible_parts)
        if not visible_text.strip():
            raise NvidiaProviderError(
                "Intuitive provider stream produced no visible answer.",
                category="empty_stream",
            )

        estimated_input_tokens = _estimate_tokens(prompt)
        estimated_output_floor = _estimate_tokens(visible_text) + hidden_reasoning_tokens
        input_tokens = reported_prompt_tokens
        output_tokens = reported_completion_tokens
        source = "reported"
        if input_tokens is None:
            input_tokens = estimated_input_tokens
            source = "estimated" if output_tokens is None else "reported_with_estimate"
        if output_tokens is None:
            output_tokens = estimated_output_floor
            source = "estimated" if reported_prompt_tokens is None else "reported_with_estimate"
        elif output_tokens < estimated_output_floor:
            # Some compatible endpoints report visible completion tokens only.
            # Conservatively floor usage at visible + discarded reasoning so the
            # hidden stream can never escape current-request accounting.
            output_tokens = estimated_output_floor
            source = "reported_with_hidden_floor"
        total_tokens = max(
            int(reported_total_tokens or 0),
            input_tokens + output_tokens,
        )
        completion_ms = max(0, int((self._monotonic() - started) * 1000))
        return NvidiaCompletion(
            usage=NvidiaUsage(
                input_tokens=max(0, input_tokens),
                output_tokens=max(0, output_tokens),
                total_tokens=max(0, total_tokens),
                hidden_reasoning_tokens=max(0, hidden_reasoning_tokens),
                source=source,
            ),
            first_chunk_ms=first_chunk_ms,
            completion_ms=completion_ms,
        )

    def stream(
        self,
        prompt: str,
        *,
        max_tokens: int,
        reasoning_budget: int,
    ) -> Iterator[object]:
        self._assert_configured()
        attempted: set[str] = set()
        last_error: Optional[BaseException] = None

        while len(attempted) < self.pool.size:
            slot = self.pool.acquire(attempted)
            if slot is None:
                break
            attempted.add(slot.slot_id)
            visible_started = False
            try:
                stream = self._stream_slot(
                    slot,
                    prompt,
                    max_tokens=max_tokens,
                    reasoning_budget=reasoning_budget,
                )
                while True:
                    try:
                        chunk = next(stream)
                    except StopIteration as completed:
                        completion = completed.value
                        break
                    visible_started = visible_started or bool(str(chunk).strip())
                    yield chunk
                if not isinstance(completion, NvidiaCompletion):
                    raise NvidiaProviderError(
                        "Intuitive provider stream did not complete safely.",
                        category="malformed",
                    )
                self.pool.release_success(
                    slot,
                    first_chunk_ms=completion.first_chunk_ms,
                    completion_ms=completion.completion_ms,
                )
                LOGGER.info(
                    "[NvidiaKeyPool] event=success slot_id=%s first_chunk_ms=%s completion_ms=%d",
                    slot.slot_id,
                    completion.first_chunk_ms,
                    completion.completion_ms,
                )
                yield completion.usage.as_internal_event(slot.slot_id)
                return
            except GeneratorExit:
                self.pool.release_cancelled(slot)
                try:
                    stream.close()
                except Exception:
                    pass
                raise
            except BaseException as error:
                last_error = error
                self.pool.release_failure(slot, error)
                LOGGER.warning(
                    "[NvidiaKeyPool] event=failure slot_id=%s category=%s status=%s visible_started=%s",
                    slot.slot_id,
                    getattr(error, "category", "transient"),
                    getattr(error, "status_code", None),
                    "true" if visible_started else "false",
                )
                if visible_started:
                    raise

        raise NvidiaAllKeysUnavailableError(
            "All healthy Intuitive provider key slots are unavailable.",
            category=getattr(last_error, "category", "transient"),
            status_code=getattr(last_error, "status_code", None),
            retry_after_ms=getattr(last_error, "retry_after_ms", None),
        ) from last_error

    def complete(
        self,
        prompt: str,
        *,
        max_tokens: int,
        reasoning_budget: int,
    ) -> tuple[str, NvidiaUsage, str]:
        visible: list[str] = []
        usage: Optional[NvidiaUsage] = None
        slot_id = ""
        for item in self.stream(
            prompt,
            max_tokens=max_tokens,
            reasoning_budget=reasoning_budget,
        ):
            if isinstance(item, str):
                visible.append(item)
            elif isinstance(item, Mapping) and item.get("kind") == "provider_usage":
                raw_usage = item.get("usage")
                if isinstance(raw_usage, Mapping):
                    usage = NvidiaUsage(
                        input_tokens=int(raw_usage.get("input_tokens") or 0),
                        output_tokens=int(raw_usage.get("output_tokens") or 0),
                        total_tokens=int(raw_usage.get("total_tokens") or 0),
                        hidden_reasoning_tokens=int(raw_usage.get("hidden_reasoning_tokens") or 0),
                        source=str(raw_usage.get("source") or "estimated"),
                    )
                slot_id = str(item.get("slot_id") or "")
        if usage is None:
            raise NvidiaProviderError("Intuitive provider usage accounting was unavailable.")
        return "".join(visible), usage, slot_id

    def complete_on_slot(
        self,
        slot_id: str,
        prompt: str,
        *,
        max_tokens: int,
        reasoning_budget: int,
    ) -> tuple[str, NvidiaUsage]:
        """Low-cost internal verification hook using one safe slot identifier."""

        self._assert_configured()
        slot = self.pool.acquire_slot(slot_id)
        if slot is None:
            raise NvidiaAllKeysUnavailableError(f"{slot_id} is not currently healthy.")
        try:
            visible: list[str] = []
            stream = self._stream_slot(
                slot,
                prompt,
                max_tokens=max_tokens,
                reasoning_budget=reasoning_budget,
            )
            while True:
                try:
                    visible.append(next(stream))
                except StopIteration as completed:
                    completion = completed.value
                    break
            if not isinstance(completion, NvidiaCompletion):
                raise NvidiaProviderError("Intuitive provider slot verification did not complete safely.")
            self.pool.release_success(
                slot,
                first_chunk_ms=completion.first_chunk_ms,
                completion_ms=completion.completion_ms,
            )
            return "".join(visible), completion.usage
        except GeneratorExit:
            self.pool.release_cancelled(slot)
            raise
        except BaseException as error:
            self.pool.release_failure(slot, error)
            raise
