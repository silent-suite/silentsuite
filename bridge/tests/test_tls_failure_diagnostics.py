"""Pre-HTTP TLS failure diagnostics on a real Bridge HTTPS listener (#765).

These probes drive the production serve wrapper with a synthetic localhost
certificate (same openssl pattern as ``test_listener_isolation.TestTlsWired``)
and observe what the Bridge emits when a connection fails before any HTTP
request exists:

- a client that sends part of a genuine ClientHello and then closes;
- a client that rejects the server certificate (it trusts no CA);
- a client that sends plaintext HTTP to the HTTPS listener.

The server cannot know which real client, or which trust decision, caused a
failure, so nothing here asserts a per-probe cause. ``unknown`` is always an
acceptable category. Only observable output is asserted (log records after
the Bridge's Radicale redaction filter, plus raw stdout/stderr); no Radicale
internals are patched or imported beyond the serve wrapper itself.

``test_plaintext_http_to_https_listener_emits_fixed_category_tls_line`` is
the behavioural regression for the missing/indistinct pre-HTTP diagnostic.
The parametrized characterization tests pin the privacy and liveness
properties that any fix must preserve.
"""

import base64
import contextlib
import hashlib
import logging
import re
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import config
from silentsuite_bridge.radicale.server import get_registry

pytestmark = pytest.mark.skipif(
    sys.platform != "linux", reason="Wired TLS socket tests are Linux-only"
)


# ---------------------------------------------------------------------------
# Contract under test
# ---------------------------------------------------------------------------

# Proposed fixed-category line for one failed pre-HTTP TLS handshake. Listener
# kind is a bridge-owned classification, never an address. Categories are a
# closed set; ``unknown`` is always legitimate.
TLS_CATEGORIES = frozenset(
    {"client_closed", "client_alert", "plaintext_http", "timeout", "unknown"}
)
TLS_LINE = re.compile(
    r"TLS handshake failed \((?P<kind>loopback|remote|wildcard) listener; "
    r"category=(?P<category>[a-z_]+)\)"
)

# Every message a ``radicale`` logger record may carry after the Bridge filter
# while a pre-HTTP failure is handled. Shapes mirror
# ``radicale/application.py`` (_safe_exception_diagnostic and _redact).
_IDENT = r"[A-Za-z_][A-Za-z0-9_]{0,63}"
_BOUNDED_RADICALE_LINE = re.compile(
    rf"Radicale server request failed(?: \({_IDENT}"
    rf"(?: at [A-Za-z0-9_./-]{{1,160}}:[0-9]+ in {_IDENT})?\))?"
    r"|Radicale server failure"
    r"|Radicale server diagnostic suppressed"
    r"|Radicale failure"
    r"|Radicale diagnostic suppressed"
    r"|Radicale listener started"
    r"|Starting Radicale|Radicale server ready|Stopping Radicale"
    rf"|{TLS_LINE.pattern}"
)

# ---------------------------------------------------------------------------
# Canaries: synthetic values only; none may reach any output sink.
# ---------------------------------------------------------------------------

CERT_ORG_CANARY = "TlsCanaryOrg7f3a"
CERT_DNS_CANARY = "tls-canary-7f3a.invalid"
PATH_CANARY = "/tls-canary-7f3a-private-path/"
USER_CANARY = "tls-canary-user@example.invalid"
PASSWORD_CANARY = "tls-canary-password-7f3a"
CREDENTIAL_B64 = base64.b64encode(
    f"{USER_CANARY}:{PASSWORD_CANARY}".encode()
).decode()

# Raw protocol/certificate detail that a bounded line must not echo. Compared
# case-insensitively.
_RAW_PROTOCOL_FRAGMENTS = (
    "traceback",
    "[ssl",
    "ssl handshake failed",
    "tlsv1 alert",
    "sslv3 alert",
    "unknown ca",
    "certificate verify",
    "http_request",
    "http request",
    "wrong_version_number",
    "wrong version number",
    "eof occurred",
    "unexpected eof",
)


# ---------------------------------------------------------------------------
# Synthetic certificate and listener
# ---------------------------------------------------------------------------


