# Uninstalling

How to remove SilentSuite from your server.

## Complete Removal

To completely remove SilentSuite and all its data:

```bash
# Stop and remove the containers
cd silentsuite-server
docker compose down

# Remove all data volumes (THIS DELETES ALL DATA)
docker volume rm self-host_pgdata self-host_server_data

# Remove the Docker images
docker image rm $(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^(ghcr\.io/silent-suite/silentsuite-server|postgres):' )

# Remove the install directory
cd ..
rm -rf silentsuite-server
```

If you set up a reverse proxy (Caddy, nginx, Traefik, Cloudflare Tunnel) yourself, that's outside the SilentSuite stack — remove its config and any certificates it provisioned separately.

## Stop Without Deleting Data

If you only want to stop the services but preserve your data for later:

```bash
docker compose down
```

The data volumes will persist and the stack will resume where it left off when you run `docker compose up -d` again.
