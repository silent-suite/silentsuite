# Manual Setup

If you prefer full control over the configuration, follow these steps instead of running `install.sh`. Make sure you've met the [requirements](./requirements.md) first.

## 1. Clone the Repository

```bash
git clone https://github.com/silent-suite/silentsuite.io.git
cd silentsuite.io/self-host
```

## 2. Copy the Database Init Scripts

The PostgreSQL container needs initialization scripts to create the required schemas and users on first boot:

```bash
cp -r ../deploy/init-db ./init-db
```

## 3. Create the Environment File

```bash
cp .env.example .env
```

## 4. Generate Secrets

Generate the passwords that `.env` requires:

```bash
POSTGRES_PASSWORD=$(openssl rand -base64 32)
ETEBASE_DB_PASSWORD=$(openssl rand -base64 32)
ETEBASE_ADMIN_PASSWORD=$(openssl rand -base64 32)
```

## 5. Edit .env

Open `.env` in your editor and fill in all required values. See the [Configuration Reference](./configuration.md) for details on each variable.

At minimum, set:

- `DOMAIN` -- your domain name
- `POSTGRES_PASSWORD` -- the generated password
- `ETEBASE_DB_PASSWORD` -- the generated password
- `ETEBASE_ADMIN_USER` and `ETEBASE_ADMIN_PASSWORD`

## 6. Update the Database Init Script Passwords

The init script at `./init-db/01-create-roles-and-schemas.sql` contains placeholder passwords that must match your `.env` values. Replace them:

```bash
sed -i "s/PLACEHOLDER_ETEBASE_DB_PASSWORD/$ETEBASE_DB_PASSWORD/" ./init-db/01-create-roles-and-schemas.sql
```

## 7. Start the Stack

```bash
docker compose up -d
```

## 8. Verify

Check that all containers are running and healthy:

```bash
docker compose ps
```

All services should show `Up` with a health status of `healthy`.

## Next Steps

- [Configuration](./configuration.md) -- full reference for all environment variables.
- [Admin Dashboard](./admin-dashboard.md) -- manage your instance from the browser.
