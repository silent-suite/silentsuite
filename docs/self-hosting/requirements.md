# Requirements

Before you begin, make sure you have the following.

## System Requirements

| Requirement | Details |
|---|---|
| **Operating system** | Linux -- Ubuntu 22.04+, Debian 12+, or equivalent. Any system that runs Docker will work. |
| **Docker** | Docker Engine 24+ with Docker Compose v2 (the `docker compose` plugin, not the legacy `docker-compose` binary). |
| **Domain name** | A domain you control, with the ability to create DNS records. |
| **Server resources** | Minimum 2 GB RAM, 10 GB disk. More is better if you expect multiple users. |
| **Open ports** | Ports 80 and 443 must be reachable from the internet (required for Let's Encrypt certificate provisioning). |

## Verify Docker Is Installed

```bash
docker --version         # Should show 24.x or higher
docker compose version   # Should show v2.x
```

If Docker is not installed, follow the [official Docker Engine installation guide](https://docs.docker.com/engine/install/).

## DNS Setup

SilentSuite uses two subdomains. Point both to your server's public IP address.

If your server IP is `203.0.113.50` and your domain is `silentsuite.example.com`, create these DNS records:

| Type | Name | Value |
|---|---|---|
| A | `silentsuite.example.com` | `203.0.113.50` |
| A | `sync.silentsuite.example.com` | `203.0.113.50` |

Alternatively, create one A record for the apex and one CNAME:

| Type | Name | Value |
|---|---|---|
| A | `silentsuite.example.com` | `203.0.113.50` |
| CNAME | `sync.silentsuite.example.com` | `silentsuite.example.com` |

**Important:** DNS changes can take minutes to hours to propagate. Caddy will fail to obtain TLS certificates if the records do not resolve to your server. Verify propagation before proceeding:

```bash
dig +short silentsuite.example.com
dig +short sync.silentsuite.example.com
```

Both should return your server's IP.
