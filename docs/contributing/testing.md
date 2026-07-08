# Testing

How to run and write tests for SilentSuite.

## Running Tests

Run all tests across the monorepo:

```bash
pnpm test
```

Run tests for a specific app or package:

```bash
pnpm test --filter=landing
pnpm test --filter=web
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

## Server framework upgrade gate

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
  -v --tb=short
```

These tests exercise real FastAPI router mounting, path-parameter binding, dependency injection, auth headers, and msgpack request/response handling. They are the upgrade gate for the incident class where compile checks and helper tests stayed green while a framework change broke authenticated restore/sync routes.

CI runs this focused gate before the full server test suite. Keep CI step names precise: `py_compile` proves modules compile; it is not a functional smoke test.

## Authenticated restore smoke

After changes that affect web login, encrypted-session restore, Etebase item listing, or SyncEngine startup, run the [authenticated restore smoke probe](./authenticated-restore-smoke.md). It uses the app's redacted `silentsuite.restore-diagnostics.v1` payload and `scripts/restore-smoke-report.mjs` to distinguish CI/deploy health from real authenticated restore health without exposing plaintext PIM or credentials.

Passing CI, building a PR image, or checking an unauthenticated page only proves deploy health. The authenticated restore smoke must run after the change reaches a deployed preview/dev environment. For production smoke, use only an approved already-initialized account; first-login or empty production accounts are not mutation-free because restore can create default collections.

Validate the report helper with:

```bash
node scripts/restore-smoke-report.mjs --self-test
```

For timing instrumentation changes, collect optional console timing only with explicit opt-in (`?syncTiming=1` or `localStorage.setItem('silentsuite:syncTiming', 'true')` before reload). Preview and production must not emit timing automatically. Share only `[silentsuite-sync-timing]` lines after confirming they contain no credentials, cookies, session blobs, item IDs, collection IDs, stokens, raw errors, plaintext PIM, or full private URLs.

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
