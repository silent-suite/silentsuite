# Updating

How to keep your self-hosted SilentSuite instance up to date.

## Using update.sh (Recommended)

```bash
./update.sh
```

This script pulls the latest images and restarts the stack with zero-downtime rolling updates where possible.

## Manual Update

```bash
# Pull latest images
docker compose pull

# Recreate containers with new images
docker compose up -d

# Verify
docker compose ps
```

## Pinning Versions

By default, the `docker-compose.yml` uses the `latest` tag for SilentSuite images. To pin a specific version, edit the image tags:

```yaml
web:
  image: ghcr.io/silent-suite/silentsuite-web:v1.2.0
```

Pinning versions is recommended for production deployments to avoid unexpected changes.
