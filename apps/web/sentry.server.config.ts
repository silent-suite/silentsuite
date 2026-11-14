/*
 * Server and edge error reporting is deferred: only browser errors are
 * reported (see sentry.client.config.ts). This file stays an explicit no-op so
 * nothing initialises the SDK in the server runtime.
 */
export {}
