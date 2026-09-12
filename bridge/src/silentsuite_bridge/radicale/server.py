"""SilentSuite Bridge Radicale server adapters.

ListenerRegistry, bridge-owned server classes, and a request handler that
stamps loopback evidence into the WSGI environ so the dashboard gate can
authorize requests with bridge-owned facts: bound address, accepted local
address, and peer address.
"""

import logging
import ssl
import threading

logger = logging.getLogger(__name__)


# ---------- Pinned originals captured once at module import ----------
# _assert_upstream uses these; never captured per serve call.

import radicale.server as _rs

_PINNED_ORIGINALS = {
    "Application": _rs.Application,
    "RequestHandler": _rs.RequestHandler,
    "ParallelHTTPServer": _rs.ParallelHTTPServer,
    "ParallelHTTPSServer": _rs.ParallelHTTPSServer,
}


def get_pinned_originals():
    return dict(_PINNED_ORIGINALS)


# ---------- evidence object ----------

class _ListenerEvidence:
    """Frozen evidence object stamped into WSGI environ for dashboard auth.

    Fields are set once at construction and cannot be reassigned: ``__slots__``
    plus ``__setattr__``/``__delattr__`` guards make the object effectively
    immutable so a lookalike mutable object cannot satisfy the gate by having
    its fields rewritten after the type check.
    """

    __slots__ = ("listener", "accepted_local", "peer", "ssl")

    def __init__(
        self,
        *,
        listener: tuple,
        accepted_local: tuple,
        peer: str,
        ssl: bool,
    ) -> None:
        object.__setattr__(self, "listener", listener)
        object.__setattr__(self, "accepted_local", accepted_local)
        object.__setattr__(self, "peer", peer)
        object.__setattr__(self, "ssl", ssl)

    def __setattr__(self, name, value):  # noqa: D401 - invariant guard
        raise AttributeError("ListenerEvidence is immutable")

    def __delattr__(self, name):  # noqa: D401 - invariant guard
        raise AttributeError("ListenerEvidence is immutable")


# ---------- registry with lifecycle ----------

