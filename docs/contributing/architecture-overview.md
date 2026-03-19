# Architecture Overview

How SilentSuite is structured and how the pieces fit together.

## High-Level Architecture

SilentSuite is a privacy-focused productivity suite built on the [Etebase protocol](https://www.etebase.com/) for end-to-end encrypted synchronization.

```
Client Devices                    Server
+------------------+         +------------------+
|  Web / Mobile    |         |  Caddy (HTTPS)   |
|                  |         +--------+---------+
|  Encrypt locally |                  |
|  using Etebase   |         +--------+---------+
|  protocol        | ------> |  Etebase Server  |
|                  |         |  (encrypted sync)|
|  Decrypt locally |         +--------+---------+
|                  |                  |
+------------------+         +--------+---------+
                             |  PostgreSQL      |
                             |  (stores blobs)  |
                             +------------------+
```

All encryption and decryption happens on the client. The server only ever sees ciphertext.

## Monorepo Structure

The repository is a pnpm monorepo managed by Turborepo:

| Directory | Purpose |
|---|---|
| `apps/landing/` | Marketing site and blog (Next.js, deployed to Cloudflare Workers) |
| `apps/web/` | Main web application (Next.js) |
| `packages/` | Shared packages used across apps |
| `self-host/` | Docker Compose configuration for self-hosting |
| `deploy/` | Deployment scripts, init scripts, runbooks |
| `docs/` | Documentation |

## Tech Stack

| Component | Technology |
|---|---|
| **Frontend** | Next.js 15, React, Tailwind CSS |
| **Server** | Etebase protocol (Python), Docker |
| **Database** | PostgreSQL 16 |
| **Reverse Proxy** | Caddy (automatic TLS) |
| **Encryption** | XChaCha20-Poly1305, Argon2 (via Etebase) |
| **Monorepo** | pnpm workspaces, Turborepo |
| **Hosting** | EU cloud infrastructure, Cloudflare Workers |

## Key Design Principles

1. **Encryption is the architecture, not a feature.** There is no unencrypted mode. Everything is E2EE by default.
2. **Open source by default.** All code is open. The encryption can be audited.
3. **No lock-in.** Standard Etebase protocol, not proprietary formats. Export anytime, self-host if you want.
4. **EU-hosted, GDPR-compliant.** Your encrypted data stays in the EU. GDPR as a baseline.
