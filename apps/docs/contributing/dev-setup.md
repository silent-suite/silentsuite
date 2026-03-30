# Development Setup

Get a local SilentSuite development environment running. You should be able to go from `git clone` to a working dev server in under 15 minutes.

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| **Node.js** | 18+ | [nodejs.org](https://nodejs.org/) |
| **pnpm** | 10.6+ | `corepack enable && corepack prepare pnpm@latest --activate` |
| **Docker** | 24+ | [docs.docker.com](https://docs.docker.com/engine/install/) (for running services locally) |

## 1. Clone the Repository

```bash
git clone https://github.com/silent-suite/silentsuite.git
cd silentsuite
```

## 2. Install Dependencies

```bash
pnpm install
```

This installs dependencies for all packages in the monorepo.

## 3. Run the Dev Server

```bash
pnpm dev
```

This starts all apps in development mode using [Turborepo](https://turbo.build/).

## Monorepo Structure

SilentSuite is a pnpm monorepo managed by Turborepo:

```
silentsuite/
  apps/
    landing/         # Landing page and blog (Next.js)
    web/             # Main web application (Next.js)
    docs/            # Documentation (you are here)
  android/           # Kotlin Android sync adapter
  bridge/            # CalDAV/CardDAV bridge daemon
  packages/          # Shared packages
  self-host/         # Self-hosting configuration (Docker Compose)
  deploy/            # Deployment scripts and configuration
```

## Available Commands

| Command | Description |
|---|---|
| `pnpm dev` | Start all apps in development mode |
| `pnpm build` | Build all apps |
| `pnpm lint` | Lint all packages |
| `pnpm test` | Run all tests |
| `pnpm type-check` | Run TypeScript type checking |

## Troubleshooting

### `pnpm install` fails

Make sure you're using the correct pnpm version (10.6+). Run `corepack enable` first.

### Port conflicts

The dev server uses port 3000 by default. If that's in use, check which app is occupying it or configure a different port.
