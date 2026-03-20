# Admin Panel

The SilentSuite server includes a built-in admin panel for managing your instance.

## Accessing the Admin Panel

The admin panel is available at `https://your-domain.com/admin/`. Log in with the `SUPER_USER` and `SUPER_PASS` credentials from your `.env` file.

## Features

The admin panel allows you to:

- **Manage user accounts** -- view, create, and delete user accounts.
- **View collections** -- inspect the encrypted data collections stored on your server.
- **Monitor database state** -- review the internal state of the server.

## Feature Access

In self-hosted mode, all features are unlocked for every user on the instance. There are no subscription tiers or feature gates. Every account has full access to the complete SilentSuite feature set.

## Creating Additional Admin Users

```bash
docker exec -it silentsuite-server python manage.py createsuperuser
```

Follow the prompts to create a new admin account.
