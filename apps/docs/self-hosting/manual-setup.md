# Manual Setup

If you prefer full control over the configuration, follow these steps instead of the one-liner installer. Make sure you've met the [requirements](./requirements.md) first.

> **Prefer the quick way?** Run the installer:
> ```bash
> curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/install.sh | bash
> ```

## 1. Create a Directory

```bash
mkdir silentsuite-server && cd silentsuite-server
```

## 2. Download the Docker Compose File

```bash
curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/docker-compose.yml -o docker-compose.yml
```

## 3. Create the Environment File

```bash
curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/.env.example -o .env
```

## 4. Generate Secrets

```bash
# Database password
openssl rand -base64 32 | tr -d '/+='

# Django admin password (optional, for advanced use)
openssl rand -base64 16 | tr -d '/+='
```

## 5. Edit .env

Open `.env` and set these values:

| Variable | What to set |
|---|---|
| `DATABASE_PASSWORD` | The first generated password |
| `SUPER_PASS` | The second generated password (optional -- Django admin only) |
| `ALLOWED_HOSTS` | Your domain, e.g., `sync.example.com,localhost` |

See the [Configuration Reference](./configuration.md) for all available options.

## 6. Start the Stack

```bash
docker compose up -d
```

## 7. Wait for Initialization

The server needs 20-30 seconds on first start to run database migrations. Check progress:

```bash
docker compose logs -f server
```

Wait until you see the server accepting connections, then press `Ctrl+C`.

## 8. Verify

```bash
docker compose ps
```

Both `silentsuite-postgres` and `silentsuite-server` should show `Up (healthy)`.

## 9. Set Up Your Reverse Proxy

Configure your reverse proxy to forward HTTPS traffic to `localhost:3735`. See the [Quick Start](./quick-start.md#2-set-up-your-reverse-proxy) for Caddy, nginx, Cloudflare Tunnel, and Docker-based proxy examples.

## 10. Connect Your Apps

1. Open [app.silentsuite.io](https://app.silentsuite.io) or the SilentSuite mobile app.
2. On the signup page, expand **Advanced Settings**.
3. Enter your server's HTTPS URL (e.g., `https://sync.example.com`).
4. Create your account and start syncing -- the first user becomes the admin!

## Next Steps

- [Configuration](./configuration.md) -- full reference for all environment variables.
- [Admin Dashboard](./admin-dashboard.md) -- manage your instance via the web app.
- [Backup & Restore](./backup-and-restore.md) -- protect your data.
