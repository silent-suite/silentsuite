# Manual Setup

If you prefer full control over the configuration, follow these steps instead of running `install.sh`. Make sure you've met the [requirements](./requirements.md) first.

## 1. Clone the Repository

```bash
git clone https://github.com/silent-suite/silentsuite.git
cd silentsuite/self-host
```

## 2. Create the Environment File

```bash
cp .env.example .env
```

## 3. Generate Secrets

```bash
# Database password
openssl rand -base64 32 | tr -d '/+='

# Admin password
openssl rand -base64 16 | tr -d '/+='
```

## 4. Edit .env

Open `.env` and set these values:

| Variable | What to set |
|---|---|
| `DATABASE_PASSWORD` | The first generated password |
| `SUPER_PASS` | The second generated password |
| `ALLOWED_HOSTS` | Your domain, e.g., `sync.example.com,localhost` |

See the [Configuration Reference](./configuration.md) for all available options.

## 5. Start the Stack

```bash
docker compose up -d
```

## 6. Wait for Initialization

The server needs 20-30 seconds on first start to run database migrations. Check progress:

```bash
docker compose logs -f server
```

Wait until you see the server accepting connections, then press `Ctrl+C`.

## 7. Verify

```bash
docker compose ps
```

Both `silentsuite-postgres` and `silentsuite-server` should show `Up (healthy)`.

You can also run:

```bash
./verify.sh
```

## 8. Set Up Your Reverse Proxy

Configure your reverse proxy to forward HTTPS traffic to `localhost:3735`. See the [Quick Start](./quick-start.md#2-set-up-your-reverse-proxy) for Caddy, nginx, and Cloudflare Tunnel examples.

## 9. Connect Your Apps

1. Open [app.silentsuite.io](https://app.silentsuite.io) or the SilentSuite mobile app.
2. On the signup page, expand **Advanced Settings**.
3. Enter your server's HTTPS URL (e.g., `https://sync.example.com`).
4. Create your account and start syncing.

## Next Steps

- [Configuration](./configuration.md) -- full reference for all environment variables.
- [Admin Dashboard](./admin-dashboard.md) -- manage your instance via the Django admin panel.
- [Backup & Restore](./backup-and-restore.md) -- protect your data.
