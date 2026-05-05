# Quick Start

This is the fastest path from zero to running. Make sure you've met the [requirements](./requirements.md) first.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/install.sh | bash
```

If you'd rather clone first:

```bash
git clone https://github.com/silent-suite/silentsuite.git
cd silentsuite/self-host
chmod +x install.sh update.sh verify.sh close-signups.sh
./install.sh
```

The `install.sh` script will:

1. Check that Docker and Docker Compose are installed.
2. Resolve the SilentSuite version to install (latest umbrella release, or `main` if none has been cut).
3. Download the release-pinned `docker-compose.yml`, `update.sh`, `verify.sh`, `close-signups.sh`, and `success.html` into `silentsuite-server/`.
4. Prompt you for your domain name.
5. Generate strong random passwords for PostgreSQL and the admin panel.
6. Write the completed `.env` file.
7. Pull Docker images and start the two containers (PostgreSQL and the SilentSuite server).
8. Wait for health checks to pass.

The server listens on `127.0.0.1:3735`. It is **not** reachable from the network until you put a reverse proxy in front of it.

## Set Up a Reverse Proxy

Pick whatever you already run. Examples (Caddy, nginx, Traefik, Cloudflare Tunnel) are in [SELF-HOSTING.md → Reverse Proxy Examples](https://github.com/silent-suite/silentsuite/blob/main/self-host/SELF-HOSTING.md#reverse-proxy-examples). Forward HTTPS traffic for your domain to `localhost:3735`.

## Connect Your Apps

Once the proxy is up:

1. Open [app.silentsuite.io](https://app.silentsuite.io) or the SilentSuite mobile app.
2. On the signup or login page, expand **Advanced Settings**.
3. Enter `https://your-domain.com` as the server URL.
4. Create your admin account and start syncing.

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
