# Self-Hosting SilentSuite

Run the SilentSuite sync server on your own infrastructure. Your data stays on your hardware, fully end-to-end encrypted. No subscriptions, no third-party dependencies.

---

| Guide | Description |
|---|---|
| [Requirements](./requirements.md) | System requirements and prerequisites |
| [Quick Start](./quick-start.md) | Fastest path from zero to running |
| [Manual Setup](./manual-setup.md) | Step-by-step setup with full control |
| [Configuration](./configuration.md) | Environment variables and configuration reference |
| [Updating](./updating.md) | How to update to new versions |
| [Backup & Restore](./backup-and-restore.md) | Protect your data with backups |
| [Admin Dashboard](./admin-dashboard.md) | Manage your instance from the browser |
| [Architecture](./architecture.md) | How the services fit together |
| [Troubleshooting](./troubleshooting.md) | Common issues and how to fix them |
| [Uninstalling](./uninstalling.md) | How to remove SilentSuite |

---

## How It Works

You run the SilentSuite sync server and a PostgreSQL database. That's it -- two containers.

Your users connect using [app.silentsuite.io](https://app.silentsuite.io) or the SilentSuite mobile apps. They enter your server URL in **Advanced Settings** during signup, and all their data syncs to your server, encrypted end-to-end.

You provide your own reverse proxy (Caddy, nginx, Traefik, Cloudflare Tunnel) to handle HTTPS.

## Why Self-Host?

- **Full data sovereignty** -- your data stays on your infrastructure, under your control.
- **No third-party dependencies** -- nothing phones home.
- **All features unlocked** -- every feature, no subscription required.
- **Minimal footprint** -- just 2 containers, ~200 MB RAM.
