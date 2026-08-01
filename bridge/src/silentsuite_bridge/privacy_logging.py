"""Privacy-safe helpers for bounded Bridge diagnostics."""


def log_bounded_failure(logger, level, message, error):
    """Log a source-owned event and exception class without values or traceback."""
    logger.log(level, "%s (%s)", message, error.__class__.__name__)
