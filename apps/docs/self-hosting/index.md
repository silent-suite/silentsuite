# Self-Hosting SilentSuite

Deploy and manage SilentSuite on your own infrastructure. Self-hosting gives you full data sovereignty, no third-party dependencies, and all features unlocked with no subscription required.

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

## Why Self-Host?

- **Full data sovereignty** -- your data stays on your infrastructure, under your control.
- **No third-party dependencies** -- nothing phones home.
- **Custom domain** -- run the suite on your own domain with automatic HTTPS.
- **All features unlocked** -- every feature, no subscription required.

The self-hosted stack runs four services via Docker Compose: PostgreSQL, Etebase (encrypted sync), a Next.js web frontend, and Caddy as a reverse proxy with automatic TLS.
