# SilentSuite Self-Hosting Guide

Run your own SilentSuite sync server. Your data stays on your hardware, fully end-to-end encrypted.

## How It Works

You run the SilentSuite sync server and a PostgreSQL database (2 containers). Your users connect via [app.silentsuite.io](https://app.silentsuite.io) or the SilentSuite mobile apps, pointing at your server URL in Advanced Settings.

You provide your own reverse proxy (Caddy, nginx, Traefik, Cloudflare Tunnel) to handle TLS and forward traffic to the SilentSuite server on port 3735.

```
    Your Server                         SilentSuite Apps
  ┌─────────────────┐
  │  Your Reverse   │◄──────────── app.silentsuite.io
  │  Proxy (HTTPS)  │              (or mobile apps)
  └────────┬────────┘              enter your server URL
           │                       in Advanced Settings
  ┌────────┴────────┐
  │   SilentSuite   │
  │     Server      │
  │      :3735      │
  └────────┬────────┘
           │
  ┌────────┴────────┐
  │  PostgreSQL 16  │
  │    (internal)   │
  └─────────────────┘
```

| Service | Image | Role |
|---------|-------|------|
| **SilentSuite Server** | `ghcr.io/silent-suite/silentsuite-server`, pinned to the immutable OCI index digest of the release you installed | Sync server (Etebase protocol). All data is E2E encrypted. |
| **PostgreSQL** | `postgres`, pinned to the immutable OCI index digest of 16.9-alpine | Database for encrypted sync data and user accounts. |

## Prerequisites

- A Linux server (Ubuntu 22.04+, Debian 12+, or similar)
- Docker Engine 24+ with Compose v2
- A reverse proxy for TLS termination
- A domain name (e.g., `sync.example.com`) with DNS pointing to your server
- `curl`, `tar`, and `sha256sum` (or `shasum`) for the installer's download verification

### Supported architectures

Server images are published for `linux/amd64` and `linux/arm64`. The installer
detects your architecture and refuses to continue on anything else rather than
installing an image that cannot run.

`linux/arm64` support is verified in the release pipeline on native ARM64
runners. Acceptance on specific ARM64 single-board hardware, such as a Raspberry
Pi, has not been completed yet — treat it as untested until that evidence is
published.

## How Releases Are Pinned

Every SilentSuite release publishes three self-host assets:

| Asset | Purpose |
|-------|---------|
| `silentsuite-self-host-<tag>.tar.gz` | the version-matched `docker-compose.yml`, helper scripts, and landing page; `--stage-only` keeps this archive and its sidecar beside the files it extracted |
| `silentsuite-self-host-<tag>.tar.gz.sha256` | the bundle's checksum, as a single strict record |
| `server-image.json` | the immutable image identity: release tag, source commit, OCI index digest, per-architecture digests, supported platforms, and the expected image revision label |

The installer requires the release it selects to be published (never a draft),
tagged exactly what you asked for, and in possession of all three assets.

**What the checksum proves, and what it does not.** It detects corruption in
transit and any inconsistency between the bundle, its sidecar, and the manifest
*as they are published right now*. It is not evidence that an asset was never
replaced: the checksum lives on the same release as the bundle, so a repository
administrator can replace both together. GitHub's immutable-releases feature,
which would close that gap, is not in use yet — see
[issue #682](https://github.com/silent-suite/silentsuite/issues/682).

**Who verifies what about the image.** The two checks are different, and neither
is the other:

| Stage | What it verifies |
|-------|------------------|
| Release workflow (CI) | the complete published OCI index: both platform children by digest, their sizes and media types, the closed two-platform set, and the build revision on each — before the bundle is ever built |
| `install.sh` (your machine) | the image it actually pulls: that its repo digest is the index digest the manifest names, that its platform is your host's, and that its build revision matches; then the same digest and platform check for the pinned PostgreSQL image |
| `install.sh --stage-only` | release metadata, tag-to-commit binding, checksum, manifest and archive only. It pulls nothing and contacts no registry. |

So the installer confirms that what will run on *your* host is the reviewed
image, for your architecture, built from the named commit. It does not re-derive
the whole index — a single host can only pull one platform, and reproducing the
full index check would need registry credentials the installer has no business
holding. The closed two-platform verification is CI's job, and its result is
what the manifest records.

`docker-compose.yml` contains no *server* image digest. It reads
`SILENTSUITE_SERVER_IMAGE` from `.env`, which the installer writes as
`ghcr.io/silent-suite/silentsuite-server@sha256:<index digest>` only after every
check above has passed. A mutable `:version` tag is used to *find* a release,
never to decide what runs.

PostgreSQL is different: it is fixed source data rather than release data, so its
immutable index digest is written directly in the bundled `docker-compose.yml`
and travels inside the checksummed bundle. Neither container is ever started
from a mutable tag, and the installer refuses a bundle whose Compose file
unpins the database.

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/install.sh | bash
```

The installer will:
1. Check that Docker, Docker Compose, and the download-verification tools are installed
2. Refuse to continue if `silentsuite-server/` exists at all — as a directory, an empty directory, a file, or a symlink — and require its parent to be a directory you own that other local users cannot write
3. Detect your architecture and resolve the newest published release that ships verified self-host assets
4. Require that release to be published rather than a draft, and to carry exactly the tag that was requested
5. Download the release bundle, its checksum, and `server-image.json` into a private temporary directory
6. Verify the checksum record's exact grammar and the bundle's exact bytes before anything is extracted
7. Verify the manifest: schema, release tag, source commit, canonical image repository, index and per-architecture digests, supported platforms, and expected image revision
8. Confirm with GitHub that the release tag really points at the commit the manifest names
9. Reject the archive unless every entry is a regular file or directory inside the bundle root and the file set is exactly the published inventory — nothing missing, nothing extra — then extract to a temporary staging directory
10. Confirm the manifest inside the bundle is byte-identical to the separately published one
11. Pull the image by digest and confirm the pulled image's repo digest, build revision, and architecture are the ones the manifest names — then do the same for the pinned PostgreSQL digest and platform
12. Create `silentsuite-server/` with a single atomic `mkdir` — the first write outside its temporary workspace — then install the verified files, ask for your domain, generate secure random passwords, and write `.env` including the verified image digest
13. Start the containers and wait for health checks to pass

Every check above runs before that `mkdir`. If any of them fails, the target is
never created, nothing outside the installer's temporary workspace is written,
and those temporary files are removed. If the directory has already been claimed
and a later step fails — an empty domain answer, a container that will not start
— the new directory is left in place with whatever it contains at that point;
remove it yourself before retrying. It is always a directory the installer just
created, never a pre-existing one.

If the path you give runs through a symlink, the installer resolves it once
while checking the parent and then uses only the resolved location, so
re-pointing that symlink later cannot redirect the install.

The first user to sign up in the SilentSuite app becomes the server admin.

Then set up your reverse proxy to forward HTTPS traffic to `localhost:3735`.

### Installing a specific version

To pin to a specific SilentSuite release rather than the latest:

```bash
# Curl-pipe style (env var):
curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/install.sh | SILENTSUITE_VERSION=v0.1.0-beta bash

# Locally cloned style (CLI flag):
bash install.sh --version v0.1.0-beta
```

The requested release must be published and must ship the self-host assets;
otherwise the installer stops. There is no branch fallback: a branch has no
verified server image, so it is not an installable source.

### Inspecting a release before installing it

```bash
bash install.sh --version v0.1.0-beta --stage-only ./silentsuite-release
```

This performs the release-metadata, tag-to-commit, checksum, manifest and
archive checks — steps 3 through 10 above — and writes the verified bundle
contents into `./silentsuite-release`, along with the original archive, its
strict checksum sidecar, and the published manifest. It stops there: it does
**not** pull an image, does not contact the registry, does not create an
installation, and does not start a container. The live image-identity check in
step 11 is part of installing, not of staging. The stage directory has a closed
top-level inventory: the archive, sidecar, manifest, and the archive's verified
managed files.

The stage directory must not exist yet, and its parent must be a directory you
own that other local users cannot write. Like an install, it is created by a
single atomic `mkdir` only after every check it performs has passed.

## Manual Setup

> `install.sh --version vX.Y.Z --stage-only ./staged` performs the release-tag,
> manifest, bundle, checksum, and archive checks, but not the live registry
> image-identity check — that happens only during a real install. It writes the
> verified files out without installing or starting anything.
> Prefer it unless you specifically want to do this by hand; step 4 below is the
> image check you would otherwise be skipping.

1. **Download and verify the release bundle** (replace `vX.Y.Z` with the release
   you want, from [the releases page](https://github.com/silent-suite/silentsuite/releases)):
   ```bash
   BASE=https://github.com/silent-suite/silentsuite/releases/download/vX.Y.Z
   curl -fLO "$BASE/silentsuite-self-host-vX.Y.Z.tar.gz"
   curl -fLO "$BASE/silentsuite-self-host-vX.Y.Z.tar.gz.sha256"
   curl -fLO "$BASE/server-image.json"

   # The sidecar must be exactly one record naming exactly this archive.
   cat silentsuite-self-host-vX.Y.Z.tar.gz.sha256
   sha256sum -c silentsuite-self-host-vX.Y.Z.tar.gz.sha256

   tar -tzf silentsuite-self-host-vX.Y.Z.tar.gz      # review before extracting
   tar -xzf silentsuite-self-host-vX.Y.Z.tar.gz
   ```

   Do not skip the checksum step: it is what catches a bundle altered in
   transit, or one that does not match the sidecar published beside it. It
   cannot tell you the release was never rewritten — both files live on the same
   release. The registry check in step 4 is the part that binds what you install
   to an image identity nobody can substitute.

2. **Bind the manifest to the bundle you verified.** The checksum covers the
   archive only, so the separately downloaded `server-image.json` proves nothing
   until you show it is the same file that is *inside* the verified archive:
   ```bash
   cmp server-image.json silentsuite-self-host-vX.Y.Z/server-image.json
   ```
   Any difference means the manifest is not the one this bundle was built with —
   stop there. From this point on, use the copy inside the extracted bundle.

3. **Install the verified files:**
   ```bash
   mkdir silentsuite-server && chmod 750 silentsuite-server
   cp -R silentsuite-self-host-vX.Y.Z/. silentsuite-server/
   cd silentsuite-server
   cp .env.example .env
   ```

4. **Pin the server image.** Read `indexDigest` out of the bundled
   `server-image.json` and put it in `.env`:
   ```bash
   SILENTSUITE_SERVER_IMAGE=ghcr.io/silent-suite/silentsuite-server@sha256:<indexDigest>
   ```
   Compose has no default for this value and will refuse to start without it.
   Then confirm the registry really serves that image, for your architecture,
   built from the commit the manifest claims:
   ```bash
   docker pull "$SILENTSUITE_SERVER_IMAGE"
   docker image inspect "$SILENTSUITE_SERVER_IMAGE" \
     --format '{{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
   ```
   The architecture must match your host and the revision must equal the
   manifest's `expectedRevision`. The installer additionally asks GitHub to
   confirm the release tag points at `sourceCommit`; by hand, check the tag on
   the releases page.

5. **Generate passwords:**
   ```bash
   openssl rand -base64 32 | tr -d '/+='   # use for DATABASE_PASSWORD
   openssl rand -base64 16 | tr -d '/+='   # use for SUPER_PASS
   ```

6. **Edit `.env`:**
   - `DATABASE_PASSWORD` -- the generated database password
   - `SUPER_PASS` -- the generated admin password
   - Save with `chmod 600 .env` so only the host operator can read it.

7. **Create `etebase-server.ini`** (server-side configuration; mounted into the container). Replace `YOUR_DATABASE_PASSWORD` with the value you set in `.env`, and `sync.example.com` with your domain:
   ```ini
   [global]
   secret_file = /data/secret.txt
   debug = false
   media_root = /data/media
   static_root = /data/static

   [allowed_hosts]
   allowed_host1 = sync.example.com
   allowed_host2 = localhost

   [database]
   engine = django.db.backends.postgresql
   name = silentsuite
   user = silentsuite
   password = YOUR_DATABASE_PASSWORD
   host = postgres
   port = 5432
   ```
   Save with `chmod 644` so the container's `etebase` user can read it via the bind mount. Keep the install directory itself at `0750`; `etebase-server.ini` contains the database password and should not live in a shared directory. Users outside the directory owner/group cannot traverse a `0750` directory, but members of that group can still read the file.

8. **Start the stack:**
   ```bash
   docker compose up -d
   ```

9. **Set up your reverse proxy** (see examples below).

## Reverse Proxy Examples

Docker publishes the SilentSuite server on host loopback at `127.0.0.1:3735` by default. Configure your reverse proxy to forward HTTPS traffic to it.

### Caddy (recommended -- automatic HTTPS)

```
sync.example.com {
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
    }
    reverse_proxy localhost:3735
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    server_name sync.example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    location / {
        proxy_pass http://127.0.0.1:3735;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 50m;
    }
}
```

### Trusted Proxy Headers

The server only accepts `X-Forwarded-*` headers from `TRUSTED_PROXY_IPS`.
Keep the default `127.0.0.1` when Caddy/nginx/cloudflared connects through the
host loopback port. If a Docker-network proxy connects directly to the server
container, set `TRUSTED_PROXY_IPS` in `.env` to that proxy's exact container IP
before recreating the server. Multiple values are comma-separated, for example
`TRUSTED_PROXY_IPS=127.0.0.1,172.18.0.5`. Uvicorn matches exact IPs here; CIDR
ranges are not supported.

### Traefik (Docker labels)

```yaml
# Add these labels to the server service in docker-compose.yml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.silentsuite.rule=Host(`sync.example.com`)"
  - "traefik.http.routers.silentsuite.tls.certresolver=letsencrypt"
  - "traefik.http.services.silentsuite.loadbalancer.server.port=3735"
```

> If Traefik runs in Docker, replace the `ports:` mapping with `expose: ["3735"]` and ensure Traefik shares the `silentsuite` Docker network. Also set `TRUSTED_PROXY_IPS` in `.env` to the Traefik container's exact IP so only that proxy can set `X-Forwarded-*` headers.

### Cloudflare Tunnel

```bash
cloudflared tunnel --url http://localhost:3735
```

### Recommended Security Headers

Add these in your reverse proxy for defense in depth if your proxy example does
not already include them:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

## Connecting Your Apps

Once your server is running and your reverse proxy is configured:

1. Open [app.silentsuite.io](https://app.silentsuite.io) in a browser for the first signup
2. On the signup page, expand **Advanced Settings**
3. Enter the one-time first-admin URL printed by the installer as the server URL:
   `https://sync.example.com/?bootstrap_token=YOUR_TOKEN`
4. Create your account and start syncing
5. **Run `./close-signups.sh`** from your install directory — see below.

## Closing Open Signups

The server ships with `ETEBASE_DISABLE_SIGNUP=false` so your first account can be created from the SilentSuite app. The installer also generates `ETEBASE_BOOTSTRAP_ADMIN_TOKEN` in `.env`; while the server has zero users, the first signup must include that token in the server URL query string:

```text
https://sync.example.com/?bootstrap_token=YOUR_TOKEN
```

This keeps a random visitor from racing you for the first account if they discover the server URL during setup. Once any user exists, the token is no longer required; you should still close signups immediately after creating your admin account. After that first browser signup, you can connect the mobile app with the normal server URL (`https://sync.example.com`).

If you configure self-hosting manually instead of using `install.sh`, generate and set a strong `ETEBASE_BOOTSTRAP_ADMIN_TOKEN` yourself before first boot. Leaving it empty preserves the old open-first-signup behavior for compatibility and does **not** protect the first account from a public first-signup race.

Because the bootstrap token is passed in the server URL, it may appear in local browser history, terminal scrollback, or reverse-proxy access logs. Complete the first signup promptly; after the first app account exists, the token is ignored. If you suspect it was exposed before signup, rotate `ETEBASE_BOOTSTRAP_ADMIN_TOKEN` in `.env`, clear any leaked URL from logs/history where practical, and recreate the server container before trying again.

Once your admin account is registered, close signups:

```bash
cd silentsuite-server
./close-signups.sh
```

The script flips `ETEBASE_DISABLE_SIGNUP=true` in `.env` and recreates the server container. New registrations are blocked at the API layer thereafter. To re-open (e.g. to add another user), edit `.env`, set `ETEBASE_DISABLE_SIGNUP=false`, and run `docker compose up -d --force-recreate server`.

## Restarting the version you have

`./update.sh` re-pulls the images already pinned in `.env` and recreates the
containers. It is useful after host-level changes. It does **not** move between
SilentSuite versions — the digest in `.env` is immutable by design.

```bash
./update.sh
```

## Upgrading to a new version

**Cross-version upgrading is not supplied yet.** This release ships the
installer, the immutable release image identity, and the version-matched
bundle; a version-aware updater that moves an existing installation from one
release to the next is deliberately deferred to a follow-up change.

Re-running `install.sh` is **not** the upgrade path. It refuses to touch an
existing installation, because regenerating credentials and restarting a stack
without backing up its data is not a safe upgrade — and nothing in this release
migrates an installed version for you.

`./update.sh` restarts the version you already have (above); it does not change
versions. Until a supported updater ships, do not attempt a cross-version move
by hand on an installation whose data you care about.

You can still inspect a newer release safely without touching your
installation, because staging only writes into a new directory:

```bash
bash ./install.sh --version vX.Y.Z --stage-only "./silentsuite-vX.Y.Z"
```

Stage-only verifies the release tag, manifest, checksum sidecar, and archive
contents. It does not verify the live registry image, install anything, or
start a container, and it writes only into a directory that did not exist
before you ran it.

## Health Checks

```bash
./verify.sh
```

## Admin Panel

The advanced Django admin panel is disabled by default in self-host installs (`ETEBASE_DISABLE_DJANGO_ADMIN=true`) because normal operators do not need it exposed on the public sync domain. If you need it for recovery or advanced maintenance, set `ETEBASE_DISABLE_DJANGO_ADMIN=false` in `.env`, recreate the server container, and protect `/admin/` with your reverse proxy or Cloudflare Access before exposing it.

## Backup and Recovery

### Never type a volume name from documentation

Docker creates a named volume silently when it does not exist, so
`docker run -v some_name:/data ... tar czf ...` succeeds against a brand-new
empty volume whenever `some_name` is not the one your server is really using —
and produces an empty archive that looks like a backup. Compose derives the
physical volume name from the project name, which depends on your directory,
`COMPOSE_PROJECT_NAME`, or a `name:` key, so no document can know it.

`./backup.sh` reads the volume out of the live container that is mounting it.

### Inspect

```bash
./backup.sh inspect
```

Read-only. Prints the Compose project, both containers, the server image ID, and
the physical volume mounted at `/data` and `/var/lib/postgresql/data`.

### Back up

```bash
./backup.sh backup ~/silentsuite-backups/$(date +%Y%m%d-%H%M%S)
```

The destination must not exist. Work happens in a private `.partial` sibling
that is removed on any failure and renamed into place only after every check
passes, so a failed run never leaves something that looks like a backup.

Admission requires exactly one `server` and one `postgres` container, exactly one
mount at each expected target, two distinct named volumes carrying this
project's Compose labels, the default `local` driver with local scope and no
driver options. Bind mounts, anonymous, shared or redirected volumes, custom
drivers and ambiguous identities are refused. The run then takes a real
`pg_dump` using the database container's own credentials (never printed), proves
`django_migrations` has rows, archives the server-data volume read-only using the
exact image ID the server container is already running, proves the archive holds
a real file and contains the configured `secret_file` when that path is under
`/data`, copies `.env`, `etebase-server.ini`, `docker-compose.yml` (plus
`docker-compose.override.yml` and `server-image.json` when present) with private
permissions, and writes `backup-metadata.txt` and a `SHA256SUMS` manifest. The
container, volume and image identities are re-checked after collection.

A `secret_file` outside `/data` is operator-managed; the helper does not read
host paths and you must back it up yourself.

The backup directory always contains your `.env`; it contains the server secret
key when `secret_file` is under `/data`. Keep it private and encrypted at rest.

```bash
./backup.sh verify ~/silentsuite-backups/20260101-020000
```

This enforces the manifest grammar and exact file inventory, validates the
backup's metadata and secret scope, and checks that every file still matches
`SHA256SUMS`. It catches corruption or edits while the manifest is unchanged,
plus changes made during one verification run. Because `SHA256SUMS` is stored
beside the backup and is not independently authenticated, verification does not
prove who created the backup and cannot detect a deliberate edit accompanied by
a correctly recomputed manifest.

### Recovery

**Automated restore is not supported yet.** There is no restore command, no
automated volume deletion, and no automated reset. If you need to recover:
preserve whatever data still exists and every backup you hold, verify a backup
with `./backup.sh verify`, and use PostgreSQL- and storage-specific recovery
procedures with expert assistance against the dump and archive inside it.

To stop the stack without deleting data:

```bash
docker compose down
```

Both volumes persist; `docker compose up -d` resumes where you left off.

Starting an older server image does **not** reverse Django migrations already
applied to your database. A full rollback generally requires a logical dump
taken *before* the migration ran — take one with `./backup.sh backup` before any
version move.

## Troubleshooting

### Containers won't start
```bash
docker compose logs server
docker compose logs postgres
```

### Server returns 400 Bad Request
Your domain is not in `etebase-server.ini`'s `[allowed_hosts]` section. Edit the file (under `[allowed_hosts]`, add `allowed_hostN = your.domain`) and recreate:
```bash
docker compose up -d --force-recreate server
```

### Database connection errors
- Verify PostgreSQL is healthy: `docker compose ps`
- Check that `DATABASE_PASSWORD` in `.env` matches the original value (after first run, change the password inside PostgreSQL; recreating the database volume would destroy every account and sync row)

### Server won't start: SILENTSUITE_SERVER_IMAGE is not set
Compose refuses to start without a verified image digest. Copy `indexDigest`
from `server-image.json` in your install directory into `.env` as
`SILENTSUITE_SERVER_IMAGE=ghcr.io/silent-suite/silentsuite-server@sha256:...`,
or re-install into a fresh directory from a published release.

### Stopping the stack
```bash
docker compose down
```
This removes the containers and leaves both data volumes intact. There is no
supported reset command: automated volume deletion is not supported, and
re-running `install.sh` is not an upgrade or reset path — it refuses to touch an
existing installation. Take and verify a backup before any maintenance you are
unsure about.

## Security Notes

- PostgreSQL is only accessible within the Docker network (not exposed to the host)
- Docker publishes the server port on host loopback only: `127.0.0.1:${SERVER_PORT:-3735}:3735`. Do not change this to `0.0.0.0` unless you put the server behind your own network firewall or proxy controls.
- All sync traffic is end-to-end encrypted. The server never sees your plaintext data.
- The server image is selected by an immutable digest, never by a mutable tag, so the bytes you verified at install time are the bytes that keep running.
- Built on the [Etebase protocol](https://docs.etebase.com), an open standard for E2E encrypted data sync.

## Full Documentation

For more details, see [docs.silentsuite.io/self-hosting](https://docs.silentsuite.io/self-hosting/).