def _generate_canary_certificate(tmp_path: Path) -> dict:
    """Self-signed localhost certificate carrying canary subject/SAN values."""
    cert = tmp_path / "tls-canary-cert.pem"
    key = tmp_path / "tls-canary-key.pem"
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", str(key), "-out", str(cert),
            "-days", "1", "-nodes",
            "-subj", f"/CN=localhost/O={CERT_ORG_CANARY}",
            "-addext",
            f"subjectAltName=DNS:localhost,DNS:{CERT_DNS_CANARY},IP:127.0.0.1,IP:::1",
        ],
        check=True,
        capture_output=True,
        timeout=30,
    )
    der = ssl.PEM_cert_to_DER_cert(cert.read_text())
    fingerprint = hashlib.sha256(der).hexdigest()
    return {
        "cert": cert,
        "key": key,
        "fingerprints": (
            fingerprint,
            fingerprint.upper(),
            ":".join(
                fingerprint[i:i + 2] for i in range(0, len(fingerprint), 2)
            ).upper(),
        ),
    }


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextlib.contextmanager
def _https_bridge_listener(monkeypatch, tmp_path):
    """Run the production serve wrapper on an HTTPS loopback listener."""
    if shutil.which("openssl") is None:
        pytest.skip("openssl not available for certificate generation")

    material = _generate_canary_certificate(tmp_path)
    port = _free_port()
    hosts = f"127.0.0.1:{port}"

    monkeypatch.delenv("SILENTSUITE_LISTENER_DETAIL", raising=False)
    monkeypatch.setattr(config, "SERVER_HOSTS", hosts)
    monkeypatch.setattr(config, "ALLOW_REMOTE", False)
    monkeypatch.setattr(config, "SSL_ENABLED", True)
    monkeypatch.setattr(config, "SSL_CERT_FILE", str(material["cert"]))
    monkeypatch.setattr(config, "SSL_KEY_FILE", str(material["key"]))

    from radicale.config import DEFAULT_CONFIG_SCHEMA, Configuration

    configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
    configuration.update(
        {
            "server": {
                "hosts": hosts,
                "ssl": "True",
                "certificate": str(material["cert"]),
                "key": str(material["key"]),
            },
            "auth": {"type": "silentsuite_bridge.radicale.auth"},
            "storage": {"type": "silentsuite_bridge.radicale.storage"},
            "rights": {"type": "silentsuite_bridge.radicale.rights"},
            "web": {"type": "silentsuite_bridge.web"},
            "logging": {"level": "debug"},
        },
        source="test",
        privileged=True,
    )

    registry = get_registry()
    registry.reset()
    a, b = socket.socketpair()
    thread_errors: list = []

    def _run():
        try:
            bridge_main._serve_radicale_with_bridge_application(
                configuration, shutdown_socket=a,
            )
        except Exception as exc:
            thread_errors.append(exc)

    t = threading.Thread(target=_run, daemon=True)
    t.start()

    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        if registry.bound_listeners() or registry.failed_count() or thread_errors:
            break
        time.sleep(0.05)
    # The Listening: print and "Radicale server ready" follow record_bound on
    # the serving thread; let them land before callers discard startup output.
    time.sleep(0.3)

    try:
        assert registry.bound_listeners(), "Expected a bound HTTPS listener"
        assert registry.bound_listeners()[0].get("ssl") is True
        yield {
            "port": port,
            "canaries": (
                "127.0.0.1",
                "localhost",
                str(port),
                str(tmp_path),
                CERT_ORG_CANARY,
                CERT_DNS_CANARY,
                *material["fingerprints"],
            ),
        }
    finally:
        b.close()
        t.join(timeout=10)
        assert not t.is_alive(), "HTTPS serving thread did not terminate"
        with contextlib.suppress(OSError):
            a.close()
    if thread_errors:
        raise thread_errors[0]


# ---------------------------------------------------------------------------
# Output capture: every log record (post-filter) plus raw stdout/stderr
# ---------------------------------------------------------------------------


