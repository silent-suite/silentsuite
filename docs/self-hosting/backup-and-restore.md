# Backup & Recovery

Protect your self-hosted SilentSuite data with regular, verified backups.

## What Gets Backed Up

| Item | Why |
|---|---|
| **PostgreSQL database** | All encrypted sync data and user accounts |
| **Server data volume** | Media files and, when `secret_file` is under `/data` (the default), the server secret key. **If you lose the secret key, existing encrypted data becomes unrecoverable.** |
| **`.env` and `etebase-server.ini`** | Every password and configuration value the stack runs with |
| **`docker-compose.yml`** (and your override, if you have one) | The stack definition your data was produced by |

---

## Never Type a Volume Name from Documentation

Docker creates a named volume silently when it does not exist. A command like
`docker run -v some_name:/data ... tar czf ...` therefore *succeeds* against a
brand-new empty volume if `some_name` is not the volume your server is really
using — and hands you an empty archive that looks like a backup.

Compose derives the physical volume name from the project name, which depends on
your directory name, `COMPOSE_PROJECT_NAME`, or a `name:` key. No document can
know it. Use the bundled helper, which reads the volume out of the live
container that is actually mounting it.

## Inspect What This Install Is Really Using

```bash
cd silentsuite-server
./backup.sh inspect
```

This is read-only. It prints the Compose project, the two containers, the server
image ID, and the physical volume mounted at `/data` and at
`/var/lib/postgresql/data`.

## Take a Verified Backup

```bash
./backup.sh backup ~/silentsuite-backups/$(date +%Y%m%d-%H%M%S)
```

The destination must not already exist. The helper writes into a private
`.partial` sibling directory and renames it into place only after every check
passes; on any failure it removes the partial directory, so a failed run never
leaves something that looks like a backup.

Before it writes anything it proves the identity of the stack: exactly one
`server` and one `postgres` container, exactly one mount at each expected path,
two distinct named volumes carrying this project's Compose labels, the default
`local` driver with local scope and no driver options. Bind mounts, anonymous
volumes, shared or redirected volumes, custom drivers and ambiguous or missing
identities are all refused.

It then:

- runs a real `pg_dump` inside the admitted database container, using that
  container's own configured credentials (they are never printed);
- proves `django_migrations` actually contains rows, so an empty database cannot
  pass as a successful backup;
- archives the admitted server-data volume **read-only** using the exact image ID
  the server container is already running — nothing is pulled, and no mutable
  helper tag is involved;
- proves the archive contains at least one real file, and that the `secret_file`
  configured in `etebase-server.ini` is inside it when that path lives under
  `/data`;
- copies `.env`, `etebase-server.ini`, `docker-compose.yml` (and
  `docker-compose.override.yml` / `server-image.json` when present) with private
  permissions;
- writes `backup-metadata.txt` and a `SHA256SUMS` manifest covering every other
  file in the backup;
- re-checks the container, volume and image identity after collecting everything,
  and only then renames the directory into place.

The backup directory always contains your `.env`; it contains the server secret
key when `secret_file` is under `/data`. Keep it private and encrypted at rest.

If `secret_file` points somewhere outside `/data`, that file is operator-managed:
the helper does not read host paths, and you must back it up yourself.

## Re-check a Backup Later

```bash
./backup.sh verify ~/silentsuite-backups/20260101-020000
```

This enforces the manifest grammar and exact file inventory, validates the
backup's metadata and secret scope, and checks that every file still matches
`SHA256SUMS`. It catches corruption or edits while the manifest is unchanged,
plus changes made during one verification run. Because `SHA256SUMS` is stored
beside the backup and is not independently authenticated, verification does not
prove who created the backup and cannot detect a deliberate edit accompanied by
a correctly recomputed manifest.

## Automated Backups

```bash
crontab -e
```

Add:

```
# SilentSuite verified backup daily at 2:00 AM
0 2 * * * cd /path/to/silentsuite-server && ./backup.sh backup /path/to/backups/$(date +\%Y\%m\%d-\%H\%M\%S) >> /path/to/backups/backup.log 2>&1
```

Copy the backup directories off-site with `rsync`, `rclone`, or your preferred
tool. Backups you have never verified are not backups — run `./backup.sh verify`
against a copy periodically.

---

## Recovery

**Automated restore is not supported yet.** This release ships a verified,
non-destructive backup path only. There is no `restore` command, no automated
volume deletion, and no automated reset — a wrong restore destroys the data it
was meant to save, and the safe procedure depends on your specific install.

If you need to recover:

1. **Stop making it worse.** Take and preserve a fresh copy of whatever data
   still exists before touching anything. Keep every existing backup.
2. **Verify your backups** with `./backup.sh verify` before relying on one.
3. **Use PostgreSQL- and storage-specific recovery procedures**, with
   expert assistance, against the dump and archive in the backup directory.
   Treat the restore target as an install whose data you are willing to lose.

To stop the stack without deleting any data:

```bash
docker compose down
```

That preserves both volumes; `docker compose up -d` resumes where you left off.

## Rolling Back an Image

Starting an older server image does **not** reverse Django migrations that have
already been applied to your database. A schema migrated forward is not made
backward-compatible by changing the image back. A full rollback generally
requires a logical database dump taken *before* the migration ran — that is what
`./backup.sh backup` produces, so take one before any version move.
