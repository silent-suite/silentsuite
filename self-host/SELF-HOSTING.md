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
| **SilentSuite Server** | `victorrds/etebase` | Sync server (Etebase protocol). All data is E2E encrypted. |
| **PostgreSQL** | `postgres:16-alpine` | Database for encrypted sync data and user accounts. |

## Prerequisites

- A Linux server (Ubuntu 22.04+, Debian 12+, or similar)
- Docker Engine 24+ with Compose v2
- A reverse proxy for TLS termination
- A domain name (e.g., `sync.example.com`) with DNS pointing to your server

## Quick Start

```bash
git clone https://github.com/silent-suite/silentsuite.git
cd silentsuite/self-host
chmod +x install.sh update.sh verify.sh
./install.sh
```

The installer will:
1. Check that Docker and Docker Compose are installed
2. Ask for your domain name
3. Generate secure random passwords
4. Write the `.env` file
5. Pull Docker images and start the containers
6. Wait for health checks to pass
7. Print your admin credentials

Then set up your reverse proxy to forward HTTPS traffic to `localhost:3735`.

## Manual Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/silent-suite/silentsuite.git
   cd silentsuite/self-host
   ```

2. **Create the environment file:**
   ```bash
   cp .env.example .env
   ```

3. **Generate passwords:**
   ```bash
   openssl rand -base64 32 | tr -d '/+='   # use for DATABASE_PASSWORD
   openssl rand -base64 16 | tr -d '/+='   # use for SUPER_PASS
   ```

4. **Edit `.env`:**
   - `DATABASE_PASSWORD` -- the generated database password
   - `SUPER_PASS` -- the generated admin password
   - `ALLOWED_HOSTS` -- your domain, e.g., `sync.example.com,localhost`

5. **Start the stack:**
   ```bash
   docker compose up -d
   ```

6. **Set up your reverse proxy** (see examples below).

## Reverse Proxy Examples

The SilentSuite server listens on `127.0.0.1:3735` by default. Configure your reverse proxy to forward HTTPS traffic to it.

### Caddy (recommended -- automatic HTTPS)

```
sync.example.com {
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

### Traefik (Docker labels)

```yaml
# Add these labels to the server service in docker-compose.yml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.silentsuite.rule=Host(`sync.example.com`)"
  - "traefik.http.routers.silentsuite.tls.certresolver=letsencrypt"
  - "traefik.http.services.silentsuite.loadbalancer.server.port=3735"
```

> If Traefik runs in Docker, replace the `ports:` mapping with `expose: ["3735"]` and ensure Traefik shares the `silentsuite` Docker network.

### Cloudflare Tunnel

```bash
cloudflared tunnel --url http://localhost:3735
```

### Recommended Security Headers

Add these in your reverse proxy for defense in depth:

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

## Updating

```bash
./update.sh
```

Or manually:

```bash
docker compose pull
docker compose up -d
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
Your domain is not in `ALLOWED_HOSTS`. Update `.env` and recreate:
```bash
docker compose up -d --force-recreate server
```

### Database connection errors
- Verify PostgreSQL is healthy: `docker compose ps`
- Check that `DATABASE_PASSWORD` in `.env` matches the original value (changing it after first run requires a volume reset or manual password change in PostgreSQL)

### Reset everything
```bash
docker compose down -v   # WARNING: Deletes all data!
./install.sh
```

## Security Notes

- PostgreSQL is only accessible within the Docker network (not exposed to the host)
- The server binds to `127.0.0.1` only -- not accessible from the network without a reverse proxy
- All sync traffic is end-to-end encrypted. The server never sees your plaintext data.
- Built on the [Etebase protocol](https://docs.etebase.com), an open standard for E2E encrypted data sync.

## Full Documentation

For more details, see [docs.silentsuite.io/self-hosting](https://docs.silentsuite.io/self-hosting/).
