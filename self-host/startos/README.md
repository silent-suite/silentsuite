# SilentSuite for StartOS

StartOS package (start-sdk) for [SilentSuite](https://silentsuite.io), an end-to-end
encrypted calendar, contacts, tasks and notes service. It runs the published SilentSuite
images; it builds none of its own.

## What runs

| Subcontainer | Image | Role |
| --- | --- | --- |
| `postgres` | `postgres` (alpine) | Database, loopback only, password-checked TCP |
| `init` (oneshot) | SilentSuite server | Prepares `/data` ownership and the private server INI |
| `server` | `ghcr.io/silent-suite/silentsuite-server` | Etebase-compatible sync API on port 3735 |
| `web` | `ghcr.io/silent-suite/silentsuite-web-selfhost` | Web app on port 3000 |
| `router` | `nginxinc/nginx-unprivileged` | One origin on port 8080: `/api/` to the server, the rest to the web app |

Images are pinned by tag and multi-arch index digest in `startos/manifest/index.ts`
(x86_64 and aarch64).

## Security model

- Secrets are generated once per installation and stored in the `startos` volume, which no
  subcontainer mounts: the installation (owner) password, an independent signup signing
  secret and the database password. A restart, update or restore never regenerates them;
  missing or malformed secrets stop the service instead.
- Every signup needs a short-lived grant from the installation-owner login, so only people
  who have the installation password can create accounts. The Django admin is disabled in
  the server and blocked in the router.
- StartOS terminates TLS. The router redirects plaintext `GET`/`HEAD` requests to HTTPS and
  refuses every other plaintext request without proxying it.
- Native sync clients reach the API directly; there is no extra login wall in front of it.
- Request access logs are off in the router and the server.

## Volumes and backups

| Volume | Contents | Backed up |
| --- | --- | --- |
| `startos` | `store.json` with the per-install secrets | yes |
| `server` | Django secret, media, static files | yes |
| `config` | Server INI, rewritten on every start | no |
| `db` | PostgreSQL data | yes, as a `pg_dump` |

## Building

Needs Node 22+, Docker, `make`, `jq` and
[start-cli](https://docs.start9.com/packaging/environment-setup.html).

```sh
npm ci
make x86   # or: make arm, make
```

CI builds both architectures on every pull request that touches this directory
(`.github/workflows/ci-startos-candidate.yml` in the SilentSuite repository) and runs a
smoke test of the same container wiring with Docker.

## License

AGPL-3.0-only, the same as SilentSuite.
