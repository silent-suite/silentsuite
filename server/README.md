# SilentSuite Server

End-to-end encrypted sync server for calendar, contacts, and tasks. Built on the [Etebase](https://www.etebase.com) protocol.

**Private Sync, By Design.**

## What is this?

SilentSuite Server is the backend component of [SilentSuite](https://silentsuite.io), a privacy-focused sync service. It stores your calendar events, contacts, and tasks as encrypted blobs. The server never sees your data in plaintext. Encryption keys never leave your device.

This project is based on the [Etebase server](https://github.com/etesync/server) by the EteSync contributors, modified and maintained by the SilentSuite team. See [NOTICE](./NOTICE) for attribution details.

## Architecture

```
┌─────────────┐         ┌──────────────────┐
│  Client App  │  E2EE   │ SilentSuite      │
│  (calendar,  │ ──────> │ Server           │
│   contacts,  │         │                  │
│   tasks)     │ <────── │ Stores encrypted │
└─────────────┘  sync    │ blobs only       │
                         └──────────────────┘
                                │
                         ┌──────┴──────┐
                         │  Database   │
                         │  (SQLite /  │
                         │  PostgreSQL)│
                         └─────────────┘
```

The server implements the Etebase protocol. All data is encrypted client-side before transmission. The server stores and syncs encrypted data without the ability to decrypt it.

## Requirements

- Python 3.10+
- pip

## Quick Start (Docker)

A production-ready `docker-compose.yml` is coming soon. For now, see the [from source](#quick-start-from-source) instructions below, or refer to the upstream [Docker wiki](https://github.com/etesync/server/wiki) for container-based setups.

## Quick Start (from source)

```bash
git clone https://github.com/silent-suite/silentsuite-server.git
cd silentsuite-server

# Set up Python environment
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Copy and edit the config
cp etebase-server.ini.example etebase-server.ini
# Edit etebase-server.ini: set ALLOWED_HOSTS, MEDIA_ROOT, DEBUG=false

# Initialize the database
python manage.py migrate
python manage.py collectstatic

# Run the server
uvicorn etebase_server.asgi:application --host 0.0.0.0 --port 8000
```

For production, use a reverse proxy (nginx) with TLS in front of uvicorn.

## Configuration

Copy `etebase-server.ini.example` to `etebase-server.ini` and configure:

| Setting | Description |
|---------|-------------|
| `ALLOWED_HOSTS` | Domain(s) the server responds to (e.g., `server.silentsuite.io`) |
| `DEBUG` | Set to `false` in production |
| `MEDIA_ROOT` | Path to store user data |
| `SECRET_KEY` | Auto-generated in `secret.txt` on first run |

The config file can be placed at the repo root or at `/etc/etebase-server/etebase-server.ini`.

For advanced configuration, edit `etebase_server/settings.py` directly. See the [Django deployment checklist](https://docs.djangoproject.com/en/dev/howto/deployment/checklist/).

To disable self-registration, uncomment the following line in `etebase_server/settings.py`:

```python
ETEBASE_CREATE_USER_FUNC = "etebase_server.django.utils.create_user_blocked"
```

## Data and Backups

The server stores data in two locations:

1. **Database** (SQLite by default at `data/db.sqlite3`)
2. **Media directory** (user encrypted data at the `MEDIA_ROOT` path)

Both must be backed up regularly. For SQLite, use `sqlite3 db.sqlite3 ".backup backup.db"` for safe online backups.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Framework | Django 4.2 + Django REST Framework |
| ASGI | uvicorn |
| Protocol | Etebase (E2EE sync) |
| Database | SQLite (default), PostgreSQL (supported) |
| Language | Python 3.10+ |

## User Registration

> **Note:** Self-registration is enabled by default. This differs from the upstream Etebase server, which blocks registration by default. If you are self-hosting and want to restrict signups, see the section below.

## Roadmap

- [ ] CalDAV/CardDAV bridge (use SilentSuite with existing calendar apps)
- [ ] Web client application
- [ ] Django 5.2 LTS upgrade (4.2 EOL: April 2026)
- [ ] Production Docker Compose setup
- [ ] Test suite
- [ ] PostgreSQL as default database
- [ ] Health check endpoint
- [ ] Admin dashboard for self-hosters

## License

This project is licensed under the [GNU Affero General Public License v3.0](./LICENSE) (AGPL-3.0).

Based on [Etebase Server](https://github.com/etesync/server) by the EteSync contributors. See [NOTICE](./NOTICE) for full attribution.

In simple terms: you can use, modify, and self-host this server freely. If you modify the server code and offer it as a network service, you must make your modified source code available to users of that service.

## Links

- **Website:** [silentsuite.io](https://silentsuite.io)
- **Etebase protocol:** [etebase.com](https://www.etebase.com)
- **Original project:** [github.com/etesync/server](https://github.com/etesync/server)
