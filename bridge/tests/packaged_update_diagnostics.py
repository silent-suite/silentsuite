# TEMPORARY packaged update-check diagnostic. Remove once the frozen
# --check-update catch-all is identified.
#
# PyInstaller runtime hook, bundled ONLY into a separate manual diagnostic build
# (SILENTSUITE_BRIDGE_DIAGNOSTIC_BUILD=1, see silentsuite-bridge.spec). It does
# nothing unless SILENTSUITE_PACKAGED_UPDATE_PROBE=1 at run time. When enabled,
# it runs the same steps as silentsuite_bridge.update.check_for_update one at a
# time inside the frozen runtime, prints ONE bounded JSON line, and exits
# before the Bridge starts:
#
#   PACKAGED_UPDATE_PROBE {"stage": ..., "outcome": ..., ...}
#
# Reported: stage name, exception class names, the innermost product frame
# (relative path:line in function), the innermost frame's module file basename,
# a missing-module name for ImportError, an HTTP status code, and product
# HttpError text only when it is one of the fixed product strings. Never
# reported: exception messages, URLs, addresses, certificates, paths,
# environment or credentials.


def _probe():
    import json
    import os
    import re
    import sys

    ident = re.compile(r"[A-Za-z_][A-Za-z0-9_.]{0,99}")
    basename = re.compile(r"[A-Za-z0-9_.-]{1,64}")
    rel_path = re.compile(r"[A-Za-z0-9_./-]{1,160}")
    func = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")
    fixed_messages = {
        "Refusing disallowed host.",
        "Too many redirects.",
        "Refusing non-HTTPS URL.",
        "Network error during download.",
        "Request failed.",
        "Download size exceeded.",
        "Unexpected response format.",
        "Update request timed out.",
        "GitHub Releases API returned invalid JSON.",
        "GitHub Releases API response is not a list.",
    }

    def safe_ident(value):
        value = value if isinstance(value, str) else ""
        return value if ident.fullmatch(value) else "unknown"

    def frames(exc):
        product = None
        innermost = None
        tb = exc.__traceback__
        while tb is not None:
            filename = str(tb.tb_frame.f_code.co_filename).replace("\\", "/")
            name = filename.rsplit("/", 1)[-1]
            innermost = name if basename.fullmatch(name) else "unknown"
            marker = "silentsuite_bridge/"
            if marker in filename:
                path = filename.rsplit(marker, 1)[1]
                function = tb.tb_frame.f_code.co_name
                if rel_path.fullmatch(path) and func.fullmatch(function):
                    product = f"{path}:{tb.tb_lineno} in {function}"
            tb = tb.tb_next
        return product, innermost

    def chain(exc):
        classes = []
        status = None
        current = exc.__cause__ or exc.__context__
        while current is not None and len(classes) < 3:
            classes.append(safe_ident(type(current).__name__))
            code = getattr(current, "code", None)
            if status is None and isinstance(code, int) and 100 <= code <= 599:
                status = code
            current = current.__cause__ or current.__context__
        return classes, status

    def describe(stage, exc):
        product, innermost = frames(exc)
        context, status = chain(exc)
        code = getattr(exc, "code", None)
        if isinstance(code, int) and 100 <= code <= 599:
            status = code
        message = str(exc) if str(exc) in fixed_messages else None
        missing = None
        if isinstance(exc, ImportError):
            missing = safe_ident(getattr(exc, "name", None) or "")
        return {
            "stage": stage,
            "outcome": "raised",
            "exception": safe_ident(type(exc).__name__),
            "product_frame": product,
            "innermost_module": innermost,
            "missing_module": missing,
            "context": context,
            "http_status": status,
            "product_message": message,
        }

    def emit(record):
        record["frozen"] = bool(getattr(sys, "frozen", False))
        sys.stdout.write("PACKAGED_UPDATE_PROBE " + json.dumps(record, sort_keys=True) + "\n")
        sys.stdout.flush()
        os._exit(0)

    stage = "import_update"
    try:
        import silentsuite_bridge.update as update
        from silentsuite_bridge.update.check import check_for_update as select

        stage = "platform"
        platform = update._detect_platform()
        stage = "version"
        version = update._current_version()
        stage = "http_adapter"
        http = update._default_http()
    except BaseException as exc:  # noqa: BLE001 - bounded diagnostic only
        emit(describe(stage, exc))

    try:
        releases = http.fetch_releases()
    except BaseException as exc:  # noqa: BLE001 - bounded diagnostic only
        emit(describe("fetch", exc))

    class _Fetched:
        def fetch_releases(self):
            return releases

    try:
        result = select(http=_Fetched(), platform=platform, current_version=version)
    except BaseException as exc:  # noqa: BLE001 - bounded diagnostic only
        emit(describe("select", exc))

    emit({
        "stage": "select",
        "outcome": "returned",
        "status": safe_ident(getattr(result.status, "name", "")),
        "release_count": len(releases) if isinstance(releases, list) else None,
        "platform": [safe_ident(platform.os_name), safe_ident(platform.arch)],
    })


def _enabled():
    import os
    return os.environ.get("SILENTSUITE_PACKAGED_UPDATE_PROBE") == "1"


if _enabled():
    _probe()
