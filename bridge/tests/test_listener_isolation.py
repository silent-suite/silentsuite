"""Listener isolation and evidence-gate integration tests for #720.

Linux full-suite wired tests using the production serve wrapper, shutdown
via socketpair, and assertion of real socket binding behaviour. These tests
exercise the actual security properties: wildcard/remote dashboard denial,
IPv6 loopback serving, missing-evidence negative control, partial-bind
failure recording, registry lifecycle, restoration, and lock handoff
concurrency.
"""

import contextlib
import logging
import os
import socket
import ssl
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

import radicale.server as radicale_server_module
from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import config
from silentsuite_bridge.radicale.server import get_registry

# Only run these tests on Linux where the full socket suite is available.
pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="Wired socket tests are Linux-only")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _free_port_ipv6() -> int:
    with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as s:
        s.bind(("::1", 0))
        return s.getsockname()[1]


def _build_configuration(hosts: str):
    """Build a Radicale configuration that won't fail on missing certs etc."""
    from radicale.config import DEFAULT_CONFIG_SCHEMA, Configuration

    configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
    configuration.update(
        {
            "server": {"hosts": hosts},
            "auth": {"type": "silentsuite_bridge.radicale.auth"},
            "storage": {"type": "silentsuite_bridge.radicale.storage"},
            "rights": {"type": "silentsuite_bridge.radicale.rights"},
            "web": {"type": "silentsuite_bridge.web"},
            "logging": {"level": "debug"},
        },
        source="test",
        privileged=True,
    )
    return configuration


@contextlib.contextmanager
def _serve_with_hosts(hosts: str, allow_remote: bool = False, monkeypatch=None):
    """Run the production serve wrapper with given SERVER_HOSTS.

    Yields (registry, thread). On exit, closes the shutdown socket and joins
    the thread. Propagates any error from the serving thread.
    """
    if monkeypatch is not None:
        monkeypatch.setattr(config, "SERVER_HOSTS", hosts)
        monkeypatch.setattr(config, "ALLOW_REMOTE", allow_remote)
    else:
        config.SERVER_HOSTS = hosts
        config.ALLOW_REMOTE = allow_remote

    registry = get_registry()
    registry.reset()

    configuration = _build_configuration(hosts)

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

    # Wait for at least one listener to bind or a failure to record
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        if registry.bound_listeners() or registry.failed_count():
            break
        time.sleep(0.05)

    try:
        yield registry, t
    finally:
        b.close()
        t.join(timeout=10)
        assert not t.is_alive(), "serving thread did not terminate within 10s"
        # Close both socketpair ends: 'a' is passed into serve() and may still
        # be open; closing it here ensures no fd leak and deterministic teardown.
        with contextlib.suppress(OSError):
            a.close()
        if thread_errors:
            raise thread_errors[0]


def _http_get(host: str, port: int, path: str = "/", timeout: float = 5.0) -> tuple[int, bytes]:
    import http.client

    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


def _http_post(host: str, port: int, path: str, body: bytes, headers: dict | None = None,
               timeout: float = 5.0) -> tuple[int, bytes]:
    import http.client

    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        hdrs = headers or {}
        conn.request("POST", path, body=body, headers=hdrs)
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


def _http_propfind(host: str, port: int, path: str = "/", timeout: float = 5.0) -> int:
    import http.client

    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request("PROPFIND", path)
        resp = conn.getresponse()
        resp.read()
        return resp.status
    finally:
        conn.close()


def _https_get(host: str, port: int, path: str = "/", timeout: float = 5.0) -> tuple[int, bytes]:
    import http.client

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=ctx)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


