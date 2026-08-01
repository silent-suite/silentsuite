import logging

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
