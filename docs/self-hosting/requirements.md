# Requirements

Before you begin, make sure you have the following.

## System Requirements

| Requirement | Details |
|---|---|
| **Operating system** | Linux -- Ubuntu 22.04+, Debian 12+, or equivalent. Any system that runs Docker will work. |
| **Docker** | Docker Engine 24+ with Docker Compose v2 (the `docker compose` plugin, not the legacy `docker-compose` binary). |
| **Domain name** | A domain you control, with the ability to create DNS A records. |
| **Server resources** | Minimum 1 GB RAM, 10 GB disk. More is better if you expect multiple users. |
| **Reverse proxy** | A reverse proxy you control (Caddy, nginx, Traefik, Cloudflare Tunnel) to terminate TLS in front of the SilentSuite server. The stack itself does not include one. |
| **Open ports** | Whichever ports your reverse proxy needs reachable from the internet — typically 443 (and 80 for ACME HTTP-01 challenges if your proxy provisions Let's Encrypt certificates). |

## Verify Docker Is Installed

```bash
docker --version         # Should show 24.x or higher
docker compose version   # Should show v2.x
```

If Docker is not installed, follow the [official Docker Engine installation guide](https://docs.docker.com/engine/install/).

## DNS Setup

Create one A record pointing to your server's public IP address.

If your server IP is `203.0.113.50` and your chosen domain is `sync.example.com`:

| Type | Name | Value |
|---|---|---|
| A | `sync.example.com` | `203.0.113.50` |

**Important:** DNS changes can take minutes to hours to propagate. Whatever reverse proxy you use will fail to obtain TLS certificates if the record does not resolve to your server. Verify propagation before proceeding:

```bash
dig +short sync.example.com
```

This should return your server's IP.