class _Sink(logging.Handler):
    """Attached to root and ``radicale``; each record is kept once."""

    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.entries: list[dict] = []
        self._records: list = []  # keeps records alive so ids stay unique
        self._seen: set[int] = set()

    def emit(self, record):
        if id(record) in self._seen:
            return
        self._seen.add(id(record))
        self._records.append(record)
        self.entries.append(
            {
                "name": record.name,
                "levelno": record.levelno,
                "pathname": str(record.pathname).replace("\\", "/"),
                "message": record.getMessage(),
                "args": record.args,
                "exc_info": record.exc_info,
                "exc_text": record.exc_text,
                "stack_info": record.stack_info,
            }
        )


@contextlib.contextmanager
def _capture_logs():
    root = logging.getLogger()
    radicale_logger = logging.getLogger("radicale")
    previous = (root.level, radicale_logger.level)
    sink = _Sink()
    root.addHandler(sink)
    radicale_logger.addHandler(sink)
    root.setLevel(logging.DEBUG)
    radicale_logger.setLevel(logging.DEBUG)
    try:
        yield sink
    finally:
        radicale_logger.removeHandler(sink)
        root.removeHandler(sink)
        root.setLevel(previous[0])
        radicale_logger.setLevel(previous[1])


# Lifecycle lines Radicale may log after the registry already shows the bound
# listener; they must not end the observation window early.
_LIFECYCLE_LINES = frozenset(
    {
        "Starting Radicale",
        "Radicale listener started",
        "Radicale server ready",
        "Stopping Radicale",
    }
)


def _is_server_failure_entry(entry) -> bool:
    if TLS_LINE.fullmatch(entry["message"]):
        return True
    return (
        entry["pathname"].endswith("/radicale/server.py")
        and entry["message"] not in _LIFECYCLE_LINES
    )


def _observe_window(sink, capfd, start, *, timeout=5.0, settle=0.3):
    """Collect output after ``start`` until a failure diagnostic or timeout.

    Returns (entries, stdio_lines). Raw stdout/stderr is drained so a
    diagnostic printed rather than logged is observed as well.
    """
    stdio: list[str] = []

    def _drain():
        out, err = capfd.readouterr()
        stdio.extend(line for line in (out + err).splitlines() if line.strip())

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        _drain()
        if any(_is_server_failure_entry(e) for e in sink.entries[start:]) or any(
            TLS_LINE.fullmatch(line) for line in stdio
        ):
            break
        time.sleep(0.05)
    time.sleep(settle)
    _drain()
    return list(sink.entries[start:]), stdio


# ---------------------------------------------------------------------------
# Probes (client side only; no server internals touched)
# ---------------------------------------------------------------------------


def _probe_client_handshake_abort(port: int) -> int:
    """Send the first half of a genuine ClientHello, then close cleanly."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    incoming, outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
    tls = ctx.wrap_bio(incoming, outgoing, server_side=False)
    with pytest.raises(ssl.SSLWantReadError):
        tls.do_handshake()
    client_hello = outgoing.read()
    assert len(client_hello) > 16, "probe precondition: ClientHello generated"
    with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
        client_port = sock.getsockname()[1]
        sock.sendall(client_hello[: len(client_hello) // 2])
    return client_port


def _probe_client_rejects_certificate(port: int) -> int:
    """A client that trusts no CA aborts after seeing the server certificate."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)  # verify + hostname on, no CAs
    raw = socket.create_connection(("127.0.0.1", port), timeout=5)
    client_port = raw.getsockname()[1]
    try:
        with pytest.raises(ssl.SSLCertVerificationError):
            ctx.wrap_socket(raw, server_hostname="localhost")
    finally:
        with contextlib.suppress(OSError):
            raw.close()
    return client_port


def _probe_plaintext_http(port: int) -> int:
    """Send a plaintext HTTP request carrying canaries to the HTTPS listener."""
    request = (
        f"GET {PATH_CANARY} HTTP/1.1\r\n"
        f"Host: {CERT_DNS_CANARY}\r\n"
        f"Authorization: Basic {CREDENTIAL_B64}\r\n"
        "Content-Length: 0\r\n"
        "\r\n"
    ).encode()
    with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
        client_port = sock.getsockname()[1]
        sock.sendall(request)
        with contextlib.suppress(OSError):
            while sock.recv(4096):
                pass
    return client_port


