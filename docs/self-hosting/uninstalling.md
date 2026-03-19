# Uninstalling

How to remove SilentSuite from your server.

## Complete Removal

To completely remove SilentSuite and all its data:

```bash
# Stop and remove all containers
docker compose down

# Remove all data volumes (THIS DELETES ALL DATA)
docker volume rm self-host_pgdata self-host_etebase_data self-host_caddy_data self-host_caddy_config

# Remove the Docker images
docker rmi ghcr.io/silent-suite/silentsuite-web:latest
docker rmi victorrds/etebase:latest
docker rmi postgres:16-alpine
docker rmi caddy:2-alpine

# Remove the cloned repository
cd ..
rm -rf silentsuite.io
```

## Stop Without Deleting Data

If you only want to stop the services but preserve your data for later:

```bash
docker compose down
```

The data volumes will persist and the stack will resume where it left off when you run `docker compose up -d` again.
