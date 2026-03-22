# SilentSuite Self-Hosting Guide

Run your own SilentSuite server. Your data stays on your hardware, fully end-to-end encrypted.

## How It Works

You run the SilentSuite sync server and database. Your users connect via [app.silentsuite.io](https://app.silentsuite.io) or the SilentSuite mobile apps, pointing at your server URL.

You provide your own reverse proxy (nginx, Caddy, Traefik, Cloudflare Tunnel, etc.) to handle TLS and forward traffic to the SilentSuite server on port 3735.

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
| **SilentSuite Server** | `victorrds/etebase` | Sync server (built on the Etebase protocol). All data is E2E encrypted. |
| **PostgreSQL** | `postgres:16-alpine` | Database for encrypted sync data and user accounts |

## Prerequisites

- A Linux server (Ubuntu 22.04+, Debian 12+, or similar)
- Docker Engine 24+ with Compose v2
- A reverse proxy for TLS termination (nginx, Caddy, Traefik, etc.)
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
2. Generate secure random passwords
3. Write the `.env` file
4. Pull Docker images and start all containers
5. Wait for health checks to pass
6. Print your server URL and admin credentials

Then configure your reverse proxy to forward HTTPS traffic to `localhost:3735`.

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

3. **Generate passwords and edit `.env`:**
   ```bash
   # Generate passwords
   openssl rand -base64 32 | tr -d '/+='   # use for DATABASE_PASSWORD
   openssl rand -base64 16 | tr -d '/+='   # use for SUPER_PASS
   ```

   Fill in all values in `.env`:
   - `DATABASE_PASSWORD` -- the generated database password
   - `SUPER_USER` -- admin username (default: `admin`)
   - `SUPER_PASS` -- the generated admin password

4. **Start the stack:**
   ```bash
   docker compose up -d
   ```

5. **Set up your reverse proxy** (see examples below).

## Reverse Proxy Examples

The SilentSuite server listens on `127.0.0.1:3735` by default. Configure your reverse proxy to forward HTTPS traffic to it.

### Caddy

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

### Traefik (docker labels)

```yaml
# Add these labels to the server service in docker-compose.yml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.silentsuite.rule=Host(`sync.example.com`)"
  - "traefik.http.routers.silentsuite.tls.certresolver=letsencrypt"
  - "traefik.http.services.silentsuite.loadbalancer.server.port=3735"
```

> **Note:** If Traefik itself runs in Docker, replace the `ports:` mapping on the server service with `expose: ["3735"]` in `docker-compose.yml` and ensure Traefik shares a Docker network with the server container.

### Cloudflare Tunnel

```bash
cloudflared tunnel --url http://localhost:3735
```

### Recommended Security Headers

Add these headers in your reverse proxy for defense in depth:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

## Connecting Your Apps

Once your server is running and your reverse proxy is configured:

1. Open [app.silentsuite.io](https://app.silentsuite.io) or the SilentSuite mobile app
2. On the signup or login page, expand **Advanced Settings**
3. Enter `https://sync.example.com` as the server URL
4. Create your account and start syncing

## Updating

Pull the latest images and restart:

```bash
./update.sh
```

Or manually:

```bash
docker compose pull
docker compose up -d
```

## Health Checks

Run the built-in health checker:

```bash
./verify.sh
```

## Admin Panel

Access the admin panel at `http://localhost:3735/admin/` (or via your reverse proxy at `https://your-domain.com/admin/`) using the credentials from your `.env` file.

## Backup and Restore

### Backup

```bash
# Database dump
docker exec silentsuite-postgres pg_dump -U silentsuite silentsuite > backup.sql

# Server data (secret key, media)
docker cp silentsuite-server:/data ./server-backup
```

### Restore

```bash
# Database
cat backup.sql | docker exec -i silentsuite-postgres psql -U silentsuite silentsuite

# Server data
docker cp ./server-backup/. silentsuite-server:/data
docker compose restart server
```

## Troubleshooting

### Containers won't start
```bash
docker compose logs postgres
docker compose logs server
```

### Database connection errors
- Verify PostgreSQL is healthy: `docker compose ps`
- Check that `DATABASE_PASSWORD` in `.env` is correct

### Reset everything
```bash
docker compose down -v   # WARNING: This deletes all data!
./install.sh
```

## Security Notes

- PostgreSQL is only accessible within the Docker network (not exposed to the host)
- The server binds to `127.0.0.1` only — not accessible from the network without a reverse proxy
- All sync traffic is end-to-end encrypted. The server never sees your plaintext data.
- The SilentSuite server is built on the [Etebase protocol](https://docs.etebase.com), an open standard for end-to-end encrypted data sync.
