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


def test_radicale_filter_redacts_non_app_exception_and_traceback():
    private_identifier = "https://user:token@example.invalid/private/person"
    try:
        raise RuntimeError(private_identifier)
    except RuntimeError:
        record = logging.LogRecord(
            name="radicale",
            level=logging.WARNING,
            pathname="radicale/log.py",
            lineno=156,
            msg="An exception occurred: %s",
            args=(private_identifier,),
            exc_info=sys.exc_info(),
        )

    bridge_application._DavDiagnosticRedactionFilter().filter(record)

    assert record.getMessage() == "Radicale failure"
    assert private_identifier not in record.getMessage()
    assert record.args == ()
    assert record.exc_info is None
    assert record.exc_text is None


def test_radicale_server_startup_record_keeps_bounded_operational_meaning():
    for template, expected in (
        ("Starting Radicale", "Starting Radicale"),
        ("Radicale server ready", "Radicale server ready"),
        ("Stopping Radicale", "Stopping Radicale"),
        ("Listening on %r%s", "Radicale listener started"),
    ):
        record = logging.LogRecord(
            name="radicale",
            level=logging.INFO,
            pathname="radicale/server.py",
            lineno=277,
            msg=template,
            args=("private-listener", " with SSL") if "%" in template else (),
            exc_info=None,
        )

        bridge_application._DavDiagnosticRedactionFilter().filter(record)

        assert record.getMessage() == expected


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
        "silentsuite_bridge/radicale/storage.py",
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


def test_radicale_exception_diagnostic_has_explicit_identifier_length_bounds():
    private_fragment = "PrivatePerson" + "A" * 300
    exception_class = type(private_fragment, (RuntimeError,), {})
    namespace = {"exception_class": exception_class}
    long_function = "private_function_" + "b" * 300
    code = compile(
        f"def {long_function}():\n"
        "    raise exception_class('private-value')\n",
        "silentsuite_bridge/" + "private_path_" + "c" * 300 + ".py",
        "exec",
    )
    exec(code, namespace)

    try:
        namespace[long_function]()
    except RuntimeError:
        diagnostic = bridge_application._safe_exception_diagnostic(sys.exc_info())

    assert diagnostic == "Radicale server request failed (Exception)"
    assert private_fragment not in diagnostic
    assert len(diagnostic) < 80


def test_radicale_diagnostics_have_an_explicit_aggregate_output_bound():
    exception_class = type("E" * 64, (RuntimeError,), {})
    namespace = {"exception_class": exception_class}
    function = "f" * 64
    code = compile(
        f"def {function}():\n"
        "    raise exception_class('private-value')\n",
        "silentsuite_bridge/" + "p" * 157 + ".py",
        "exec",
    )
    exec(code, namespace)

    try:
        namespace[function]()
    except RuntimeError:
        exc_info = sys.exc_info()

    server_diagnostic = bridge_application._safe_exception_diagnostic(exc_info)
    put_diagnostic = bridge_application._safe_put_diagnostic(
        "Bad PUT request on %r (upload): %s",
        exc_info,
    )

    assert len(server_diagnostic) <= 320
    assert len(put_diagnostic) <= 320
