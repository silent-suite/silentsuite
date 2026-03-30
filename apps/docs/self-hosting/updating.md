# Updating

How to keep your self-hosted SilentSuite instance up to date.

## Using update.sh (Recommended)

```bash
./update.sh
```

This script pulls the latest images, recreates the containers, and waits for health checks to pass.

## Manual Update

```bash
docker compose pull
docker compose up -d
```

Verify the update:

```bash
docker compose ps
./verify.sh
```

## What Gets Updated

The `docker-compose.yml` uses the `latest` tag for both images by default:

- `ghcr.io/silent-suite/silentsuite-server:latest` -- the SilentSuite sync server
- `postgres:16-alpine` -- PostgreSQL database

Running `docker compose pull` fetches the newest versions of these images.

## Pinning Versions

For production deployments, you can pin specific image versions in `docker-compose.yml`:

```yaml
server:
  image: ghcr.io/silent-suite/silentsuite-server:v0.15.0
```

This prevents unexpected changes when pulling. Check the [GitHub Container Registry](https://github.com/silent-suite/silentsuite/pkgs/container/silentsuite-server) for available tags.

## Data Safety

Updates preserve your data. Docker named volumes (`pgdata`, `server_data`) are not affected by container recreation. However, it is good practice to [back up](./backup-and-restore.md) before major updates.
