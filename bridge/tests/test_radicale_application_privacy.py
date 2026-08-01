import logging
import sys

from silentsuite_bridge.radicale import application as bridge_application


def test_radicale_filter_redacts_packaged_relative_app_diagnostics():
    private_identifier = "private-account@example.invalid"
    record = logging.LogRecord(
        name="radicale",
        level=logging.INFO,
        pathname="radicale/app/__init__.py",
        lineno=254,
        msg="Successful login: %r",
        args=(private_identifier,),
        exc_info=None,
    )

    bridge_application._DavDiagnosticRedactionFilter().filter(record)

    assert record.msg == "Radicale diagnostic suppressed"
    assert record.args == ()
    assert private_identifier not in record.getMessage()


def test_radicale_server_failure_retains_only_bounded_product_origin():
    private_value = "private-calendar-item@example.invalid"
    namespace = {}
    code = compile(
        "def product_failure():\n"
        f"    raise RuntimeError({private_value!r})\n",
        "/tmp/build/silentsuite_bridge/radicale/storage.py",
        "exec",
    )
    exec(code, namespace)

    try:
        namespace["product_failure"]()
    except RuntimeError as error:
        record = logging.LogRecord(
            name="radicale",
            level=logging.ERROR,
            pathname="radicale/server.py",
            lineno=177,
            msg="An exception occurred during request: %s",
            args=(error,),
            exc_info=sys.exc_info(),
        )

    bridge_application._DavDiagnosticRedactionFilter().filter(record)

    message = record.getMessage()
    assert "RuntimeError" in message
    assert "radicale/storage.py" in message
    assert "product_failure" in message
    assert private_value not in message
    assert record.exc_info is None


def test_radicale_bad_put_retains_only_bounded_stage_and_product_origin():
    private_value = "private-event-body-and-href@example.invalid"
    namespace = {}
    code = compile(
        "def upload():\n"
        f"    raise ValueError({private_value!r})\n",
        "/tmp/build/silentsuite_bridge/radicale/storage.py",
        "exec",
    )
    exec(code, namespace)

    try:
        namespace["upload"]()
    except ValueError as error:
        record = logging.LogRecord(
            name="radicale",
            level=logging.WARNING,
            pathname="radicale/app/put.py",
            lineno=246,
            msg="Bad PUT request on %r (upload): %s",
            args=(f"/{private_value}/", error),
            exc_info=sys.exc_info(),
        )

    bridge_application._DavDiagnosticRedactionFilter().filter(record)

    message = record.getMessage()
    assert message.startswith("Radicale PUT rejected during upload")
    assert "ValueError" in message
    assert "radicale/storage.py" in message
    assert "upload" in message
    assert private_value not in message
    assert record.exc_info is None
