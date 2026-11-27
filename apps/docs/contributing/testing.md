# Testing

How to run and write tests for SilentSuite.

## Test Framework

The monorepo uses [Vitest](https://vitest.dev/) as the test framework.

## Running Tests

Run all tests across the monorepo:

```bash
pnpm test
```

Run tests for a specific app or package:

```bash
pnpm --filter @silentsuite/web test
pnpm --filter @silentsuite/core test
```

## Type Checking

Run TypeScript type checking across all packages:

```bash
pnpm type-check
```

## Writing Tests

- Place test files next to the code they test, using the `.test.ts` or `.test.tsx` suffix.
- Write descriptive test names that explain the expected behaviour.
- Test behaviour, not implementation details.
- Keep tests independent -- each test should be able to run in isolation.

## Server Framework Upgrade Gate

PRs that touch any server request-routing or serialization dependency must run the FastAPI route contract gate, not only compile checks. This includes changes to:

- `server/requirements.in/base.txt`
- `server/requirements.txt`
- `server/requirements.in/development.txt`
- `server/requirements-dev.txt`
- FastAPI, Starlette, Pydantic, `httpx2`/test-client transport dependencies, msgpack, or server request/response middleware

From `server/`, run:

```bash
python -m pytest \
  etebase_server/fastapi/test_collection_route_contracts.py \
  etebase_server/fastapi/test_item_list_queryset.py \
  etebase_server/fastapi/test_authentication.py \
  etebase_server/fastapi/test_request_body_limits.py \
  -v --tb=short
```

These tests exercise real FastAPI router mounting, path-parameter binding, dependency injection, auth headers, request-size limits, and msgpack request/response handling. They guard against a framework change that breaks authenticated restore or sync routes while compile checks and helper tests stay green.

CI runs this focused gate (the "Run FastAPI route contract tests" step in `ci-server.yml`) before the full server test suite. `py_compile` only proves that modules compile; it is not a functional smoke test.

## Authenticated Restore Smoke

After changes that affect web login, encrypted-session restore, Etebase item listing, or SyncEngine startup, run the [authenticated restore smoke probe](https://github.com/silent-suite/silentsuite/blob/main/docs/contributing/authenticated-restore-smoke.md). It uses the app's redacted `silentsuite.restore-diagnostics.v1` payload and `scripts/restore-smoke-report.mjs` to tell deploy health apart from real authenticated restore health, without exposing plaintext calendar, contact or task data or credentials.

Passing CI, building a PR image, or checking an unauthenticated page only proves deploy health. Run the smoke after the change reaches a deployed preview environment. For production, use only an approved account that is already initialized: restore can create default collections on a first login or an empty account. Validate the report helper with `node scripts/restore-smoke-report.mjs --self-test`.

## Before Submitting a PR

Make sure all checks pass:

```bash
pnpm lint
pnpm type-check
pnpm test
pnpm build
```

For server dependency or request-routing changes, also run the FastAPI route contract gate above from `server/`.

CI will run these checks automatically on your pull request.