_PROBES = {
    "client_handshake_abort": _probe_client_handshake_abort,
    "client_rejects_certificate": _probe_client_rejects_certificate,
    "plaintext_http": _probe_plaintext_http,
}


def _https_dashboard_status(port: int) -> int:
    import http.client

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    conn = http.client.HTTPSConnection("127.0.0.1", port, timeout=5, context=ctx)
    try:
        conn.request("GET", "/.web")
        resp = conn.getresponse()
        resp.read()
        return resp.status
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Behavioural regression (expected RED before a fix)
# ---------------------------------------------------------------------------


def test_plaintext_http_to_https_listener_emits_fixed_category_tls_line(
    monkeypatch, tmp_path, capfd
):
    """One pre-HTTP failure yields one distinct, fixed-category TLS line.

    The line names the listener kind and a closed category (``unknown`` is
    accepted), is visible at the default INFO level when logged, and the same
    failure is not reported as a generic DAV/server request failure.
    """
    with _capture_logs() as sink, _https_bridge_listener(monkeypatch, tmp_path) as listener:
        capfd.readouterr()  # discard startup output
        start = len(sink.entries)
        _probe_plaintext_http(listener["port"])
        entries, stdio = _observe_window(sink, capfd, start)

    observed = [e["message"] for e in entries] + stdio
    tls_logged = [e for e in entries if TLS_LINE.fullmatch(e["message"])]
    tls_printed = [line for line in stdio if TLS_LINE.fullmatch(line)]
    tls_lines = [e["message"] for e in tls_logged] + tls_printed

    assert len(tls_lines) == 1, (
        "expected exactly one fixed-category TLS handshake line for one "
        f"plaintext-HTTP probe; observed output: {observed!r}"
    )
    match = TLS_LINE.fullmatch(tls_lines[0])
    assert match.group("kind") == "loopback"
    assert match.group("category") in TLS_CATEGORIES
    assert match.group("category") in {"plaintext_http", "unknown"}
    for entry in tls_logged:
        assert entry["levelno"] >= logging.INFO
    generic = [
        m for m in observed
        if m.startswith(("Radicale server request failed", "DAV request"))
    ]
    assert not generic, (
        "pre-HTTP TLS failure must not also be reported as a request "
        f"failure; observed output: {observed!r}"
    )


# ---------------------------------------------------------------------------
# Characterization: privacy and liveness any fix must preserve
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("probe_name", sorted(_PROBES))
def test_pre_http_tls_failure_output_is_bounded_and_canary_free(
    probe_name, monkeypatch, tmp_path, capfd
):
    """Whatever is emitted for a pre-HTTP failure stays bounded and private,
    and the listener keeps serving afterwards. Does not require that any
    output exists."""
    with _capture_logs() as sink, _https_bridge_listener(monkeypatch, tmp_path) as listener:
        capfd.readouterr()
        start = len(sink.entries)
        client_port = _PROBES[probe_name](listener["port"])
        entries, stdio = _observe_window(sink, capfd, start, timeout=3.0)

        output = "\n".join([e["message"] for e in entries] + stdio)
        lowered = output.lower()
        forbidden = (
            *listener["canaries"],
            str(client_port),
            PATH_CANARY,
            USER_CANARY,
            PASSWORD_CANARY,
            CREDENTIAL_B64,
        )
        for fragment in forbidden:
            assert fragment not in output, (
                f"{probe_name}: private/certificate value reached output"
            )
        for fragment in _RAW_PROTOCOL_FRAGMENTS:
            assert fragment not in lowered, (
                f"{probe_name}: raw protocol detail reached output"
            )

        for entry in entries:
            if entry["name"] == "radicale" or entry["name"].startswith("radicale."):
                assert entry["args"] == ()
                assert entry["exc_info"] is None
                assert entry["exc_text"] is None
                assert entry["stack_info"] is None
                assert _BOUNDED_RADICALE_LINE.fullmatch(entry["message"]), (
                    f"{probe_name}: unbounded Radicale line {entry['message']!r}"
                )

        for line in stdio:
            if TLS_LINE.fullmatch(line):
                assert TLS_LINE.fullmatch(line).group("category") in TLS_CATEGORIES

        assert _https_dashboard_status(listener["port"]) == 200, (
            f"{probe_name}: HTTPS listener stopped serving after the probe"
        )