class ListenerRegistry:
    """Lock-protected lifecycle-scoped record of bound and failed listeners.

    States:
      - NEVER  (__init__)
      - STARTED (reset() called)
      - STOPPED (mark_stopped() called; URLs become None)
    """

    _NEVER = 0
    _STARTED = 1
    _STOPPED = 2

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._bound: list[dict] = []
        self._failed_count = 0
        self._state = self._NEVER
        self._listeners: list = []

    # -- change notification --

    def add_listener(self, callback) -> None:
        """Register a callable invoked after every lifecycle or bind change.

        Callbacks run synchronously on the thread that changed the registry
        (the serving thread during bind, the wrapper on stop) and outside the
        registry lock, so a callback may read the registry. No thread is
        created. Exceptions are logged in bounded form and never propagate
        into the serve loop.
        """
        with self._lock:
            self._listeners.append(callback)

    def remove_listener(self, callback) -> None:
        with self._lock:
            self._listeners = [cb for cb in self._listeners if cb is not callback]

    def _notify(self) -> None:
        with self._lock:
            callbacks = list(self._listeners)
        for callback in callbacks:
            try:
                callback()
            except Exception as exc:
                logger.warning(
                    "Listener registry callback failed (%s)", type(exc).__name__
                )

    # -- lifecycle --

    def reset(self) -> None:
        with self._lock:
            self._bound.clear()
            self._failed_count = 0
            self._state = self._STARTED
        self._notify()

    def mark_stopped(self) -> None:
        with self._lock:
            self._state = self._STOPPED
        self._notify()

    @property
    def is_started(self) -> bool:
        with self._lock:
            return self._state == self._STARTED

    @property
    def is_stopped(self) -> bool:
        with self._lock:
            return self._state == self._STOPPED

    # -- recording --

    def record_bound(self, server_address: tuple, family, ssl: bool) -> None:
        # server_address on IPv6 may be a 4-tuple (host, port, flowinfo, scope_id)
        host = server_address[0]
        port = server_address[1]
        with self._lock:
            self._bound.append(
                {"host": host, "port": port, "family": family, "ssl": ssl}
            )
        self._notify()

    def record_failed(self) -> None:
        with self._lock:
            self._failed_count += 1
        self._notify()

    # -- querying --

    def bound_listeners(self) -> list[dict]:
        with self._lock:
            return list(self._bound)

    def failed_count(self) -> int:
        with self._lock:
            return self._failed_count

    def dashboard_url(self, ssl_enabled: bool) -> str | None:
        with self._lock:
            if self._state != self._STARTED:
                return None
            for entry in self._bound:
                if _is_loopback_literal(entry["host"]):
                    scheme = "https" if entry.get("ssl", ssl_enabled) else "http"
                    host = entry["host"]
                    if ":" in host and not host.startswith("["):
                        host = f"[{host}]"
                    return f"{scheme}://{host}:{entry['port']}/"
        return None

    def dav_base_url(self, ssl_enabled: bool) -> str | None:
        """Return a bound DAV base URL (scheme://host:port), or None.

        Prefers a loopback listener (so DAV URLs point at the same safe
        endpoint as the dashboard). When no loopback bound, returns the first
        non-wildcard bound remote literal so DAV clients on a private network
        get a usable literal endpoint. Wildcard binds are never returned: a
        client cannot dial ``0.0.0.0`` or ``::``. Returns None when serving
        has not started, was stopped, or no usable listener bound.
        """
        with self._lock:
            if self._state != self._STARTED:
                return None
            # Prefer loopback.
            for entry in self._bound:
                if _is_loopback_literal(entry["host"]):
                    return _entry_base_url(entry, ssl_enabled)
            # Then any non-wildcard remote literal.
            for entry in self._bound:
                if not _is_wildcard(entry["host"]):
                    return _entry_base_url(entry, ssl_enabled)
        return None


_module_registry = ListenerRegistry()


def get_registry() -> ListenerRegistry:
    return _module_registry


# ---------- helpers ----------

def _is_loopback_literal(host: str) -> bool:
    """Return true only for a numeric loopback IP (no hostname, no wildcard)."""
    from ipaddress import ip_address

    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def _is_wildcard(host: str) -> bool:
    return host.strip() in {"", "0.0.0.0", "::", "*"}


def _entry_base_url(entry: dict, ssl_enabled: bool) -> str:
    """Build ``scheme://host:port`` from a registry bound-listener entry."""
    scheme = "https" if entry.get("ssl", ssl_enabled) else "http"
    host = entry["host"]
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"{scheme}://{host}:{entry['port']}"


# ---------- marker classes ----------

class _BridgeServerTrait:
    """Shared marker for both bridge HTTP and HTTPS server subclasses."""


# ---------- server builders ----------

def _build_bridge_http_server_class(upstream_class, registry: ListenerRegistry):
    """Create a bridge HTTP server subclass.

    The upstream constructor (which performs ``server_bind``) is wrapped in a
    try/except so that an occupied port, activation failure, or any other
    ``OSError``/``RuntimeError`` from construction records a failure and
    re-raises so Radicale's bind loop continues to the next address (upstream
    catches ``OSError`` only; a ``RuntimeError`` propagates out of serve()).
    Recording happens around the constructor, not after it, because a failed
    constructor never populates ``server_address``. The ``address`` argument
    holds the requested host:port passed to the constructor, so the
    "Listener not bound:" line uses the requested address even though the
    constructor failed before binding.
    """

    class _BridgeServer(upstream_class, _BridgeServerTrait):
        def __init__(self, configuration, family, address, handler_class):
            try:
                super().__init__(configuration, family, address, handler_class)
            except (OSError, RuntimeError):
                registry.record_failed()
                print_listener_not_bound(
                    f"{address[0]}:{address[1]}", "HTTP",
                )
                raise
            # After full construction: server_address is populated.
            registry.record_bound(self.server_address, self.address_family, ssl=False)
            _print_bound(self.server_address, ssl=False)

    return _BridgeServer


