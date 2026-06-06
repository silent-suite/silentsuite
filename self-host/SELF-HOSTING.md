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
| **SilentSuite Server** | `ghcr.io/silent-suite/silentsuite-server` (pinned per release) | Sync server (Etebase protocol). All data is E2E encrypted. |
| **PostgreSQL** | `postgres:16.9-alpine` | Database for encrypted sync data and user accounts. |

## Prerequisites

- A Linux server (Ubuntu 22.04+, Debian 12+, or similar)
- Docker Engine 24+ with Compose v2
- A reverse proxy for TLS termination
- A domain name (e.g., `sync.example.com`) with DNS pointing to your server

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/install.sh | bash
```

The installer will:
1. Check that Docker and Docker Compose are installed
2. Resolve which SilentSuite version to install (latest umbrella release, or `main` if none has been cut yet)
3. Create a `silentsuite-server/` directory
4. Download the Docker Compose configuration *from the release tag*, so the compose, helper scripts, and pinned image digest all come from one known-good matrix
5. Ask for your domain name
6. Generate secure random passwords
7. Write the `.env` file
8. Pull Docker images and start the containers
9. Wait for health checks to pass

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

When pinned, the installer fetches all of `docker-compose.yml`, `update.sh`, `verify.sh`, and `success.html` from the requested tag's archive — the entire self-host config moves together as one release.

## Manual Setup

1. **Create a directory and download the config:**
   ```bash
   mkdir silentsuite-server && cd silentsuite-server
   curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/docker-compose.yml -o docker-compose.yml
   curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/.env.example -o .env
   curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/success.html -o success.html
   ```

2. **Generate passwords:**
   ```bash
   openssl rand -base64 32 | tr -d '/+='   # use for DATABASE_PASSWORD
   openssl rand -base64 16 | tr -d '/+='   # use for SUPER_PASS
   ```

3. **Edit `.env`:**
   - `DATABASE_PASSWORD` -- the generated database password
   - `SUPER_PASS` -- the generated admin password

4. **Create `etebase-server.ini`** (server-side configuration; mounted into the container). Replace `YOUR_DATABASE_PASSWORD` with the value you set in `.env`, and `sync.example.com` with your domain:
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
   Save with `chmod 644` so the container's `etebase` user can read it via the bind mount.

5. **Start the stack:**
   ```bash
   docker compose up -d
   ```

6. **Set up your reverse proxy** (see examples below).

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

1. Open [app.silentsuite.io](https://app.silentsuite.io) or the SilentSuite mobile app
2. On the signup page, expand **Advanced Settings**
3. Enter `https://sync.example.com` (your domain) as the server URL
4. Create your account and start syncing
5. **Run `./close-signups.sh`** from your install directory — see below.

## Closing Open Signups

The server ships with `ETEBASE_DISABLE_SIGNUP=false` so your first account can be created from the SilentSuite app. **The window between server-up and admin-registered is unsafe** — anyone who reaches your server URL during that gap can grab an account.

Once your admin account is registered, close signups:

```bash
cd silentsuite-server
./close-signups.sh
```

The script flips `ETEBASE_DISABLE_SIGNUP=true` in `.env` and recreates the server container. New registrations are blocked at the API layer thereafter. To re-open (e.g. to add another user), edit `.env`, set `ETEBASE_DISABLE_SIGNUP=false`, and run `docker compose up -d --force-recreate server`.

## Updating

The server image is pinned to a specific manifest digest per SilentSuite release, so a `docker compose pull` won't fetch a newer SilentSuite version on its own. To upgrade across versions, re-run the installer — it'll download the release-pinned `docker-compose.yml`:

```bash
curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/install.sh | bash
```

Within a single pinned release, `./update.sh` re-pulls the pinned images and recreates the containers (useful after host-level changes):

```bash
./update.sh
```

## Health Checks

```bash
./verify.sh
```

## Admin Panel

Access the admin panel at `https://your-domain/admin/` using the credentials from `.env`.

## Backup and Restore

### Backup

```bash
# Database
docker exec silentsuite-postgres pg_dump -U silentsuite silentsuite > backup.sql

# Server data (secret key, media)
docker run --rm \
  -v self-host_server_data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/server-data.tar.gz -C /data .

# Environment file
cp .env backups/.env.backup
```

### Restore

```bash
# Database
docker compose down
docker volume rm self-host_pgdata
docker compose up -d postgres
sleep 10
docker exec -i silentsuite-postgres psql -U silentsuite silentsuite < backup.sql
docker compose up -d

# Server data
docker compose down
docker volume rm self-host_server_data
docker volume create self-host_server_data
docker run --rm \
  -v self-host_server_data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar xzf /backup/server-data.tar.gz -C /data
docker compose up -d
```

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
- Check that `DATABASE_PASSWORD` in `.env` matches the original value (changing it after first run requires a volume reset or manual password change in PostgreSQL)

### Reset everything
```bash
docker compose down -v   # WARNING: Deletes all data!
curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/install.sh | bash
```

## Security Notes

- PostgreSQL is only accessible within the Docker network (not exposed to the host)
- Docker publishes the server port on host loopback only: `127.0.0.1:${SERVER_PORT:-3735}:3735`. Do not change this to `0.0.0.0` unless you put the server behind your own network firewall or proxy controls.
- All sync traffic is end-to-end encrypted. The server never sees your plaintext data.
- Built on the [Etebase protocol](https://docs.etebase.com), an open standard for E2E encrypted data sync.

## Full Documentation

For more details, see [docs.silentsuite.io/self-hosting](https://docs.silentsuite.io/self-hosting/).
