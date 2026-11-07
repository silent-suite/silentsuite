# Retired Docker Stack

The legacy Docker stack is retired. Use [`../self-host/`](../self-host/SELF-HOSTING.md) to run a SilentSuite sync server.

If you still run an installation from the legacy compose files:

- Back it up before you change anything. The `postgres_data` volume holds the database, and the `etebase_data` volume holds the server secret key at `/data/secret.txt`. Without that key, existing encrypted data is unrecoverable.
- Preserve both volumes. Never run `docker compose down -v`, `docker volume rm`, or `docker volume prune` against them.
- Stop the legacy containers before you install `self-host/` on the same host. Both stacks use the container name `silentsuite-postgres` and host port 3735.
- Pulling this change deletes the compose files and leaves your containers and volumes in place. To run compose commands against the installation again, restore the files with `git checkout 3f331069ea2977855dc7440e0dd907673d70041d -- docker`.
