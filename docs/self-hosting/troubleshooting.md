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

# Specific service (postgres, etebase, web, caddy)
docker compose logs etebase

# Follow logs in real time
docker compose logs -f caddy

# Last 100 lines
docker compose logs --tail 100 web
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
docker compose logs etebase
```

### SSL Certificate Errors

**Symptom:** Browser shows certificate warnings, or Caddy logs show ACME errors.

**Causes and fixes:**

- **DNS not resolving:** Verify both DNS records point to your server with `dig +short your-domain`.
- **Ports blocked:** Caddy needs ports 80 and 443 open for the ACME HTTP-01 challenge. Check your firewall: `sudo ufw status` or `sudo iptables -L -n`.
- **Rate limiting:** Let's Encrypt has [rate limits](https://letsencrypt.org/docs/rate-limits/). If you have hit them, wait before retrying.

### Database Connection Errors

**Symptom:** Etebase logs show "connection refused" or authentication errors.

**Fixes:**

- Confirm PostgreSQL is healthy: `docker compose ps postgres`
- Confirm the passwords in `.env` match what was used when the database was first initialized. If the database volume already exists, changing passwords in `.env` will not update the database. You must either recreate the volume or alter the passwords inside PostgreSQL.
- Confirm the init scripts were copied: `ls ./init-db/`

### "Permission Denied" Errors

**Symptom:** Container logs show file permission errors.

**Fixes:**

- Ensure the data volumes are owned by the correct users. Recreating volumes usually fixes this.
- On SELinux-enabled systems, you may need to add the `:z` flag to volume mounts.

### Etebase Not Accepting Connections

**Symptom:** `https://sync.DOMAIN` returns 502.

**Fix:** The Etebase container can take 20-30 seconds to initialize on first start. Wait, then check:

```bash
docker compose logs etebase
docker compose exec etebase wget -q --spider http://127.0.0.1:3735/ && echo "OK"
```

---

## Restart or Recreate a Service

```bash
# Restart a service
docker compose restart web

# Recreate a service (picks up .env changes)
docker compose up -d --force-recreate web
```