def _own_non_loopback_ipv4() -> str | None:
    """Return the runner's own non-loopback IPv4 address, or None."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return None


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestConstructorFailureOutput:
    """Regression for the NameError where the constructor-failure path called
    ``_print_listener_not_bound`` (which did not exist) instead of
    ``print_listener_not_bound``. A failed bind must record the failure and
    print the 'Listener not bound:' line, not raise NameError."""

    def test_http_constructor_failure_prints_not_bound_and_records(self, monkeypatch, capsys):
        from silentsuite_bridge.radicale.server import (
            ListenerRegistry, _build_bridge_http_server_class,
        )

        registry = ListenerRegistry()
        registry.reset()

        class _FailingUpstream:
            def __init__(self, configuration, family, address, handler_class):
                raise OSError("address already in use")

        BridgeHTTP = _build_bridge_http_server_class(_FailingUpstream, registry)

        with pytest.raises(OSError, match="address already in use"):
            BridgeHTTP(object(), socket.AF_INET, ("127.0.0.1", 45123), None)

        assert registry.failed_count() == 1
        captured = capsys.readouterr()
        assert "Listener not bound: 127.0.0.1:45123 (HTTP)" in captured.out, (
            f"Expected HTTP 'Listener not bound:' stdout line, got: {captured.out}"
        )

    def test_https_constructor_failure_prints_not_bound_and_records(self, monkeypatch, capsys):
        from silentsuite_bridge.radicale.server import (
            ListenerRegistry, _build_bridge_https_server_class,
        )

        registry = ListenerRegistry()
        registry.reset()

        class _FailingUpstream:
            def __init__(self, configuration, family, address, handler_class):
                raise RuntimeError("SSL context error")

        BridgeHTTPS = _build_bridge_https_server_class(_FailingUpstream, registry)

        with pytest.raises(RuntimeError, match="SSL context error"):
            BridgeHTTPS(object(), socket.AF_INET, ("127.0.0.1", 45124), None)

        assert registry.failed_count() == 1
        captured = capsys.readouterr()
        assert "Listener not bound: 127.0.0.1:45124 (HTTPS)" in captured.out, (
            f"Expected HTTPS 'Listener not bound:' stdout line, got: {captured.out}"
        )


class TestWildcardDenial:
    def test_wildcard_listener_denies_dashboard_while_dav_is_alive(self, monkeypatch):
        """Wildcard-bound listener returns 404 for /.web, 401 for PROPFIND /."""
        P1 = _free_port()
        P2 = _free_port()
        with _serve_with_hosts(
            f"127.0.0.1:{P1},0.0.0.0:{P2}",
            allow_remote=True,
            monkeypatch=monkeypatch,
        ) as (registry, thread):
            # Wait for both to bind
            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline:
                if len(registry.bound_listeners()) >= 2:
                    break
                time.sleep(0.05)
            assert len(registry.bound_listeners()) >= 2, "Expected two bound listeners"

            status, body = _http_get("127.0.0.1", P1, "/.web")
            assert status == 200, f"Loopback listener should serve dashboard, got {status}"

            status2, body2 = _http_get("127.0.0.1", P2, "/.web")
            assert status2 == 404, f"Wildcard listener should deny dashboard, got {status2}"

            # Prove wildcard DAV is alive
            dav_status = _http_propfind("127.0.0.1", P2, "/")
            assert dav_status == 401, f"Wildcard DAV should respond 401, got {dav_status}"

    def test_wildcard_post_with_valid_csrf_denied_before_side_effect(self, monkeypatch):
        """POST with a valid CSRF token to a wildcard listener is denied (404)
        and never reaches the settings handler — verified with a mutation spy.
        Uses a valid loopback Host header (127.0.0.1:P2) and valid CSRF so the
        only thing that can deny the request is the evidence gate, not a
        Host/CSRF mismatch. An allowed control on the loopback listener proves
        the route and spy are wired, so a 404 on the wildcard cannot be explained
        by a deleted source gate or an unwired spy."""
        P1 = _free_port()
        P2 = _free_port()
        from silentsuite_bridge.web import _dashboard_csrf_token

        # Mutation spy: records any settings write. Must stay empty for the
        # wildcard request and be touched exactly once for the loopback control.
        settings_calls: list = []
        monkeypatch.setattr(
            config, "save_settings",
            lambda *a, **k: settings_calls.append(a) or None,
        )

        with _serve_with_hosts(
            f"127.0.0.1:{P1},0.0.0.0:{P2}",
            allow_remote=True,
            monkeypatch=monkeypatch,
        ) as (registry, thread):
            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline:
                if len(registry.bound_listeners()) >= 2:
                    break
                time.sleep(0.05)

            assert len(registry.bound_listeners()) >= 2, "Expected two bound listeners"

            body = b'{"syncInterval":60}'
            headers = {
                "Content-Type": "application/json",
                "X-SilentSuite-CSRF": _dashboard_csrf_token,
                # Valid loopback Host matching the wildcard listener port —
                # the only deny path left is the evidence gate.
                "Host": f"127.0.0.1:{P2}",
            }
            status, resp_body = _http_post("127.0.0.1", P2, "/.web/api/settings", body, headers)
            assert status == 404, f"Wildcard POST should be denied by evidence gate, got {status}"
            assert settings_calls == [], "Wildcard POST must not reach the settings handler"

            # Allowed control on the loopback listener: same body/CSRF/Host
            # pattern against the loopback listener must reach the handler
            # and write settings, proving the route and spy are wired.
            control_headers = {
                "Content-Type": "application/json",
                "X-SilentSuite-CSRF": _dashboard_csrf_token,
                "Host": f"127.0.0.1:{P1}",
            }
            c_status, _ = _http_post("127.0.0.1", P1, "/.web/api/settings", body, control_headers)
            assert c_status == 200, f"Loopback control POST should succeed, got {c_status}"
            assert len(settings_calls) == 1, (
                f"Loopback control should reach the settings handler exactly once, "
                f"got {len(settings_calls)}"
            )


class TestNonLoopbackPeer:
    def test_non_loopback_peer_denies_dashboard(self, monkeypatch):
        """A request to a remote-bound listener from a non-loopback peer
        returns 404. Skipped when no non-loopback address is available."""
        own_ip = _own_non_loopback_ipv4()
        if own_ip is None:
            pytest.skip("No non-loopback IPv4 address available")

        P = _free_port()
        with _serve_with_hosts(
            f"127.0.0.1:{_free_port()},{own_ip}:{P}",
            allow_remote=True,
            monkeypatch=monkeypatch,
        ) as (registry, thread):
            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline:
                if len(registry.bound_listeners()) >= 2:
                    break
                time.sleep(0.05)

            status, body = _http_get(own_ip, P, "/.web")
            assert status == 404, f"Remote peer should be denied dashboard, got {status}"

    def test_remote_post_with_valid_host_no_side_effect(self, monkeypatch):
        """A POST to a real non-loopback remote listener with a valid loopback
        Host header and valid CSRF is denied (404) and never reaches the
        settings handler — the evidence gate denies on the bound remote
        listener regardless of the Host header. Skipped without a non-loopback
        address."""
        own_ip = _own_non_loopback_ipv4()
        if own_ip is None:
            pytest.skip("No non-loopback IPv4 address available")

        from silentsuite_bridge.web import _dashboard_csrf_token

        settings_calls: list = []
        monkeypatch.setattr(
            config, "save_settings",
            lambda *a, **k: settings_calls.append(a) or None,
        )

        P_remote = _free_port()
        P_loopback = _free_port()
        with _serve_with_hosts(
            f"127.0.0.1:{P_loopback},{own_ip}:{P_remote}",
            allow_remote=True,
            monkeypatch=monkeypatch,
        ) as (registry, thread):
            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline:
                if len(registry.bound_listeners()) >= 2:
                    break
                time.sleep(0.05)

            body = b'{"syncInterval":60}'
            headers = {
                "Content-Type": "application/json",
                "X-SilentSuite-CSRF": _dashboard_csrf_token,
                # Valid loopback Host — the deny must come from the evidence
                # gate (bound listener is remote), not a Host mismatch.
                "Host": f"127.0.0.1:{P_remote}",
            }
            status, _ = _http_post(own_ip, P_remote, "/.web/api/settings", body, headers)
            assert status == 404, (
                f"Remote POST should be denied by evidence gate, got {status}"
            )
            assert settings_calls == [], "Remote POST must not reach the settings handler"


class TestIPv6:
    @pytest.mark.skipif(not hasattr(socket, "AF_INET6"), reason="IPv6 not available")
    def test_ipv6_loopback_serves_dashboard(self, monkeypatch):
        """A real HTTP request to [::1]:P serves the dashboard (200)."""
        try:
            port = _free_port_ipv6()
        except OSError:
            pytest.skip("IPv6 loopback not available")

        with _serve_with_hosts(
            f"[::1]:{port}",
            monkeypatch=monkeypatch,
        ) as (registry, thread):
            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline:
                if registry.bound_listeners():
                    break
                time.sleep(0.05)

            assert registry.bound_listeners(), "Expected at least one bound listener"
            status, body = _http_get("::1", port, "/.web")
            assert status == 200, f"IPv6 loopback should serve dashboard, got {status}"

    @pytest.mark.skipif(not hasattr(socket, "AF_INET6"), reason="IPv6 not available")
    def test_ipv6_wildcard_denies_dashboard(self, monkeypatch):
        """[::]:P denies the dashboard even for a loopback peer."""
        try:
            # Get a port that's free for both ::1 and ::
            with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as s:
                s.bind(("::", 0))
                port = s.getsockname()[1]
        except OSError:
            pytest.skip("IPv6 wildcard bind not available")

        with _serve_with_hosts(
            f"127.0.0.1:{_free_port()},[::]:{port}",
            allow_remote=True,
            monkeypatch=monkeypatch,
        ) as (registry, thread):
            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline:
                if len(registry.bound_listeners()) >= 2:
                    break
                time.sleep(0.05)

            assert len(registry.bound_listeners()) >= 2, "Expected two bound listeners"
            status, body = _http_get("::1", port, "/.web")
            assert status == 404, f"IPv6 wildcard should deny dashboard, got {status}"


class TestMissingEvidenceControl:
    def test_upstream_handler_without_evidence_returns_404(self, monkeypatch):
        """Run the production wrapper but with only Application injected
        (upstream handler, no bridge evidence stamp) and assert 127.0.0.1
        returns 404. This proves fail-closed and that the passing case
        depends on the stamp.

        We inject only the bridge Application and leave the upstream
        RequestHandler/server classes, so no evidence is stamped.
        """
        from radicale import server as radicale_server
        from radicale.app import Application as RadicaleApplication

        from silentsuite_bridge.radicale.application import Application as BridgeApplication

        P = _free_port()
        if monkeypatch is not None:
            monkeypatch.setattr(config, "SERVER_HOSTS", f"127.0.0.1:{P}")
            monkeypatch.setattr(config, "ALLOW_REMOTE", False)
        else:
            config.SERVER_HOSTS = f"127.0.0.1:{P}"
            config.ALLOW_REMOTE = False

        configuration = _build_configuration(f"127.0.0.1:{P}")
        a, b = socket.socketpair()
        thread_errors: list = []

        # Inject ONLY the Application, leave upstream RequestHandler/servers.
        if not bridge_main._RADICALE_SERVER_APPLICATION_LOCK.acquire(blocking=False):
            raise RuntimeError("lock already active")
        try:
            radicale_server.Application = BridgeApplication
            try:
                def _run():
                    try:
                        radicale_server.serve(configuration, shutdown_socket=a)
                    except Exception as exc:
                        thread_errors.append(exc)

                t = threading.Thread(target=_run, daemon=True)
                t.start()

                deadline = time.monotonic() + 10.0
                while time.monotonic() < deadline:
                    # No registry to check; just wait for the socket to accept
                    try:
                        with socket.create_connection(("127.0.0.1", P), timeout=1):
                            break
                    except OSError:
                        time.sleep(0.05)

                status, body = _http_get("127.0.0.1", P, "/.web")
                assert status == 404, (
                    f"Upstream handler without evidence should return 404, got {status}"
                )
            finally:
                b.close()
                t.join(timeout=10)
                assert not t.is_alive(), "serving thread did not terminate"
                with contextlib.suppress(OSError):
                    a.close()
                # Restore Application if it still holds ours
                if radicale_server.Application is BridgeApplication:
                    radicale_server.Application = RadicaleApplication
        finally:
            bridge_main._RADICALE_SERVER_APPLICATION_LOCK.release()

        if thread_errors:
            raise thread_errors[0]


class TestPartialBind:
    def test_partial_bind_reports_one_bound_one_failed(self, monkeypatch, capsys, caplog):
        """Pre-occupy one port, assert registry records one bound + one failed,
        stdout has one Listening: and one Listener not bound: line, and the
        logger contains the redacted bind-failure message with no address or
        port from the failed entry."""
        P5 = _free_port()
        P6 = _free_port()
        blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        blocker.bind(("127.0.0.1", P5))
        blocker.listen(1)
        try:
            # DEBUG on the radicale logger: the bind loop also emits DEBUG
            # lines carrying the address, and the redaction filter must
            # rewrite every one of them, not only the WARNING.
            with caplog.at_level(logging.DEBUG, logger="radicale"):
                with _serve_with_hosts(
                    f"127.0.0.1:{P5},127.0.0.1:{P6}",
                    monkeypatch=monkeypatch,
                ) as (registry, thread):
                    deadline = time.monotonic() + 10.0
                    while time.monotonic() < deadline:
                        if registry.failed_count() >= 1 and len(registry.bound_listeners()) >= 1:
                            break
                        time.sleep(0.05)

                    bound = registry.bound_listeners()
                    assert len(bound) == 1, f"Expected exactly one bound listener, got {len(bound)}"
                    assert registry.failed_count() == 1, (
                        f"Expected exactly one failed, got {registry.failed_count()}"
                    )
        finally:
            blocker.close()

        captured = capsys.readouterr()
        assert captured.out.count("Listening:") == 1, (
            f"Expected one Listening: line, got: {captured.out}"
        )
        assert "Listener not bound:" in captured.out, (
            f"Expected a Listener not bound: line, got: {captured.out}"
        )

        # Privacy contract: upstream's "cannot create server socket on
        # '<host:port>': <error>" WARNING is rewritten by the production
        # _DavDiagnosticRedactionFilter (installed on the radicale logger when
        # silentsuite_bridge.radicale.application is imported) to the exact
        # address-free template. The raw template must never reach a handler,
        # and no record from any logger may carry the requested host or either
        # port. The operator-facing address lives only on stdout.
        radicale_messages = [
            rec.getMessage() for rec in caplog.records if rec.name.startswith("radicale")
        ]
        assert "Radicale listener bind failed" in radicale_messages, (
            f"Expected the redacted bind-failure record, got: {radicale_messages}"
        )
        assert "Radicale listener started" in radicale_messages
        assert not any("cannot create server socket" in m for m in radicale_messages), (
            f"Raw upstream bind-failure text leaked: {radicale_messages}"
        )
        radicale_text = " ".join(radicale_messages)
        for private in ("127.0.0.1", str(P5), str(P6)):
            assert private not in radicale_text, (
                f"Address material {private!r} leaked into the radicale log: {radicale_text}"
            )


class TestResolutionFailure:
    def test_resolution_failure_increments_failed_count_without_global_socket_mutation(
        self, monkeypatch, capsys, caplog,
    ):
        """A hostname that cannot resolve increments failed_count and prints
        the resolution-failure line, while a healthy loopback listener still
        binds. The test patches getaddrinfo narrowly for the exact nonexistent
        hostname so it is deterministic and does not depend on external DNS.

        Regression for the scope bug: the observing wrapper must NOT mutate
        the stdlib socket module. We assert ``socket.getaddrinfo`` is the
        original callable throughout serving and that an unrelated DNS failure
        during serving is not recorded by the bridge observer.
        """
        import socket as stdlib_socket

        real_gai = stdlib_socket.getaddrinfo

        def _scoped_gai(host, port, *args, **kwargs):
            if host == "nonexistent.invalid":
                raise stdlib_socket.gaierror(
                    stdlib_socket.EAI_NONAME, "Name or service not known"
                )
            return real_gai(host, port, *args, **kwargs)

        # Patch the real socket module narrowly for the nonexistent hostname
        # only. The bridge proxy delegates to this, so the observer fires for
        # nonexistent.invalid but real lookups (127.0.0.1) still succeed.
        monkeypatch.setattr(stdlib_socket, "getaddrinfo", _scoped_gai)

        P_healthy = _free_port()
        captured_during = {}

        with caplog.at_level(logging.DEBUG, logger="radicale"):
            with _serve_with_hosts(
                f"127.0.0.1:{P_healthy},nonexistent.invalid:12345",
                monkeypatch=monkeypatch,
            ) as (registry, thread):
                deadline = time.monotonic() + 10.0
                while time.monotonic() < deadline:
                    if (
                        registry.failed_count() >= 1
                        and len(registry.bound_listeners()) >= 1
                    ):
                        break
                    time.sleep(0.05)

                # The stdlib socket.getaddrinfo must be the real callable
                # while serving is active (the proxy swaps only the
                # radicale.server module global, never the socket module).
                captured_during["gai"] = stdlib_socket.getaddrinfo
                assert stdlib_socket.getaddrinfo is _scoped_gai, (
                    "stdlib socket.getaddrinfo must not be replaced by the "
                    "bridge observer"
                )

                assert registry.failed_count() >= 1, (
                    "Resolution failure must be recorded; got failed_count=0"
                )
                bound = registry.bound_listeners()
                assert len(bound) == 1, (
                    f"Expected exactly the healthy loopback listener bound, "
                    f"got {bound}"
                )
                assert bound[0]["host"] == "127.0.0.1"

        captured = capsys.readouterr()
        assert "Listener address resolution failed:" in captured.out, (
            f"Expected resolution-failure stdout line, got: {captured.out}"
        )
        # Privacy contract for the DNS path: upstream's "cannot retrieve IPv4
        # or IPv6 address of '<host:port>': <error>" WARNING must reach the
        # handler only as the exact redacted template, and the hostname and
        # port must be absent from every captured record. The stdout line is
        # the only place the requested spec appears.
        radicale_messages = [
            rec.getMessage() for rec in caplog.records if rec.name.startswith("radicale")
        ]
        assert "Radicale listener address resolution failed" in radicale_messages, (
            f"Expected the redacted resolution-failure record, got: {radicale_messages}"
        )
        assert not any("cannot retrieve" in m for m in radicale_messages), (
            f"Raw upstream resolution-failure text leaked: {radicale_messages}"
        )
        radicale_text = " ".join(radicale_messages)
        for private in ("nonexistent.invalid", "12345", "127.0.0.1", str(P_healthy)):
            assert private not in radicale_text, (
                f"Address material {private!r} leaked into the radicale log: {radicale_text}"
            )
        # After serve exits, the radicale.server module global is restored to
        # the real socket module; the stdlib socket module was never mutated.
        assert radicale_server_module.socket is stdlib_socket, (
            "radicale.server.socket must be restored to the real socket module"
        )

    def test_unrelated_dns_failure_not_recorded_by_bridge_observer(
        self, monkeypatch,
    ):
        """A DNS failure for a hostname the bridge is NOT configured to serve
        must not increment the bridge registry's failed_count. The observer
        only fires for hostnames Radicale passes to getaddrinfo during serve().
        The unrelated failure must actually raise through the real stdlib path
        (asserted with pytest.raises), not be swallowed by try/except pass.
        The resolver is patched narrowly for that exact name so the failure is
        deterministic and never depends on external DNS.
        """
        import socket as stdlib_socket

        real_gai = stdlib_socket.getaddrinfo
        unrelated = "totally-unrelated-nonexistent.invalid"

        def _scoped_gai(host, port, *args, **kwargs):
            if host == unrelated:
                raise stdlib_socket.gaierror(
                    stdlib_socket.EAI_NONAME, "Name or service not known"
                )
            return real_gai(host, port, *args, **kwargs)

        monkeypatch.setattr(stdlib_socket, "getaddrinfo", _scoped_gai)

        P = _free_port()
        with _serve_with_hosts(
            f"127.0.0.1:{P}", monkeypatch=monkeypatch,
        ) as (registry, thread):
            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline:
                if registry.bound_listeners():
                    break
                time.sleep(0.05)

            assert registry.bound_listeners(), "Expected a bound listener"
            failed_before = registry.failed_count()

            # Trigger the unrelated DNS failure through the stdlib module
            # (not the radicale.server proxy) and assert it actually raises.
            with pytest.raises(stdlib_socket.gaierror):
                stdlib_socket.getaddrinfo(unrelated, 80)

            assert registry.failed_count() == failed_before, (
                "Unrelated DNS failure must not be recorded by the bridge "
                "observer"
            )

    def test_resolution_only_hosts_raise_no_servers_started_deterministically(
        self, monkeypatch, capsys,
    ):
        """When every configured host fails to resolve, upstream raises
        RuntimeError('No servers started'). The harness propagates it, so the
        test expects the error explicitly, then inspects the registry/stdout.
        Deterministic via a narrowly patched resolver for the exact hostname.
        """
        import socket as stdlib_socket

        real_gai = stdlib_socket.getaddrinfo

        def _scoped_gai(host, port, *args, **kwargs):
            if host == "nonexistent.invalid":
                raise stdlib_socket.gaierror(
                    stdlib_socket.EAI_NONAME, "Name or service not known"
                )
            return real_gai(host, port, *args, **kwargs)

        monkeypatch.setattr(stdlib_socket, "getaddrinfo", _scoped_gai)

        P = _free_port()
        with pytest.raises(RuntimeError, match="No servers started"):
            with _serve_with_hosts(
                f"nonexistent.invalid:12345",
                monkeypatch=monkeypatch,
            ) as (registry, thread):
                pass  # serve exits before yielding control

        # The registry recorded the failure and stdout printed the line.
        # (The registry was marked stopped when the error propagated.)
        registry = get_registry()
        assert registry.is_stopped
        captured = capsys.readouterr()
        assert "Listener address resolution failed:" in captured.out, (
            f"Expected resolution-failure stdout line, got: {captured.out}"
        )


class TestRegistryLifecycle:
    def test_registry_stops_after_serve_exits(self, monkeypatch):
        """Registry returns None dashboard URL after serve exits."""
        P = _free_port()
        with _serve_with_hosts(
            f"127.0.0.1:{P}", monkeypatch=monkeypatch,
        ) as (registry, thread):
            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline:
                if registry.bound_listeners():
                    break
                time.sleep(0.05)

            assert registry.dashboard_url(False) is not None
            assert registry.is_started

        # After the context exits (b closed, thread joined):
        assert registry.is_stopped
        assert registry.dashboard_url(False) is None

    def test_registry_never_started_returns_none(self):
        """Never-started registry returns None for dashboard URL."""
        from silentsuite_bridge.radicale.server import ListenerRegistry

        r = ListenerRegistry()
        assert r.dashboard_url(False) is None


class TestRestoration:
    def test_globals_restored_after_serve_exits(self, monkeypatch):
        """All four radicale.server globals are restored to pinned originals."""
        import radicale.server as rad_server

        from silentsuite_bridge.radicale.server import get_pinned_originals

        P = _free_port()
        originals_before = get_pinned_originals()
        with _serve_with_hosts(
            f"127.0.0.1:{P}", monkeypatch=monkeypatch,
        ):
            pass  # context exit closes and joins

        for name, pinned in originals_before.items():
            current = getattr(rad_server, name, None)
            assert current is pinned, (
                f"radicale.server.{name} was not restored: expected {pinned}, got {current}"
            )

    def test_getaddrinfo_restored_after_serve_exits(self, monkeypatch):
        """The module-local socket proxy is restored after serve exits: the
        radicale.server module global points back at the real socket module
        and the real socket module's getaddrinfo was never replaced."""
        import radicale.server as rad_server

        original_gai = socket.getaddrinfo
        P = _free_port()
        with _serve_with_hosts(
            f"127.0.0.1:{P}", monkeypatch=monkeypatch,
        ):
            pass  # context exit closes and joins

        assert socket.getaddrinfo is original_gai, (
            "stdlib socket.getaddrinfo was replaced during serve and not "
            "restored — the observer must never mutate the socket module"
        )
        assert rad_server.socket is socket, (
            "radicale.server.socket must be restored to the real socket module"
        )

    def test_globals_restored_after_injected_exception(self, monkeypatch):
        """An exception from serve() still restores all four globals."""
        import radicale.server as rad_server

        from silentsuite_bridge.radicale.server import get_pinned_originals

        def boom(_configuration, shutdown_socket=None):
            raise RuntimeError("injected failure")

        monkeypatch.setattr(rad_server, "serve", boom)
        originals_before = get_pinned_originals()

        with pytest.raises(RuntimeError, match="injected failure"):
            bridge_main._serve_radicale_with_bridge_application(object())

        for name, pinned in originals_before.items():
            current = getattr(rad_server, name, None)
            assert current is pinned, f"{name} not restored after exception"


