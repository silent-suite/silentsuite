# Isolated HTTP authorization checks

The `authorization-http` job in `.github/workflows/ci-server.yml` builds
`Dockerfile.server` at the checked-out candidate SHA. It runs this harness in
that image with the real ASGI application and signed HTTP login. The harness
does not use authentication overrides, mocked routers or another client SDK.
It is invoked explicitly, outside pytest discovery.

The build downloads the pinned image and hash-locked dependencies. The test
container then runs without a network interface other than loopback, host ports,
capabilities or production credentials. Its root filesystem and harness mount
are read-only. Only `/data` and `/tmp` are writable tmpfs mounts. The job checks
Docker's effective configuration; the harness checks interfaces, routes,
privileges, mounts and a no-route result for a documentation-only address before
creating data. Socket audit hooks in both Python processes reject and record
external attempts, including attempts that application code catches.

The harness creates a random local secret, migrates a temporary SQLite database,
and seeds exactly two users with independent signing keys. Each user has a
private collection, a root item, two ordinary items and chunk content. It uses
the normal settings loader with `DEBUG=false`, admin disabled, a fixed loopback
host, Redis unset and in-memory email. HTTPS redirection is disabled only for
this loopback HTTP transport. Effective settings and registered routes are
checked before uvicorn starts.

Coverage:

- Both accounts log in through the challenge and signature routes. Successful
  collection, item-list and chunk reads prove the fixtures are present.
- B's collection lists exclude A. B gets 404 for A's collection, items,
  revisions, chunks and members. Batch/transaction updates contain a changed
  root, ordinary item and tombstone. Those writes, chunk uploads, membership
  changes and leave attempts also get 404.
- B cannot invite someone to A's collection (403), or accept a missing
  invitation (404). Incoming and outgoing invitation routes enforce recipient
  and sender ownership, including foreign iterator IDs.
- The same protected route families reject missing and invalid credentials
  with 401. Payloads have the expected protocol shape; 422 is never accepted
  as proof of authorization enforcement.
- Docs, OpenAPI, admin and the debug reset endpoint return 404 for anonymous
  and authenticated callers. Their registrations are also checked.
- Every denied mutation leaves all sync-model rows, user rows, stokens and
  media file paths/content unchanged. Authentication-token expiry renewal is
  outside that comparison. Error bodies are checked for private fixture bytes.
- The final positive control accepts an invitation addressed to B and proves
  B can then read the shared collection. No nonmember checks run after this
  grant; any added later negative phase must create a fresh isolated fixture.

The server is terminated in a `finally` block. The workflow's `always()` cleanup
removes the container and its tmpfs and verifies that it is gone. Output contains
check identifiers, counts and commit/image identity, without HTTP bodies,
tokens or private keys. An unexpected exception reports
`FAIL harness.unexpected-error`; it is a harness failure, not a passing or skipped
security check. Runtime is capped at 90 seconds, inside a 10-minute job.

Run the initial candidate privately before publishing the tests or enabling
public CI. Any suspected undisclosed authorization failure must remain private
pending investigation and publication approval. This job is synthetic CI only:
it does not contact a deployed server or prove PostgreSQL concurrency, hosted
entitlement hooks, billing integration, TLS or edge policy. It has no schedule.
