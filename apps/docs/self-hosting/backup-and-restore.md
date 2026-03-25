# Backup & Restore

Protect your self-hosted SilentSuite data with regular backups.

## What to Back Up

| Item | Why |
|---|---|
| **PostgreSQL database** | All encrypted sync data and user accounts |
| **Server data volume** | Server secret key and media files. **If you lose the secret key, existing encrypted data becomes unrecoverable.** |
| **`.env` file** | Contains all passwords and configuration |

---

## Back Up the Database

```bash
docker exec silentsuite-postgres pg_dump -U silentsuite silentsuite > backup-$(date +%Y%m%d-%H%M%S).sql
```

## Back Up the Server Data Volume

```bash
mkdir -p backups
docker run --rm \
  -v self-host_server_data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/server-data-$(date +%Y%m%d-%H%M%S).tar.gz -C /data .
```

> **Note:** The volume name depends on the directory name where `docker-compose.yml` lives. If you cloned to the default location, it will be `self-host_server_data`. Check with `docker volume ls | grep server_data`.

## Back Up the .env File

```bash
cp .env backups/.env.backup
```

## Automated Backups

Set up a daily cron job:

```bash
crontab -e
```

Add:

```
# SilentSuite daily backup at 2:00 AM
0 2 * * * cd /path/to/silentsuite/self-host && docker exec silentsuite-postgres pg_dump -U silentsuite silentsuite > /path/to/backups/silentsuite-$(date +\%Y\%m\%d).sql
```

For off-site backups, use `rsync`, `rclone`, or your preferred tool to copy the backup directory to another server.

---

## Restore the Database

```bash
# Stop all services
docker compose down

# Remove the existing database volume
docker volume rm self-host_pgdata

# Start only PostgreSQL
docker compose up -d postgres

# Wait for it to be ready
sleep 10
docker compose exec postgres pg_isready -U silentsuite

# Restore the backup
docker exec -i silentsuite-postgres psql -U silentsuite silentsuite < backup-20260101-020000.sql

# Start the server
docker compose up -d
```

## Restore the Server Data Volume

```bash
docker compose down

docker volume rm self-host_server_data
docker volume create self-host_server_data

docker run --rm \
  -v self-host_server_data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar xzf /backup/server-data-20260101-020000.tar.gz -C /data

docker compose up -d
```

## Test Your Backups

Backups you've never restored from are not backups. Periodically verify by restoring to a test instance.
