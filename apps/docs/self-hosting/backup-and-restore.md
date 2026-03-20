# Backup & Restore

Protect your self-hosted SilentSuite data with regular backups.

## What to Back Up

There are three things to back up:

1. **The PostgreSQL database** -- contains all encrypted sync data and user accounts.
2. **The server data volume** -- stores the server's secret key and media files.
3. **The `.env` file** -- contains all your secrets and configuration.

---

## Back Up the Database

Create a full PostgreSQL dump:

```bash
docker exec silentsuite-postgres pg_dump -U silentsuite silentsuite > backup-$(date +%Y%m%d-%H%M%S).sql
```

## Back Up the Server Data Volume

```bash
docker run --rm \
  -v silentsuite_server_data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/server-data-$(date +%Y%m%d-%H%M%S).tar.gz -C /data .
```

## Back Up the .env File

Your `.env` file contains all secrets. Keep a secure, encrypted copy:

```bash
cp .env backups/.env.backup
```

## Automated Backups

For production deployments, set up a cron job:

```bash
# Run a full backup daily at 2:00 AM
0 2 * * * cd /path/to/silentsuite/self-host && docker exec silentsuite-postgres pg_dump -U silentsuite silentsuite > /path/to/backups/silentsuite-$(date +\%Y\%m\%d).sql
```

---

## Restore the Database

To restore from a backup, stop the stack, replace the database, and restart:

```bash
# Stop all services
docker compose down

# Remove the existing database volume
docker volume rm self-host_pgdata

# Start only PostgreSQL
docker compose up -d postgres

# Wait for it to be healthy
sleep 10
docker compose exec postgres pg_isready -U silentsuite

# Restore the backup
docker exec -i silentsuite-postgres psql -U silentsuite silentsuite < backup-20260101-020000.sql

# Start the rest of the stack
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
