# Retired Docker Stack

The legacy Docker stack is retired. Use [`../self-host/`](../self-host/SELF-HOSTING.md) to run a SilentSuite sync server.

If you still run an installation from the legacy compose files:

- Back it up before you change anything. The `postgres_data` volume holds the database, and the `etebase_data` volume holds the server secret key at `/data/secret.txt`.
- Preserve both volumes. Never run `docker compose down -v`, `docker volume rm`, or `docker volume prune` against them.
- Pulling this change deletes the compose files and leaves your containers and volumes in place. To run compose commands against the installation again, restore the files with `git checkout 3f331069ea2977855dc7440e0dd907673d70041d -- docker`.
- If you edited `etebase/etebase-server.ini`, `git pull` may refuse to delete it until you deal with your local changes. Keep a copy of your edited file first. The `git checkout` command above restores the repository's default file, not your version.
- `self-host/` only performs fresh installations. It does not import users or data from the legacy stack, and no tested migration is provided.
- Stopping the legacy containers is not enough to install `self-host/` on the same host. Both stacks use the container name `silentsuite-postgres` and host port 3735, and the installer refuses to run while a container with that name exists, even a stopped one. To clear the conflict, run `docker compose down` without `-v` from this `docker/` directory, restoring the files first if needed. That removes the containers and keeps both volumes. Keep this directory, its `.env`, your edited `etebase-server.ini` and the same compose project name so the old installation can find its volumes again.
