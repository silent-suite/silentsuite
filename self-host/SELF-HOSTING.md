# SilentSuite Self-Hosting Guide

Run your own SilentSuite server. Your data stays on your hardware, fully end-to-end encrypted.

## How It Works

You run the SilentSuite sync server and database. Your users connect via [app.silentsuite.io](https://app.silentsuite.io) or the SilentSuite mobile apps, pointing at your server URL.

```
    Your Server                         SilentSuite Apps
  ┌─────────────────┐
  │  Caddy (HTTPS)  │◄──────────── app.silentsuite.io
  │       :443      │              (or mobile apps)
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
| **Caddy** | `caddy:2-alpine` | Reverse proxy with automatic TLS (Let's Encrypt) |
| **SilentSuite Server** | `victorrds/etebase` | Sync server (built on the Etebase protocol). All data is E2E encrypted. |
| **PostgreSQL** | `postgres:16-alpine` | Database for encrypted sync data and user accounts |

## Prerequisites

- A Linux server (Ubuntu 22.04+, Debian 12+, or similar)
- Docker Engine 24+ with Compose v2
- A domain name (e.g., `sync.example.com`)
- Port 80 and 443 open on your firewall

## DNS Setup

Create **one A record** pointing to your server's public IP:

| Type | Name | Value |
|------|------|-------|
| A | `sync.example.com` | `YOUR_SERVER_IP` |

## Quick Start

```bash
git clone https://github.com/silent-suite/silentsuite.git
cd silentsuite/self-host
chmod +x install.sh update.sh verify.sh
./install.sh
```

The installer will:
1. Check that Docker and Docker Compose are installed
2. Prompt for your domain name
3. Generate secure random passwords
4. Write the `.env` file
5. Pull Docker images and start all containers
6. Wait for health checks to pass
7. Print your server URL and admin credentials

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
   - `DOMAIN` -- your domain (e.g., `sync.example.com`)
   - `DATABASE_PASSWORD` -- the generated database password
   - `SUPER_USER` -- admin username (default: `admin`)
   - `SUPER_PASS` -- the generated admin password

4. **Start the stack:**
   ```bash
   docker compose up -d
   ```

## Connecting Your Apps

Once your server is running:

1. Open [app.silentsuite.io](https://app.silentsuite.io) or the SilentSuite mobile app
2. On the signup or login page, expand **Advanced Settings**
3. Enter `https://your-domain.com` as the server URL
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

Access the admin panel at `https://your-domain.com/admin/` using the credentials from your `.env` file.

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
docker compose logs caddy
```

### TLS certificates not provisioning
- Ensure ports 80 and 443 are open on your firewall
- Verify DNS resolves to your server: `dig your-domain.com`
- Check Caddy logs: `docker compose logs caddy`

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
- Caddy automatically provisions and renews TLS certificates via Let's Encrypt
- All sync traffic is end-to-end encrypted. The server never sees your plaintext data.
- The SilentSuite server is built on the [Etebase protocol](https://docs.etebase.com), an open standard for end-to-end encrypted data sync.
