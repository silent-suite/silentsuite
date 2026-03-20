# Manual Setup

If you prefer full control over the configuration, follow these steps instead of running `install.sh`. Make sure you've met the [requirements](./requirements.md) first.

## 1. Clone the Repository

```bash
git clone https://github.com/silent-suite/silentsuite.git
cd silentsuite/self-host
```

## 2. Create the Environment File

```bash
cp .env.example .env
```

## 3. Generate Secrets

Generate the passwords that `.env` requires:

```bash
openssl rand -base64 32 | tr -d '/+='   # use for DATABASE_PASSWORD
openssl rand -base64 16 | tr -d '/+='   # use for SUPER_PASS
```

## 4. Edit .env

Open `.env` in your editor and fill in all required values. See the [Configuration Reference](./configuration.md) for details on each variable.

At minimum, set:

- `DOMAIN` -- your domain name (e.g., `sync.example.com`)
- `DATABASE_PASSWORD` -- the generated database password
- `SUPER_PASS` -- the generated admin password

## 5. Start the Stack

```bash
docker compose up -d
```

## 6. Verify

Check that all containers are running and healthy:

```bash
docker compose ps
```

All services should show `Up` with a health status of `healthy`.

## Next Steps

- [Configuration](./configuration.md) -- full reference for all environment variables.
- [Admin Dashboard](./admin-dashboard.md) -- manage your instance via the Django admin panel.
