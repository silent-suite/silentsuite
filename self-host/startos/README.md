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

`make` signs the package with the packaging key at `.startos/build.key.pem`. For a local
development build, set up a packaging workspace with `start-cli s9pk init-workspace` (see
Start9's [environment setup](https://docs.start9.com/packaging/environment-setup.html)), or
create a throwaway key the way CI does:

```sh
npm ci
start-cli init-key
mkdir -p .startos && cp ~/.startos/id.key.pem .startos/build.key.pem
make x86   # or: make arm, make
```

In the SilentSuite repository, `.github/workflows/ci-startos-candidate.yml` builds both
architectures for pull requests from branches of that repository (fork pull requests get
only the contract test), inspects the packed manifests and runs a Docker smoke test of the
same container wiring. Those packages are development builds signed with a throwaway key;
nothing is release-signed or published.

The package has not yet been tested on a StartOS server.

## License

AGPL-3.0-only, the same as SilentSuite.
