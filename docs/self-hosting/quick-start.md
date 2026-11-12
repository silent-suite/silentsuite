# Quick Start

This is the fastest path from zero to running. Make sure you've met the [requirements](./requirements.md) first.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/install.sh | bash
```

To inspect a release before installing it, stage it first. Staging verifies the
release tag, the bundle checksum, the manifest, and the archive contents, then
writes the files out without installing, pulling an image, or starting a
container:

```bash
bash install.sh --version vX.Y.Z --stage-only ./silentsuite-vX.Y.Z
```

Staging deliberately stops before the registry image-identity check, because
that check pulls the image. A real install performs it; staging reports the
digest the manifest names, not one it confirmed.

The `install.sh` script will:

1. Check that Docker, Docker Compose, and the download-verification tools are installed.
2. Resolve the newest published release that ships verified self-host assets, or the one you named with `--version`. There is no branch fallback — a branch has no verified server image, so it is not an installable source.
3. Download the release bundle, its checksum, and `server-image.json`, then verify the checksum, the manifest, and the archive contents before extracting anything.
4. Confirm with GitHub that the release tag points at the commit the manifest names, and confirm the registry serves the promised image digest, revision, and architecture.
5. Prompt you for your domain name.
6. Generate strong random passwords for PostgreSQL and the admin panel.
7. Write the completed `.env`, including the verified server image digest.
8. Pull the pinned images, start the two containers (PostgreSQL and the SilentSuite server), and wait for health checks to pass.

Docker publishes the server on host loopback at `127.0.0.1:3735`. It is **not** reachable from the network until you put a reverse proxy in front of it.

## Set Up a Reverse Proxy

Pick whatever you already run. Examples (Caddy, nginx, Traefik, Cloudflare Tunnel) are in [SELF-HOSTING.md → Reverse Proxy Examples](https://github.com/silent-suite/silentsuite/blob/main/self-host/SELF-HOSTING.md#reverse-proxy-examples). Forward HTTPS traffic for your domain to `localhost:3735`.

Use the full examples in `SELF-HOSTING.md` when copy-pasting proxy config; they include security headers and `TRUSTED_PROXY_IPS` guidance for Docker-network proxies.

## Connect Your Apps

Once the proxy is up:

1. Open [app.silentsuite.io](https://app.silentsuite.io) or the SilentSuite mobile app.
2. On the signup or login page, expand **Advanced Settings**.
3. Enter `https://your-domain.com` as the server URL.
4. Create your first account and start syncing. It is a normal app account, not a server administrator.

## Close Signups

The server ships with `ETEBASE_DISABLE_SIGNUP=false` so you can register the first account from the app. **Close signups as soon as that account exists** — anyone who reaches your server URL during the open window can grab an account:

```bash
cd silentsuite-server
./close-signups.sh
```

## Verify

To verify everything is running:

```bash
./verify.sh
```

All services should show `Up` with a health status of `healthy`.

## Next Steps

- [Configuration](./configuration.md) -- understand and customise your environment variables.
- [Admin Dashboard](./admin-dashboard.md) -- manage your instance via the Django admin panel.
- [Updating](./updating.md) -- keep your instance up to date.
