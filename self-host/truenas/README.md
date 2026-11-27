# SilentSuite for TrueNAS SCALE

`silentsuite/` is a TrueNAS community-train app, laid out exactly as it goes into
[truenas/apps](https://github.com/truenas/apps) at `ix-dev/community/silentsuite/`. It is not
listed in the TrueNAS catalog yet.

## What it runs

- `router` (nginx): the only published port. It serves the web app and the sync API on one
  origin, with HTTPS from a TrueNAS certificate, or plain HTTP behind your own HTTPS reverse
  proxy. It keeps request paths out of its logs, never routes `/admin/`, and rate-limits the
  installation-owner login.
- `server`: the published `silentsuite-server` image, run as the TrueNAS `apps` user (568) and
  started by `templates/macros/server-start.sh`.
  The wrapper writes the server configuration to a private tmpfs on every start, creates the
  registration signing key once in the data storage, and refuses to start on a data directory it
  cannot write or on secret files that are links or owned by someone else.
- `web`: the published `silentsuite-web-selfhost` image (installation-password sign-up).
- `postgres`: PostgreSQL 16 through the TrueNAS library, which also adds its permissions and
  upgrade helpers.

The installation password and the database password come from the install form. The database
password cannot be changed after install. Accounts can only be created over HTTPS, so the form
needs either a certificate or the reverse-proxy option.

## Checks

`.github/workflows/ci-truenas-candidate.yml` runs on pull requests that touch this directory. It
checks out a pinned `truenas/apps` commit, runs TrueNAS's own `ci.py` on the test values in
`silentsuite/templates/test_values/`, compares the committed metadata with what TrueNAS's
generators produce, and validates the port. Then `scripts/truenas-candidate-smoke.sh` and
`scripts/truenas-candidate-probe.py` start rendered stacks with per-run secrets. They check signup
and a signed login over verified HTTPS, refusal of plain-HTTP LAN origins, the owner-login
throttle, log privacy, key and media survival across recreation and restore, and the host-path
rules. `tests/test_self_host_truenas_package.py` pins the static facts those checks rely on.
Neither has been run on a real TrueNAS host.

## Releases

The server and web images must be the same release tag, pinned by digest; the template refuses
to render a mixed pair. Once the app is in the catalog, TrueNAS's Renovate bot updates the store
copy. It needs a versioning rule for our `vX.Y.Z-beta` tags, which is part of the store PR. Keep
this copy in step when a release changes what the package needs.

## Submitting

Store submission is a write outside our repositories. The owner approves the exact issue and PR
text first.
