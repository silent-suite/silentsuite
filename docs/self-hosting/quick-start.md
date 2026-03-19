# Quick Start

This is the fastest path from zero to running. Make sure you've met the [requirements](./requirements.md) first.

## Install

```bash
git clone https://github.com/silent-suite/silentsuite.io.git
cd silentsuite.io/self-host
chmod +x install.sh update.sh verify.sh
./install.sh
```

The `install.sh` script will:

1. Check that Docker and Docker Compose are installed.
2. Prompt you for your domain name.
3. Generate strong random passwords for PostgreSQL and Etebase.
4. Write the completed `.env` file.
5. Copy the database initialization scripts into `./init-db/`.
6. Pull all Docker images.
7. Start the stack with `docker compose up -d`.

## Verify

Once the script completes, open `https://your-domain` in a browser. The first request may take a moment while Caddy provisions TLS certificates.

To verify everything is running:

```bash
./verify.sh
```

All services should show `Up` with a health status of `healthy`.

## Next Steps

- [Configuration](./configuration.md) -- understand and customise your environment variables.
- [Admin Dashboard](./admin-dashboard.md) -- manage your instance from the browser.
- [Updating](./updating.md) -- keep your instance up to date.
