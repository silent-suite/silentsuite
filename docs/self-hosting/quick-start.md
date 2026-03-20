# Quick Start

This is the fastest path from zero to running. Make sure you've met the [requirements](./requirements.md) first.

## Install

```bash
git clone https://github.com/silent-suite/silentsuite.git
cd silentsuite/self-host
chmod +x install.sh update.sh verify.sh
./install.sh
```

The `install.sh` script will:

1. Check that Docker and Docker Compose are installed.
2. Prompt you for your domain name.
3. Generate strong random passwords for PostgreSQL and the admin panel.
4. Write the completed `.env` file.
5. Pull Docker images and start all containers.
6. Wait for health checks to pass.
7. Print your server URL and admin credentials.

## Connect Your Apps

Once the server is running:

1. Open [app.silentsuite.io](https://app.silentsuite.io) or the SilentSuite mobile app.
2. On the signup or login page, expand **Advanced Settings**.
3. Enter `https://your-domain.com` as the server URL.
4. Create your account and start syncing.

## Verify

To verify everything is running:

```bash
./verify.sh
```

All services should show `Up` with a health status of `healthy`.

## Next Steps

- [Configuration](./configuration.md) -- understand and customise your environment variables.
- [Admin Dashboard](./admin-dashboard.md) -- manage your instance via the Django admin panel.
- [Updating](./updating.md) -- keep your instance up to date.
