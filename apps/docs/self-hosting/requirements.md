# Requirements

Before you begin, make sure you have the following.

## System Requirements

| Requirement | Details |
|---|---|
| **Operating system** | Linux -- Ubuntu 22.04+, Debian 12+, or equivalent. Any system that runs Docker will work. |
| **Docker** | Docker Engine 24+ with Docker Compose v2 (the `docker compose` plugin, not the legacy `docker-compose` binary). |
| **Domain name** | A domain you control (e.g., `sync.example.com`), with the ability to create DNS A records. |
| **Server resources** | Minimum 1 GB RAM, 10 GB disk. More is better if you expect multiple users. |
| **Reverse proxy** | Caddy, nginx, Traefik, Cloudflare Tunnel, or similar -- for TLS termination. |

## Verify Docker Is Installed

```bash
docker --version         # Should show 24.x or higher
docker compose version   # Should show v2.x
```

If Docker is not installed, follow the [official Docker Engine installation guide](https://docs.docker.com/engine/install/).

## DNS Setup

Create an A record pointing your chosen domain to your server's public IP.

For example, if your server IP is `203.0.113.50` and your domain is `sync.example.com`:

| Type | Name | Value |
|---|---|---|
| A | `sync.example.com` | `203.0.113.50` |

Verify it resolves before continuing:

```bash
dig +short sync.example.com
# Should return: 203.0.113.50
```

DNS changes can take minutes to hours to propagate. If you're using a reverse proxy with automatic TLS (like Caddy), the domain must resolve before the proxy can obtain a certificate.
