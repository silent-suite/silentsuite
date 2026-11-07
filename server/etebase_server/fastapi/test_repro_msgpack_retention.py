"""DEPS-01 reproduction attempt: retained allocations after rejected MessagePack map keys.

Real code under test
--------------------
* The installed, hash-locked ``msgpack`` wheel and its compiled ``_cmsgpack``
  ``unpackb`` (identity receipts below; no second wheel is installed).
* ``etebase_server.fastapi.msgpack.MsgpackRequest.body`` -> ``utils.msgpack_decode``
  -> ``msgpack.unpackb(content, raw=False)`` (``strict_map_key`` left at its
  default), reached through the real ``authentication_router`` for
  ``/login_challenge/`` (body model) and ``/login/`` (nested ``response`` bytes).
* The app mounts the router with the same two exception handlers that
  ``create_application`` registers. The production middleware stack
  (TrustedHost/CORS/static mount) is deliberately not exercised.

Measurement
-----------
One bounded run per module (counted below): 20 warm-up requests, then three
classes of 60 ``/login_challenge/`` requests, then 30 nested ``/login/``
requests, for 230 requests in total. Each class is bracketed by tracemalloc
snapshots, taken after every response object is released and ``gc.collect()``
has run twice. Retention is attributed only to allocations whose innermost
traced frame is the actual ``unpackb`` call line in ``utils.msgpack_decode``.
Total traced growth is logged as context, never used as attribution.

Expected-correct assertions (retention tests) are independent of the status
receipts (status tests), so neither can mask the other.
"""

from __future__ import annotations

import gc
import importlib.machinery
import importlib.metadata
import inspect
import os
import sys
import time
import tracemalloc

import msgpack
import pytest
from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient

from etebase_server.fastapi import utils as fastapi_utils
from etebase_server.fastapi.exceptions import CustomHttpException
from etebase_server.fastapi.msgpack import MsgpackResponse

AUTH_PREFIX = "/api/v1/authentication"
CHALLENGE_URL = f"{AUTH_PREFIX}/login_challenge/"
LOGIN_URL = f"{AUTH_PREFIX}/login/"
HEADERS = {"Content-Type": "application/msgpack", "Accept": "application/msgpack"}

KIB = 1024
MIB = 1024 * KIB
LARGE_VALUE_BYTES = 256 * KIB
WARMUP_REQUESTS = 20
CLASS_REQUESTS = 60
NESTED_REQUESTS = 30
TOTAL_REQUEST_BUDGET = WARMUP_REQUESTS + 3 * CLASS_REQUESTS + NESTED_REQUESTS  # 230
WALL_CLOCK_BUDGET_S = 60.0
RETENTION_BUDGET_BYTES = 64 * MIB
PEAK_BUDGET_BYTES = 256 * MIB
ATTRIBUTED_RETENTION_LIMIT = 1 * MIB
UNKNOWN_USERNAME = "deps01-unknown-user-does-not-exist"


def _unpackb_call_site() -> tuple[str, int]:
    """Locate the real ``unpackb`` call line inside ``msgpack_decode``.

    This only locates the line to filter tracemalloc on. It is not a
    behavioral assertion; if the call moves, the fixture fails loudly instead
    of silently measuring the wrong line."""
    func = fastapi_utils.msgpack_decode
    # tracemalloc records code.co_filename, so filter on exactly that string.
    filename = func.__code__.co_filename
    lines, start = inspect.getsourcelines(func)
    for offset, line in enumerate(lines):
        if "unpackb(" in line:
            return filename, start + offset
    raise AssertionError("utils.msgpack_decode no longer calls unpackb; DEPS-01 fixture must be revisited")


def _make_app() -> FastAPI:
    from etebase_server.fastapi.routers.authentication import authentication_router

    app = FastAPI()
    app.include_router(authentication_router, prefix=AUTH_PREFIX)

    # Same handlers as etebase_server.fastapi.main.create_application.
    @app.exception_handler(CustomHttpException)
    async def _custom_exception_handler(_request: Request, exc: CustomHttpException):  # noqa: RUF029
        return MsgpackResponse(status_code=exc.status_code, content=exc.as_dict)

    @app.exception_handler(RequestValidationError)
    async def _validation_exception_handler(_request: Request, exc: RequestValidationError):  # noqa: RUF029
        from pydantic import TypeAdapter
        import typing as t

        errors = TypeAdapter(t.Dict[str, t.Any])
        return MsgpackResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content=errors.dump_python({"detail": exc.errors()}),
        )

    return app