# ---------------------------------------------------------------------------
# Acceptance: rate limit, closed categories, per-listener scope
# ---------------------------------------------------------------------------

# Upper bound on TLS lines one listener may emit for a quick burst of
# failures. The implementation's burst must not exceed it.
MAX_TLS_LINES_PER_BURST = 5
REPEATED_PROBES = 3 * MAX_TLS_LINES_PER_BURST


def _tls_lines(entries, stdio):
    return [e for e in entries if TLS_LINE.fullmatch(e["message"])], [
        line for line in stdio if TLS_LINE.fullmatch(line)
    ]


def _assert_private_and_bounded(entries, stdio, forbidden, label):
    output = "\n".join([e["message"] for e in entries] + stdio)
    lowered = output.lower()
    for fragment in forbidden:
        assert fragment not in output, f"{label}: private value reached output"
    for fragment in _RAW_PROTOCOL_FRAGMENTS:
        assert fragment not in lowered, f"{label}: raw protocol detail reached output"
    for entry in entries:
        if TLS_LINE.fullmatch(entry["message"]):
            # The whole message is the closed line; nothing else rides along.
            assert entry["args"] in ((), None)
            assert entry["exc_info"] is None
            assert entry["exc_text"] is None
            assert entry["stack_info"] is None
        if entry["name"] == "radicale" or entry["name"].startswith("radicale."):
            assert entry["args"] == ()
            assert entry["exc_info"] is None
            assert _BOUNDED_RADICALE_LINE.fullmatch(entry["message"])


def test_repeated_pre_http_tls_failures_are_rate_limited_per_listener(
    monkeypatch, tmp_path, capfd
):
    """A burst of failures yields bounded closed-category output, no generic
    duplicates and no private values; the listener keeps serving; and a fresh
    listener run is not suppressed by an earlier run's limiter."""
    with _capture_logs() as sink:
        with _https_bridge_listener(monkeypatch, tmp_path) as listener:
            capfd.readouterr()
            start = len(sink.entries)
            client_ports = [
                _probe_plaintext_http(listener["port"])
                for _ in range(REPEATED_PROBES)
            ]
            entries, stdio = _observe_window(sink, capfd, start)
            _assert_private_and_bounded(
                entries,
                stdio,
                (
                    *listener["canaries"],
                    *(str(p) for p in client_ports),
                    PATH_CANARY,
                    USER_CANARY,
                    PASSWORD_CANARY,
                    CREDENTIAL_B64,
                ),
                "repeated plaintext",
            )
            assert _https_dashboard_status(listener["port"]) == 200

        logged, printed = _tls_lines(entries, stdio)
        lines = [e["message"] for e in logged] + printed
        observed = [e["message"] for e in entries] + stdio
        assert 1 <= len(lines) <= MAX_TLS_LINES_PER_BURST < REPEATED_PROBES, (
            f"expected bounded TLS output for {REPEATED_PROBES} failures; "
            f"observed output: {observed!r}"
        )
        for line in lines:
            match = TLS_LINE.fullmatch(line)
            assert match.group("kind") == "loopback"
            assert match.group("category") in TLS_CATEGORIES
        assert not [
            m for m in observed
            if m.startswith(("Radicale server request failed", "DAV request"))
        ], f"generic duplicate for a handled handshake: {observed!r}"

        # A new listener run starts with its own limiter.
        with _https_bridge_listener(monkeypatch, tmp_path) as fresh:
            capfd.readouterr()
            start = len(sink.entries)
            _probe_plaintext_http(fresh["port"])
            entries, stdio = _observe_window(sink, capfd, start)
        logged, printed = _tls_lines(entries, stdio)
        assert len(logged) + len(printed) == 1, (
            "a fresh listener must not inherit an earlier run's suppression; "
            f"observed output: {[e['message'] for e in entries] + stdio!r}"
        )