class _ReleaseObservingLock:
    """Stand-in for the lifecycle lock that records the registry state at the
    instant ``release()`` is entered.

    This is the deterministic regression for the stop-after-unlock ordering:
    the wrapper must have marked the registry stopped BEFORE it releases the
    lock. Under the old order (release, then mark_stopped) the recorded value
    is False; no thread timing is involved.
    """

    def __init__(self, registry):
        self._inner = threading.Lock()
        self._registry = registry
        self.stopped_at_release: list[bool] = []
        self.release_hook = None

    def acquire(self, blocking=True, timeout=-1):
        return self._inner.acquire(blocking, timeout)

    def release(self):
        self.stopped_at_release.append(self._registry.is_stopped)
        self._inner.release()
        hook, self.release_hook = self.release_hook, None
        if hook is not None:
            hook()


class TestLockHandoff:
    def test_registry_is_stopped_at_the_instant_the_lock_is_released(self, monkeypatch):
        """Ordering regression with no thread timing: the state observed from
        inside the lock's ``release()`` must already be stopped. The old
        stop-after-unlock order records False here."""
        import radicale.server as radicale_server

        registry = get_registry()
        observing = _ReleaseObservingLock(registry)
        monkeypatch.setattr(bridge_main, "_RADICALE_SERVER_APPLICATION_LOCK", observing)
        monkeypatch.setattr(radicale_server, "serve", lambda *a, **k: None)

        bridge_main._serve_radicale_with_bridge_application(
            _build_configuration(f"127.0.0.1:{_free_port()}"),
        )

        assert observing.stopped_at_release == [True], (
            "registry must be marked stopped before the lifecycle lock is released"
        )
        assert registry.is_stopped

    def test_lifecycle_handoff_under_contention(self, monkeypatch):
        """Real handoff: while one invocation holds the lifecycle lock inside
        serve(), a second invocation is rejected and does not reset the
        holder's registry. At the holder's release the registry is already
        stopped, and the successor that acquires the lock from the release
        hook (the exact window the old order raced in) sees a freshly started
        registry throughout its own serve() call.
        """
        import radicale.server as radicale_server

        registry = get_registry()
        observing = _ReleaseObservingLock(registry)
        monkeypatch.setattr(bridge_main, "_RADICALE_SERVER_APPLICATION_LOCK", observing)

        entered_serve = threading.Event()
        release_serve = threading.Event()
        successor_states: list[tuple[bool, bool]] = []

        def _hold_serve(_configuration, shutdown_socket=None):
            entered_serve.set()
            # Park until the test releases us, holding the lifecycle lock.
            assert release_serve.wait(timeout=10), "holder was not released"

        def _successor_serve(_configuration, shutdown_socket=None):
            successor_states.append((registry.is_started, registry.is_stopped))

        monkeypatch.setattr(radicale_server, "serve", _hold_serve)

        P = _free_port()
        holder_errors: list = []

        def _hold():
            try:
                bridge_main._serve_radicale_with_bridge_application(
                    _build_configuration(f"127.0.0.1:{P}"),
                )
            except BaseException as exc:
                holder_errors.append(exc)

        def _run_successor():
            # Runs on the holder thread immediately after its lock release,
            # i.e. inside the window where the old order still had
            # mark_stopped() pending.
            monkeypatch.setattr(radicale_server, "serve", _successor_serve)
            bridge_main._serve_radicale_with_bridge_application(
                _build_configuration(f"127.0.0.1:{P}"),
            )

        observing.release_hook = _run_successor

        holder = threading.Thread(target=_hold, daemon=True)
        holder.start()
        # Wait until the holder is inside serve() (lock held).
        assert entered_serve.wait(timeout=10), "holder never entered serve"
        assert registry.is_started

        # Second invocation must be rejected while the holder holds the lock
        # and must leave the holder's registry running.
        with pytest.raises(RuntimeError, match="already active"):
            bridge_main._serve_radicale_with_bridge_application(
                _build_configuration(f"127.0.0.1:{P}"),
            )
        assert registry.is_started
        assert observing.stopped_at_release == []

        # Release the holder; it restores globals, marks the registry stopped,
        # releases the lock, and the hook runs the successor in that window.
        release_serve.set()
        holder.join(timeout=10)
        assert not holder.is_alive(), "holder thread did not terminate"
        assert holder_errors == [], f"holder errors: {holder_errors}"

        # Holder release saw stopped; successor release saw stopped too.
        assert observing.stopped_at_release == [True, True]
        # The successor's serve() ran on a freshly started registry that the
        # holder's shutdown did not stomp on.
        assert successor_states == [(True, False)]
        assert registry.is_stopped


