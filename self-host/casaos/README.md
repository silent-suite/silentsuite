# SilentSuite on CasaOS and ZimaOS

`SilentSuite/` is the app folder for the CasaOS / ZimaOS app store
([IceWhaleTech/CasaOS-AppStore](https://github.com/IceWhaleTech/CasaOS-AppStore)). That one
repository builds both the ZimaOS store and the legacy CasaOS store. Until the app is listed
there, nothing here is installable from the store.

The app runs five containers from the published SilentSuite 0.5.22-beta images:

| Container | What it does |
|---|---|
| `silentsuite` | nginx router on port 39128. Sends `/api/` to the sync server and everything else to the web app. Access logging is off. |
| `silentsuite-web` | The SilentSuite web app. |
| `silentsuite-server` | The sync server (Etebase protocol). |
| `silentsuite-db` | PostgreSQL 16. |
| `silentsuite-init` | Runs once at every start, without network access. It creates the credentials on the first start and checks them on every start after that. |

Your browser, the Android app and the desktop Bridge all talk to the sync server. The server
has no CalDAV or CardDAV endpoint of its own. Apps such as Thunderbird reach your data through
the Bridge, which runs on your computer.

## You need HTTPS

SilentSuite only lets you sign up over HTTPS, and neither CasaOS nor ZimaOS puts HTTPS in front
of apps. Before you sign up, put the app behind your own HTTPS reverse proxy or tunnel. For
example, use Nginx Proxy Manager or Caddy with a domain you control, a Cloudflare Tunnel, or
Tailscale Serve. Point it at `http://<your device>:39128` and make sure it:

- passes the original `Host` header through,
- forwards WebSocket upgrades,
- allows request bodies of at least 64 MB.

The plain `http://<your device>:39128` address opens the web app, but signing up fails there.

Anyone who can reach port 39128 reaches the server directly. CasaOS and ZimaOS have no login
page in front of apps, unlike Umbrel. Signing up still needs the installation password below,
and the Django admin panel is switched off.

## Create your account

1. Open SilentSuite at your HTTPS address and choose **Sign up**.
2. Enter the installation password. It is in
   `/DATA/AppData/silentsuite/installation-password/password.txt`, which you can open in the
   Files app. If you cannot see it there, run
   `sudo cat /DATA/AppData/silentsuite/installation-password/password.txt` over SSH.
3. Choose your own account password. It encrypts your data and is never sent to the server. If
   you lose it, nobody can recover your data.

Every new account needs the installation password, so only people you give it to can sign up.

## What is stored where

Everything lives under `/DATA/AppData/silentsuite/`:

| Folder | Contents |
|---|---|
| `postgres/` | The database (accounts and encrypted data) |
| `server/` | Encrypted file chunks and the server's own key (`secret.txt`) |
| `server-secrets/` | The three generated credentials: `owner-password` (the installation password), `registration-signing` and `database-password` |
| `server-config/`, `postgres-secret/`, `installation-password/` | Copies made from `server-secrets/` on every start |

If `server-secrets/` is lost or damaged while the database still exists, SilentSuite will not
start. It never makes new credentials for an existing database, because the database would
not accept them. Restore the folder from your backup.

## Back up and restore

Stop SilentSuite in the dashboard before you copy anything. A copy taken while PostgreSQL runs
may not restore.

Back up to a new folder. `sudo mkdir` creates it and fails if that name is already taken, even
in a folder only root can read, and the copy runs only if `mkdir` succeeded. Copying the
folder's contents (`silentsuite/.`) into the new folder keeps every backup at the same depth:

```bash
dest=/path/to/backup/silentsuite-$(date +%Y%m%d-%H%M%S)
sudo mkdir "$dest" && sudo cp -a /DATA/AppData/silentsuite/. "$dest"/
```

Then start the app again. `cp -a` keeps owners and permissions. The containers need both.

Restore:

1. Stop SilentSuite in the dashboard and check that its containers have stopped.
2. Move the current folder aside into a new folder (it ends up at `$aside/silentsuite`):

   ```bash
   aside=/DATA/AppData/silentsuite.before-restore-$(date +%Y%m%d-%H%M%S)
   sudo mkdir "$aside" && sudo mv /DATA/AppData/silentsuite "$aside"/
   ```

3. Copy the backup back. `mkdir` fails, and nothing is copied, if `/DATA/AppData/silentsuite`
   still exists:

   ```bash
   sudo mkdir /DATA/AppData/silentsuite && sudo cp -a /path/to/backup/silentsuite-<date-time>/. /DATA/AppData/silentsuite/
   ```

4. Start SilentSuite.

Never copy a backup over an existing folder. Database files left over from the newer state
would sit next to the older backup and can damage the database.

## Updates

Each SilentSuite release gets a new version of the store app. CasaOS offers it as an update
because the web image's tag changes; this follows from the CasaOS source and a CI replay of its
check, not from a real device. ZimaOS also gets a new `version`, but its update check has not
been verified. On the next start the server applies any database migrations; your data and
credentials stay where they are. Take a backup before you update. Going back to an older
version after the migrations have run is not supported.

## What has been tested

CI (`.github/workflows/ci-casaos-package.yml`) checks the package on amd64 and arm64. It runs
the store's own build tool, boots what that tool produces, and covers:

- the owner sign-up flow,
- a restart,
- an upgrade from 0.5.20-beta,
- the restore steps above,
- the credential checks, including the case where only the server is restarted.

Not tested yet:

- an install on a real CasaOS or ZimaOS device, including the Files app and the dashboard,
- the Android app and the Bridge against this package,
- a full sign-up in a browser,
- HTTPS through a real proxy.

## For maintainers

- **Package source.** `SilentSuite/` is copied unchanged to `Apps/SilentSuite/` in the store
  repository. The store PR needs the owner's approval of its exact text first.
- **No dollar signs.** ZimaOS interpolates the compose file twice, so the file may contain no
  `$` other than `$AppID`. The init and server programs are Python for that reason, and the
  router writes `@` where nginx needs `$` and translates it with `tr` at start. The contract
  test enforces both.
- **Main service.** `x-casaos.main` is the web service. Legacy CasaOS decides whether to offer
  an update by comparing the main service's image tag, and only the SilentSuite images change
  between releases.
- **Release refresh.** For each release, update the web and server `tag@digest` pins (from the
  release's `umbrel-images.json`), `x-casaos.version`, `update_at` and `release_notes`, then
  `apps/web/app/lib/__tests__/casaos-package-contract.test.ts`. Open a store PR with the same
  change.