def _ssl_error(reason, cls=ssl.SSLError):
    # The raw message carries canaries and reason-like text; classification
    # must never consult it.
    error = cls(1, f"raw {CERT_DNS_CANARY} 127.0.0.1 HTTP_REQUEST TLSV1_ALERT_X")
    if reason is not _NO_REASON:
        error.reason = reason
    return error


_NO_REASON = object()


@pytest.mark.parametrize(
    "error, expected",
    [
        (_ssl_error("HTTP_REQUEST"), "plaintext_http"),
        (_ssl_error("HTTPS_PROXY_REQUEST"), "plaintext_http"),
        (_ssl_error("TLSV1_ALERT_UNKNOWN_CA"), "client_alert"),
        (_ssl_error("SSLV3_ALERT_BAD_CERTIFICATE"), "client_alert"),
        (_ssl_error("TLSV13_ALERT_CERTIFICATE_REQUIRED"), "client_alert"),
        (_ssl_error("UNEXPECTED_EOF_WHILE_READING"), "client_closed"),
        (_ssl_error(_NO_REASON, ssl.SSLEOFError), "client_closed"),
        (_ssl_error(_NO_REASON, ssl.SSLZeroReturnError), "client_closed"),
        (ConnectionResetError(104, "reset"), "client_closed"),
        (BrokenPipeError(32, "pipe"), "client_closed"),
        (socket.timeout("The handshake operation timed out"), "timeout"),
        (_ssl_error("WRONG_VERSION_NUMBER"), "unknown"),
        (_ssl_error("NO_SHARED_CIPHER"), "unknown"),
        (_ssl_error("http_request"), "unknown"),
        (_ssl_error(f"HTTP_REQUEST {CERT_DNS_CANARY}"), "unknown"),
        (_ssl_error("TLSV1_ALERT_" + "X" * 80), "unknown"),
        (_ssl_error(42), "unknown"),
        (_ssl_error(_NO_REASON), "unknown"),
        (RuntimeError("SSL handshake failed: [SSL: HTTP_REQUEST] http request"), "unknown"),
        (OSError(0, "Error"), "unknown"),
    ],
)
def test_tls_failure_category_uses_fixed_codes_with_unknown_fallback(error, expected):
    from silentsuite_bridge.radicale.server import _tls_failure_category

    category = _tls_failure_category(error)
    assert category == expected
    assert category in TLS_CATEGORIES


def test_tls_failure_lines_are_a_closed_set_matching_the_contract():
    from silentsuite_bridge.radicale.server import _TLS_FAILURE_LINES

    assert set(_TLS_FAILURE_LINES) == {
        (kind, category)
        for kind in ("loopback", "remote", "wildcard")
        for category in TLS_CATEGORIES
    }
    for (kind, category), line in _TLS_FAILURE_LINES.items():
        match = TLS_LINE.fullmatch(line)
        assert match and match.group("kind") == kind
        assert match.group("category") == category


def test_tls_failure_limiter_is_windowed_bounded_and_thread_safe():
    from silentsuite_bridge.radicale.server import _TlsFailureLimiter

    now = [0.0]
    limiter = _TlsFailureLimiter(burst=3, window_seconds=60.0, clock=lambda: now[0])
    assert [limiter.allow() for _ in range(5)] == [True, True, True, False, False]
    now[0] = 59.9
    assert limiter.allow() is False
    now[0] = 60.0
    assert limiter.allow() is True
    # Fixed-size state regardless of how many failures were seen.
    assert not hasattr(limiter, "__dict__")

    shared = _TlsFailureLimiter(burst=4, window_seconds=3600.0, clock=lambda: 0.0)
    results: list[bool] = []
    barrier = threading.Barrier(16)

    def _worker():
        barrier.wait()
        for _ in range(25):
            results.append(shared.allow())

    workers = [threading.Thread(target=_worker) for _ in range(16)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=10)
    assert len(results) == 16 * 25
    assert sum(results) == 4
