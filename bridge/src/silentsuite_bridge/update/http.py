"""Public unauthenticated HTTP client for release lookup and downloads.

Manual bounded redirects, exact HTTPS host allowlist, streamed max sizes,
sanitized exceptions.  urllib is instructed never to auto-follow redirects.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlparse

from .types import HttpError

# Exact hosts allowed for every hop — no wildcard subdomain acceptance.
_ALLOWED_HOSTS = frozenset({
    "api.github.com",
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
    "codeload.github.com",
})

# Release JSON max size
_MAX_RELEASE_JSON = 512 * 1024

# Binary download max size
_MAX_BINARY = 128 * 1024 * 1024

# Checksum sidecar max size — passed explicitly by the replace orchestrator
MAX_CHECKSUM_BYTES = 1024

DEFAULT_TIMEOUT = 60
DEFAULT_MAX_REDIRECTS = 5

_USER_AGENT = "SilentSuite-Bridge-Updater"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Return redirect responses without following them automatically."""

    def http_error_301(self, request, response, code, message, headers):
        return response

    http_error_302 = http_error_301
    http_error_303 = http_error_301
    http_error_307 = http_error_301
    http_error_308 = http_error_301


class SilentSuiteHttpAdapter:
    """Public unauthenticated HTTP client with bounded redirects/time/size."""

    def __init__(
        self,
        *,
        transport: Any = None,
        timeout: int = DEFAULT_TIMEOUT,
        max_redirects: int = DEFAULT_MAX_REDIRECTS,
        max_size: int | None = None,
    ):
        self._transport = transport
        self._timeout = timeout
        self._max_redirects = max_redirects
        self._max_size = max_size

    def fetch_releases(self) -> list[dict]:
        """Fetch GitHub Releases JSON. Returns list of release dicts."""
        url = "https://api.github.com/repos/silent-suite/silentsuite/releases?per_page=100"
        body = self.download(url, max_size=_MAX_RELEASE_JSON)
        try:
            data = json.loads(body)
        except (json.JSONDecodeError, ValueError):
            raise HttpError("GitHub Releases API returned invalid JSON.")

        if not isinstance(data, list):
            raise HttpError("GitHub Releases API response is not a list.")

        return data

    def download(self, url: str, max_size: int | None = None) -> bytes:
        """Download `url` with bounded redirects, time, and size."""
        effective_max = max_size if max_size is not None else self._max_size
        return _bounded_download(
            url=url,
            transport=self._transport,
            timeout=self._timeout,
            max_redirects=self._max_redirects,
            max_size=effective_max or _MAX_BINARY,
        )


def _bounded_download(
    url: str,
    transport,
    timeout: int,
    max_redirects: int,
    max_size: int,
    _redirect_count: int = 0,
) -> bytes:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower().rstrip(".")

    if host not in _ALLOWED_HOSTS:
        raise HttpError("Refusing disallowed host.")
    if _redirect_count > max_redirects:
        raise HttpError("Too many redirects.")
    if parsed.scheme != "https":
        raise HttpError("Refusing non-HTTPS URL.")

    if transport is not None:
        # Injected fake transport (tests)
        try:
            resp = transport.get(url, timeout=timeout)
        except Exception:
            raise HttpError("Network error during download.") from None
    else:
        req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
        opener = urllib.request.build_opener(_NoRedirect())
        try:
            resp = opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as err:
            # Non-2xx from the real transport. Close and sanitize.
            _close_response(err)
            raise HttpError("Request failed.") from None
        except Exception:
            raise HttpError("Network error during download.") from None

    status = int(getattr(resp, "status", 0))
    location = _extract_location(resp)

    if status in (301, 302, 303, 307, 308) and location:
        next_url = _resolve_redirect(url, location)
        _close_response(resp)
        return _bounded_download(
            next_url,
            transport=transport,
            timeout=timeout,
            max_redirects=max_redirects,
            max_size=max_size,
            _redirect_count=_redirect_count + 1,
        )

    if status < 200 or status >= 300:
        _close_response(resp)
        raise HttpError("Request failed.")

    # Read body
    if transport is not None:
        content = getattr(resp, "content", None)
        if content is not None:
            encoded = content if isinstance(content, bytes) else content.encode()
            if len(encoded) > max_size:
                _close_response(resp)
                raise HttpError("Download size exceeded.")
            _close_response(resp)
            return encoded
        it = getattr(resp, "iter_content", None)
        if it is not None:
            return _read_chunks(it(), max_size, response=resp)
        _close_response(resp)
        raise HttpError("Unexpected response format.")
    else:
        return _read_streamed(resp, max_size)


def _extract_location(resp) -> str | None:
    headers = getattr(resp, "headers", None) or {}
    if hasattr(headers, "get"):
        loc = headers.get("Location") or headers.get("location")
        if loc:
            return str(loc)
    # dict-style
    if isinstance(headers, dict):
        for k, v in headers.items():
            if str(k).lower() == "location":
                return str(v)
    return None


def _resolve_redirect(base_url: str, location: str) -> str:
    from urllib.parse import urljoin
    return urljoin(base_url, location)


def _read_streamed(response, max_size: int) -> bytes:
    def chunks():
        while True:
            chunk = response.read(65536)
            if not chunk:
                break
            yield chunk

    return _read_chunks(chunks(), max_size, response=response)


def _read_chunks(chunks_iter, max_size: int, *, response=None) -> bytes:
    chunks: list[bytes] = []
    total = 0
    try:
        for chunk in chunks_iter:
            if not isinstance(chunk, bytes):
                raise HttpError("Unexpected response format.")
            total += len(chunk)
            if total > max_size:
                raise HttpError("Download size exceeded.")
            chunks.append(chunk)
    finally:
        _close_response(response)
    return b"".join(chunks)


def _close_response(response) -> None:
    if response is not None and hasattr(response, "close"):
        response.close()
