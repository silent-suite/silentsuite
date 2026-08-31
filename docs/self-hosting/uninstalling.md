# Uninstalling

How to remove SilentSuite from your server.

## Stop Without Deleting Data

If you only want to stop the services but preserve your data for later:

```bash
cd silentsuite-server
docker compose down
```

The data volumes will persist and the stack will resume where it left off when
you run `docker compose up -d` again. This is the supported stop path.

## Complete Removal

Automated deletion of your data volumes is **not** supported by this release, and
no command here removes them. Docker volume names are project-dependent, and a
guessed name deletes the wrong thing as easily as the right one.

Start in the installation directory. Record its exact canonical path, inspect
the volume names, and take and preserve a verified backup:

```bash
pwd -P  # write down and inspect this exact path before continuing
./backup.sh backup ~/silentsuite-final-backup
./backup.sh verify ~/silentsuite-final-backup
./backup.sh inspect  # record the two exact volume names before removing this directory
```

Then stop the stack and remove the parts that are safe to remove automatically:

```bash
# Stop and remove the containers (volumes are left alone)
docker compose down

# Remove the Docker images (the silentsuite-server tag/digest may differ — list yours with `docker image ls`)
docker image rm postgres@sha256:7c688148e5e156d0e86df7ba8ae5a05a2386aaec1e2ad8e6d11bdf10504b1fb7
docker image ls --filter 'reference=ghcr.io/silent-suite/silentsuite-server' --format '{{.ID}}' | xargs -r docker image rm
```

The installation directory and two data volumes still exist at this point.
Leave the directory, inspect the canonical installation path you recorded, and
deliberately remove that exact path yourself. Do not guess its name. The
inspection output recorded before removing it identifies the volumes. Deleting
the directory or volumes is an irreversible manual step you take yourself,
against those exact identities, once you are certain the backup you kept is one
you can live with.

If you set up a reverse proxy (Caddy, nginx, Traefik, Cloudflare Tunnel)
yourself, that's outside the SilentSuite stack — remove its config and any
certificates it provisioned separately.
