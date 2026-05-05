# Updating

How to keep your self-hosted SilentSuite instance up to date.

## How Versions Are Pinned

The `docker-compose.yml` shipped with each SilentSuite release pins the server image to a specific manifest digest, e.g.:

```yaml
image: ghcr.io/silent-suite/silentsuite-server@sha256:6689b5d8...
```

This means a plain `docker compose pull` **will not** fetch a newer SilentSuite version — it only re-pulls the same digest. To upgrade across SilentSuite releases you must fetch a newer compose file.

## Upgrade to a New SilentSuite Release

Re-running the installer pulls the latest umbrella release's `docker-compose.yml` (and helper scripts) and recreates the containers:

```bash
curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/install.sh | bash
```

To pin to a specific release instead:

```bash
curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/install.sh | SILENTSUITE_VERSION=v0.1.0-beta bash
```

The whole self-host config (compose, `update.sh`, `verify.sh`, `success.html`, `close-signups.sh`) is fetched from the requested tag's archive, so the entire matrix moves together as one release.

## Within a Pinned Release

`./update.sh` re-pulls the pinned images and recreates the containers. This is useful after host-level changes (Docker upgrade, kernel reboot, etc.) but does **not** change SilentSuite versions:

```bash
./update.sh
```

## Verify

After any update:

```bash
./verify.sh
docker compose ps
```

All services should report `healthy`.
