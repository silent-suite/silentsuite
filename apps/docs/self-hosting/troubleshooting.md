# Troubleshooting

Common issues and how to fix them.

## Check Service Status

```bash
docker compose ps
```

Both `silentsuite-postgres` and `silentsuite-server` should show `Up (healthy)`.

## View Logs

```bash
# All services
docker compose logs

# Specific service
docker compose logs server
docker compose logs postgres

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

**Fix:** Check the logs for the failing service:

```bash
docker compose logs server
docker compose logs postgres
```

The most common cause is a misconfigured `.env` file (missing or incorrect passwords).

### Server Returns 400 Bad Request

**Symptom:** Requests to your domain return `400 Bad Request` or "Invalid HTTP_HOST header".

**Fix:** Your domain is not in `ALLOWED_HOSTS`. Edit `.env` and add it:

```bash
ALLOWED_HOSTS=sync.example.com,localhost
```

Then recreate the server container:

```bash
docker compose up -d --force-recreate server
```

### TLS / Certificate Errors

**Symptom:** Browser shows certificate warnings when accessing your domain.

**Causes:**
- **DNS not resolving:** Verify with `dig +short your-domain.com`.
- **Reverse proxy misconfigured:** Make sure it forwards to `localhost:3735`.
- **Ports blocked:** If using Caddy or certbot, ports 80 and 443 must be open: `sudo ufw status`.
- **Let's Encrypt rate limits:** If you've hit them, wait before retrying.

### Database Connection Errors

**Symptom:** Server logs show "connection refused" or authentication errors.

**Fixes:**

- Confirm PostgreSQL is healthy: `docker compose ps postgres`
- Confirm `DATABASE_PASSWORD` in `.env` matches what was used when the database was first initialized. If the database volume already exists, changing the password in `.env` alone won't update the database. You must either recreate the volume (`docker compose down -v` -- **this deletes all data**) or alter the password inside PostgreSQL.

### Server Takes a Long Time to Start

**Symptom:** Server shows `starting` health status for over a minute.

**Fix:** On first start, the server runs database migrations and collects static files. This can take 30-60 seconds. Check progress with:

```bash
docker compose logs -f server
```

If it's still not healthy after 2 minutes, check the logs for errors.

### "Permission Denied" Errors

**Symptom:** Container logs show file permission errors on the data volume.

**Fixes:**

- Recreating volumes usually resolves this: `docker compose down -v && docker compose up -d` (**deletes all data**).
- On SELinux-enabled systems, add the `:z` flag to volume mounts in `docker-compose.yml`.

### Cannot Connect from the Web App

**Symptom:** app.silentsuite.io shows a connection error when you enter your server URL.

**Fixes:**

- Make sure the URL starts with `https://` (not `http://`).
- Test from outside your server: `curl -s https://your-domain.com/`.
- Check that your reverse proxy is running and forwarding to port 3735.
- Check your firewall allows inbound traffic on port 443.

---

## Restart or Recreate a Service

```bash
# Restart a service (keeps same container)
docker compose restart server

# Recreate a service (picks up .env changes)
docker compose up -d --force-recreate server
```

## Reset Everything

```bash
# WARNING: This deletes ALL data (users, encrypted sync data, everything)
docker compose down -v
./install.sh
```
