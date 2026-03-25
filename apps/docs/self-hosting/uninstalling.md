# Uninstalling

How to remove SilentSuite from your server.

## Stop Without Deleting Data

If you only want to stop the services but keep your data for later:

```bash
docker compose down
```

The data volumes will persist. Run `docker compose up -d` to start again.

## Complete Removal

To completely remove SilentSuite and all its data:

```bash
# Stop and remove all containers and volumes
docker compose down -v

# Remove the Docker images
docker rmi victorrds/etebase:latest postgres:16-alpine

# Remove the cloned repository
cd ..
rm -rf silentsuite
```

> **Warning:** `docker compose down -v` deletes all data volumes. This is irreversible. [Back up](./backup-and-restore.md) first if you want to keep your data.