def _build_bridge_https_server_class(upstream_class, registry: ListenerRegistry):
    """Create a bridge HTTPS server subclass.

    Same constructor-failure handling as the HTTP subclass; TLS constructor
    failures (missing/unreadable cert/key, SSL context errors) are recorded
    and re-raised. Upstream catches ``OSError`` only; a ``RuntimeError`` from
    the TLS constructor propagates out of serve() rather than continuing the
    bind loop.
    """

    class _BridgeHTTPSServer(upstream_class, _BridgeServerTrait):
        def __init__(self, configuration, family, address, handler_class):
            try:
                super().__init__(configuration, family, address, handler_class)
            except (OSError, RuntimeError):
                registry.record_failed()
                print_listener_not_bound(
                    f"{address[0]}:{address[1]}", "HTTPS",
                )
                raise
            registry.record_bound(self.server_address, self.address_family, ssl=True)
            _print_bound(self.server_address, ssl=True)

    return _BridgeHTTPSServer


def _print_bound(server_address: tuple, ssl: bool) -> None:
    """Print one stdout Listening: line with role and dashboard status.

    server_address may be a 4-tuple on IPv6; we use [:2].
    """
    host = server_address[0]
    port = server_address[1]
    scheme = "https" if ssl else "http"
    host_display = f"[{host}]" if (":" in host and not host.startswith("[")) else host

    if _is_loopback_literal(host):
        print(
            f"Listening: {scheme}://{host_display}:{port}"
            " (DAV and dashboard, loopback only)"
        )
    elif _is_wildcard(host):
        print(
            f"Listening: {host_display}:{port}"
            " (bind address, DAV only, dashboard denied; not a client URL)"
        )
    else:
        print(
            f"Listening: {host_display}:{port}"
            " (remote DAV only, dashboard denied)"
        )


def print_listener_not_bound(spec: str, kind: str) -> None:
    """Print one stdout Listener not bound: line."""
    print(f"Listener not bound: {spec} ({kind})")


def print_resolution_failed(spec: str) -> None:
    """Print one stdout resolution-failure line."""
    print(f"Listener address resolution failed: {spec}")


# ---------- request handler mixin ----------

class BridgeRequestHandlerMixin:
    """Stamps loopback evidence into the WSGI environ.

    MUST be placed BEFORE the upstream RequestHandler in the MRO so its
    get_environ() is called first and the stamp is present.
    """

    def get_environ(self):
        environ = super().get_environ()
        server = getattr(self, "server", None)
        is_bridge = isinstance(server, _BridgeServerTrait)
        if not is_bridge:
            return environ
        try:
            listener = self.server.server_address[:2]
            accepted = self.request.getsockname()[:2]
            peer = self.client_address[0]

            # Strip IPv6 zone suffixes
            listener_host = listener[0]
            accepted_host = accepted[0]
            if isinstance(listener_host, str) and "%" in listener_host:
                listener_host = listener_host.split("%", 1)[0]
                listener = (listener_host, listener[1])
            if isinstance(accepted_host, str) and "%" in accepted_host:
                accepted_host = accepted_host.split("%", 1)[0]
                accepted = (accepted_host, accepted[1])
            if isinstance(peer, str) and "%" in peer:
                peer = peer.split("%", 1)[0]

            ssl_on = isinstance(self.connection, ssl.SSLSocket)
            environ["silentsuite_bridge.evidence"] = _ListenerEvidence(
                listener=listener,
                accepted_local=accepted,
                peer=peer,
                ssl=ssl_on,
            )
        except OSError:
            pass
        return environ