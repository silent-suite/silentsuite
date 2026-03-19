# SilentSuite Self-Hosting Guide

Host your own SilentSuite instance with end-to-end encrypted calendar, contacts, and task sync.

## Architecture

```
                    ┌─────────────────────────────────┐
                    │           Internet               │
                    └──────┬──────────────┬────────────┘
                           │              │
                      port 80/443    port 80/443
                           │              │
                    ┌──────┴──────────────┴────────────┐
                    │         Caddy (reverse proxy)     │
                    │   auto-TLS via Let's Encrypt      │
                    └──────┬──────────────┬────────────┘
                           │              │
                    DOMAIN:3000    sync.DOMAIN:3735
                           │              │
                 ┌─────────┴───┐  ┌───────┴──────────┐
                 │   Web App   │  │  Etebase Server   │
                 │  (Next.js)  │  │  (Django/uvicorn) │
                 └─────────────┘  └───────┬──────────┘
                                          │
                                  ┌───────┴──────────┐
                                  │   PostgreSQL 16   │
                                  │   (internal only) │
                                  └──────────────────┘
```

**3 application containers** + Caddy reverse proxy:

| Service    | Purpose                                | Port (internal) |
|------------|----------------------------------------|-----------------|
| `web`      | Next.js web application                | 3000            |
| `etebase`  | Etebase sync server (EteSync protocol) | 3735            |
| `postgres` | PostgreSQL 16 database                 | 5432            |
| `caddy`    | Reverse proxy with auto-TLS            | 80, 443         |

## Prerequisites

- A Linux server (Ubuntu 22.04+, Debian 12+, or similar)
- Docker Engine 24+ with Compose v2
- A registered domain name
- Ports 80 and 443 open on firewall

## DNS Setup

Create **two A records** pointing to your server's public IP:

| Type | Name            | Value           |
|------|-----------------|-----------------|
| A    | `DOMAIN`        | `YOUR_SERVER_IP` |
| A    | `sync.DOMAIN`   | `YOUR_SERVER_IP` |

Replace `DOMAIN` with your chosen domain (e.g., `suite.example.com`).

DNS propagation can take up to 48 hours, but typically completes within minutes.

## Quick Start

```bash
git clone https://github.com/silentsuite/silentsuite.io.git
cd silentsuite.io/self-host
./install.sh
```

The installer will:
1. Check that Docker and Docker Compose are installed
2. Prompt for your domain name
3. Generate secure random passwords
4. Write `.env` and patch configuration files
5. Build and start all containers
6. Wait for health checks to pass
7. Print your instance URLs and admin credentials

## Manual Setup

If you prefer to configure things manually:

1. **Copy the environment template:**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env`** with your values:
   ```
   DOMAIN=suite.example.com
   POSTGRES_PASSWORD=<generate with: openssl rand -base64 32>
   ETEBASE_DB_PASSWORD=<generate with: openssl rand -base64 32>
   ETEBASE_ADMIN_USER=admin
   ETEBASE_ADMIN_PASSWORD=<generate with: openssl rand -base64 32>
   ```

3. **Patch `etebase-server.ini`:**
   ```bash
   sed -i "s|PLACEHOLDER_DOMAIN|sync.suite.example.com|g" etebase-server.ini
   sed -i "s|PLACEHOLDER_ETEBASE_DB_PASSWORD|<your_etebase_db_password>|g" etebase-server.ini
   ```

4. **Start the stack:**
   ```bash
   docker compose up -d --build
   ```

## Updating

Pull the latest code and rebuild:

```bash
git pull
./update.sh
```

Or manually:

```bash
docker compose pull
docker compose up -d --build
```

## Health Checks

Run the built-in health checker:

```bash
./verify.sh
```

This checks:
- All container states and health status
- Web app and Etebase endpoint availability
- DNS record resolution

## Backup & Restore

### Backup

```bash
# Database dump
docker exec silentsuite-postgres pg_dump -U silentsuite_admin silentsuite > backup.sql

# Etebase data
docker cp etebase-server:/data ./etebase-backup
```

### Restore

```bash
# Database restore
cat backup.sql | docker exec -i silentsuite-postgres psql -U silentsuite_admin silentsuite

# Etebase data
docker cp ./etebase-backup/. etebase-server:/data
docker compose restart etebase
```

## Troubleshooting

### Containers won't start

```bash
# Check logs for a specific service
docker compose logs postgres
docker compose logs etebase
docker compose logs web
docker compose logs caddy
```

### TLS certificates not provisioning

- Ensure ports 80 and 443 are open on your firewall
- Verify DNS records resolve to your server: `dig DOMAIN` and `dig sync.DOMAIN`
- Check Caddy logs: `docker compose logs caddy`

### Database connection errors

- Verify PostgreSQL is healthy: `docker compose ps`
- Check that passwords in `.env` match `etebase-server.ini`

### Web app shows blank page

- Check web container logs: `docker compose logs web`
- Ensure `NEXT_PUBLIC_ETEBASE_SERVER_URL` resolves correctly

### Reset everything

```bash
docker compose down -v  # WARNING: This deletes all data!
./install.sh
```

## Etebase Admin Panel

Access the Django admin panel at `https://sync.DOMAIN/admin/` using the credentials from your `.env` file (`ETEBASE_ADMIN_USER` / `ETEBASE_ADMIN_PASSWORD`).

## Security Notes

- PostgreSQL is only accessible within the Docker network (not exposed to the host)
- Caddy automatically provisions and renews TLS certificates via Let's Encrypt
- All sync traffic is end-to-end encrypted by the Etebase protocol
- Security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy) are set on all responses
