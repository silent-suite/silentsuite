# Troubleshooting

Common issues and how to fix them.

## Check Service Status

```bash
docker compose ps
```

All services should show `Up (healthy)`. If a service shows `Up (unhealthy)` or is restarting, check its logs.

## View Logs

```bash
# All services
docker compose logs

# Specific service (postgres, server)
docker compose logs server

# Follow logs in real time
docker compose logs -f server

# Last 100 lines
docker compose logs --tail 100 server
```

## Run the Verification Script

```bash
./verify.sh
```

---

## Common Issues

### Services Fail to Start

**Symptom:** `docker compose ps` shows containers in a restart loop.

**Fix:** Check the logs for the failing service. The most common cause is a misconfigured `.env` file:

```bash
docker compose logs postgres
docker compose logs server
```

### SSL Certificate Errors

**Symptom:** Browser shows certificate warnings, or your reverse proxy logs ACME errors.

TLS is your reverse proxy's responsibility — these are not SilentSuite-server problems. Common causes:

- **DNS not resolving:** Verify your DNS record points to your server with `dig +short your-domain.com`.
- **Ports blocked:** Your reverse proxy needs the relevant ports open (typically 80 for the ACME HTTP-01 challenge and 443 for HTTPS). Check your firewall: `sudo ufw status` or `sudo iptables -L -n`.
- **Rate limiting:** Let's Encrypt has [rate limits](https://letsencrypt.org/docs/rate-limits/). If you have hit them, wait before retrying.
- **Wrong upstream:** Confirm the proxy is forwarding to `127.0.0.1:3735` and that the SilentSuite server container is healthy (`docker compose ps`).

### Database Connection Errors

**Symptom:** Server logs show "connection refused" or authentication errors.

**Fixes:**

- Confirm PostgreSQL is healthy: `docker compose ps postgres`
- Confirm the `DATABASE_PASSWORD` in `.env` matches what was used when the database was first initialized. If the database volume already exists, changing the password in `.env` will not update the database. You must either recreate the volume or alter the password inside PostgreSQL.

### "Permission Denied" Errors

**Symptom:** Container logs show file permission errors.

**Fixes:**

- Ensure the data volumes are owned by the correct users. Recreating volumes usually fixes this.
- On SELinux-enabled systems, you may need to add the `:z` flag to volume mounts.

### Server Not Accepting Connections

**Symptom:** `https://your-domain.com` returns 502.

**Fix:** The SilentSuite server can take 20-30 seconds to initialize on first start (database migrations, static files). Wait, then check:

```bash
docker compose logs server
```

---

## Restart or Recreate a Service

```bash
# Restart a service
docker compose restart server

# Recreate a service (picks up .env changes)
docker compose up -d --force-recreate server
```