def _large(tag: int) -> bytes:
    # Distinct content per request so no object can be shared/interned.
    return tag.to_bytes(4, "big") * (LARGE_VALUE_BYTES // 4)


def _attributed_bytes(snapshot: tracemalloc.Snapshot, filename: str, lineno: int) -> int:
    filtered = snapshot.filter_traces([tracemalloc.Filter(True, filename, lineno)])
    return sum(stat.size for stat in filtered.statistics("lineno"))


def _settle() -> None:
    gc.collect()
    gc.collect()


class _Run:
    """Holds the single bounded measurement shared by this module's tests."""

    def __init__(self) -> None:
        self.requests_sent = 0
        self.statuses: dict[str, list[int]] = {}
        self.codes: dict[str, list[object]] = {}
        self.attributed_delta: dict[str, int] = {}
        self.total_delta: dict[str, int] = {}
        self.elapsed_s = 0.0
        self.peak_bytes = 0
        self.retained_overall = 0
        self.call_site: tuple[str, int] | None = None
        # Positive receipt that the line filter actually matches decoder
        # allocations (guards against a vacuous zero attribution).
        self.filter_probe_bytes = 0


@pytest.fixture(scope="module")
def deps01_run(django_db_setup, django_db_blocker) -> _Run:
    run = _Run()
    filename, lineno = _unpackb_call_site()
    run.call_site = (filename, lineno)
    client = TestClient(_make_app(), raise_server_exceptions=False)

    def post(url: str, body_bytes: bytes, label: str) -> None:
        assert run.requests_sent < TOTAL_REQUEST_BUDGET, "DEPS-01 request budget exceeded"
        run.requests_sent += 1
        response = client.post(url, content=body_bytes, headers=HEADERS)
        run.statuses.setdefault(label, []).append(response.status_code)
        code = None
        if response.headers.get("content-type", "").startswith("application/msgpack") and response.content:
            try:
                decoded = msgpack.unpackb(response.content, raw=False)
                code = decoded.get("code") if isinstance(decoded, dict) else None
                del decoded
            except Exception:  # noqa: BLE001 - receipt only
                code = "<undecodable>"
        run.codes.setdefault(label, []).append(code)
        del response

    def malformed_body(i: int) -> bytes:
        return msgpack.packb({1: _large(i)}, use_bin_type=True)

    def valid_unknown_user_body(i: int) -> bytes:
        return msgpack.packb({"username": UNKNOWN_USERNAME, "pad": _large(10_000 + i)}, use_bin_type=True)

    def tiny_malformed_body(i: int) -> bytes:
        return msgpack.packb({1: b"x"}, use_bin_type=True)

    def nested_body(i: int) -> bytes:
        inner = msgpack.packb({1: _large(20_000 + i)}, use_bin_type=True)
        return msgpack.packb({"response": inner, "signature": b"\x00" * 64}, use_bin_type=True)

    def measure(label: str, url: str, make_body, count: int) -> None:
        _settle()
        before = tracemalloc.take_snapshot()
        before_total = tracemalloc.get_traced_memory()[0]
        for i in range(count):
            body = make_body(i)
            post(url, body, label)
            del body
        _settle()
        after = tracemalloc.take_snapshot()
        after_total = tracemalloc.get_traced_memory()[0]
        run.attributed_delta[label] = _attributed_bytes(after, filename, lineno) - _attributed_bytes(
            before, filename, lineno
        )
        run.total_delta[label] = after_total - before_total
        del before, after

    started = time.monotonic()
    with django_db_blocker.unblock():
        tracemalloc.start(1)
        try:
            _settle()
            # Filter receipt (not an HTTP request): a value decoded through the
            # real msgpack_decode and still held must be attributed to the line.
            probe_before = tracemalloc.take_snapshot()
            held = fastapi_utils.msgpack_decode(msgpack.packb({"k": _large(99_999)}, use_bin_type=True))
            probe_after = tracemalloc.take_snapshot()
            run.filter_probe_bytes = _attributed_bytes(probe_after, filename, lineno) - _attributed_bytes(
                probe_before, filename, lineno
            )
            del held, probe_before, probe_after
            _settle()
            baseline = tracemalloc.get_traced_memory()[0]
            # Warm-up: exercise every request class once or more so import-time
            # and first-call caches are populated before any snapshot.
            for i in range(WARMUP_REQUESTS):
                maker, url = [
                    (valid_unknown_user_body, CHALLENGE_URL),
                    (tiny_malformed_body, CHALLENGE_URL),
                    (lambda j: msgpack.packb({"username": UNKNOWN_USERNAME}, use_bin_type=True), CHALLENGE_URL),
                    (lambda j: msgpack.packb({"response": msgpack.packb({"username": "x"}), "signature": b"\x00"}, use_bin_type=True), LOGIN_URL),
                ][i % 4]
                post(url, maker(i), "warmup")
            measure("valid_unknown_user", CHALLENGE_URL, valid_unknown_user_body, CLASS_REQUESTS)
            measure("tiny_malformed", CHALLENGE_URL, tiny_malformed_body, CLASS_REQUESTS)
            measure("large_malformed", CHALLENGE_URL, malformed_body, CLASS_REQUESTS)
            measure("nested_large_malformed", LOGIN_URL, nested_body, NESTED_REQUESTS)
            _settle()
            run.retained_overall = tracemalloc.get_traced_memory()[0] - baseline
            run.peak_bytes = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
            client.close()
    run.elapsed_s = time.monotonic() - started
    print(
        "[DEPS-01] call_site=%s:%d statuses=%s codes=%s attributed_delta=%s total_delta=%s "
        "requests=%d elapsed=%.2fs peak=%d retained_overall=%d"
        % (
            os.path.basename(filename),
            lineno,
            {k: sorted(set(v)) for k, v in run.statuses.items()},
            {k: sorted({str(c) for c in v}) for k, v in run.codes.items()},
            run.attributed_delta,
            run.total_delta,
            run.requests_sent,
            run.elapsed_s,
            run.peak_bytes,
            run.retained_overall,
        )
    )
    return run


# --- receipts ---------------------------------------------------------------


def test_deps01_receipt_runtime_and_real_c_decoder():
    assert sys.version_info[:2] == (3, 12), sys.version
    assert importlib.metadata.version("msgpack") == "1.2.1"
    from msgpack import _cmsgpack

    # The decoder actually bound as msgpack.unpackb is the compiled implementation.
    assert msgpack.unpackb is _cmsgpack.unpackb
    assert not inspect.isfunction(msgpack.unpackb), "pure-Python fallback decoder is in use"
    assert getattr(msgpack.unpackb, "__module__", None) == "msgpack._cmsgpack"
    ext_file = _cmsgpack.__file__
    assert any(ext_file.endswith(suffix) for suffix in importlib.machinery.EXTENSION_SUFFIXES), ext_file
    dist_files = [
        os.path.realpath(str(f.locate()))
        for f in (importlib.metadata.distribution("msgpack").files or [])
        if os.path.basename(str(f)).startswith("_cmsgpack")
    ]
    assert os.path.realpath(ext_file) in dist_files, (ext_file, dist_files)
    # The application decode path resolves msgpack.unpackb at call time from
    # the same module object.
    assert fastapi_utils.msgpack is msgpack


def test_deps01_receipt_line_filter_attributes_held_decoder_output(deps01_run):
    # If this fails, a zero retention result elsewhere would be vacuous: it is
    # a fixture failure, not product evidence.
    assert deps01_run.filter_probe_bytes >= LARGE_VALUE_BYTES - 4 * KIB, (deps01_run.call_site, deps01_run.filter_probe_bytes)


def test_deps01_budget_requests_time_and_memory(deps01_run):
    assert deps01_run.requests_sent == TOTAL_REQUEST_BUDGET
    assert deps01_run.elapsed_s < WALL_CLOCK_BUDGET_S, deps01_run.elapsed_s
    assert deps01_run.peak_bytes < PEAK_BUDGET_BYTES, deps01_run.peak_bytes
    assert deps01_run.retained_overall < RETENTION_BUDGET_BYTES, deps01_run.retained_overall


# --- status receipts (independent of retention) -----------------------------


def test_deps01_control_valid_key_unknown_user_is_401_user_not_found(deps01_run):
    statuses = deps01_run.statuses["valid_unknown_user"]
    codes = deps01_run.codes["valid_unknown_user"]
    assert len(statuses) == CLASS_REQUESTS
    assert set(statuses) == {401}, sorted(set(statuses))
    assert set(codes) == {"user_not_found"}, sorted({str(c) for c in codes})


def test_deps01_status_receipt_malformed_classes_are_uniform(deps01_run):
    # Records the actual status per malformed class; asserts only that each
    # class behaves uniformly and is not a success. The value is logged.
    for label, expected_count in (
        ("tiny_malformed", CLASS_REQUESTS),
        ("large_malformed", CLASS_REQUESTS),
        ("nested_large_malformed", NESTED_REQUESTS),
    ):
        statuses = deps01_run.statuses[label]
        assert len(statuses) == expected_count, label
        assert len(set(statuses)) == 1, (label, sorted(set(statuses)))
        assert statuses[0] >= 400, (label, statuses[0])


# --- retention (expected-correct; attributed to the real unpackb line) ------


def test_deps01_control_valid_key_large_value_retains_nothing_at_decoder(deps01_run):
    assert deps01_run.attributed_delta["valid_unknown_user"] < ATTRIBUTED_RETENTION_LIMIT, deps01_run.attributed_delta


def test_deps01_control_invalid_key_tiny_value_retains_nothing_at_decoder(deps01_run):
    assert deps01_run.attributed_delta["tiny_malformed"] < ATTRIBUTED_RETENTION_LIMIT, deps01_run.attributed_delta


def test_deps01_invalid_map_key_with_large_value_is_not_retained_after_gc(deps01_run):
    # Expected-correct: rejecting a non-string map key frees the decoded value.
    assert deps01_run.attributed_delta["large_malformed"] < ATTRIBUTED_RETENTION_LIMIT, deps01_run.attributed_delta


def test_deps01_nested_login_response_invalid_key_is_not_retained_after_gc(deps01_run):
    assert (
        deps01_run.attributed_delta["nested_large_malformed"] < ATTRIBUTED_RETENTION_LIMIT
    ), deps01_run.attributed_delta