class TestTlsWired:
    def test_https_serves_dashboard_on_loopback(self, monkeypatch, tmp_path):
        """Optional TLS wired case: generate a localhost certificate, assert
        the HTTPS server subclass is used and the dashboard is served on
        https://127.0.0.1:P. Gated on openssl being available."""
        if not _has_openssl():
            pytest.skip("openssl not available for certificate generation")

        cert_path, key_path = _generate_localhost_certificate(tmp_path)
        P = _free_port()

        monkeypatch.setattr(config, "SERVER_HOSTS", f"127.0.0.1:{P}")
        monkeypatch.setattr(config, "ALLOW_REMOTE", False)
        monkeypatch.setattr(config, "SSL_ENABLED", True)
        monkeypatch.setattr(config, "SSL_CERT_FILE", str(cert_path))
        monkeypatch.setattr(config, "SSL_KEY_FILE", str(key_path))

        # Build config with ssl enabled
        from radicale.config import DEFAULT_CONFIG_SCHEMA, Configuration

        configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
        configuration.update(
            {
                "server": {
                    "hosts": f"127.0.0.1:{P}",
                    "ssl": "True",
                    "certificate": str(cert_path),
                    "key": str(key_path),
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
            if registry.bound_listeners():
                break
            time.sleep(0.05)

        try:
            assert registry.bound_listeners(), "Expected a bound HTTPS listener"
            bound = registry.bound_listeners()[0]
            assert bound.get("ssl") is True, "Bound listener should record ssl=True"

            dashboard_url = registry.dashboard_url(True)
            assert dashboard_url is not None, "Expected a dashboard URL"
            assert dashboard_url.startswith("https://"), (
                f"Dashboard URL should be https://, got {dashboard_url}"
            )

            status, body = _https_get("127.0.0.1", P, "/.web")
            assert status == 200, f"HTTPS loopback should serve dashboard, got {status}"
        finally:
            b.close()
            t.join(timeout=10)
            assert not t.is_alive(), "HTTPS serving thread did not terminate"
            with contextlib.suppress(OSError):
                a.close()

        if thread_errors:
            raise thread_errors[0]


# ---------------------------------------------------------------------------
# TLS helpers
# ---------------------------------------------------------------------------


def _has_openssl() -> bool:
    import shutil

    return shutil.which("openssl") is not None


def _generate_localhost_certificate(tmp_path: Path) -> tuple[Path, Path]:
    """Generate a self-signed localhost certificate using openssl."""
    cert = tmp_path / "localhost-cert.pem"
    key = tmp_path / "localhost-key.pem"
    subj = "/CN=localhost"
    alt = "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", str(key), "-out", str(cert),
            "-days", "1", "-nodes", "-subj", subj,
            "-addext", alt,
        ],
        check=True,
        capture_output=True,
        timeout=30,
    )
    return cert, key
