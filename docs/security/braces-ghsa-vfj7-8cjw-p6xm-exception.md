# Temporary audit exception: braces GHSA-vfj7-8cjw-p6xm

- Advisory: [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) / CVE-2026-93687,
  "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
  high (CVSS 7.5, CWE-674). Vulnerable `<=3.0.3`; no patched version (`first_patched_version: null`).
- Package: `braces@3.0.3` only (latest npm release; integrity
  `sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==`).
  The older GHSA-grv7-fg5c-xmjg (`<3.0.3`) rules out any downgrade and is not excepted.
- Expiry: `2026-10-10T00:00:00Z`. At or after that instant the gate fails again.
- Scope: owner-approved, conditional on tooling-only exposure and independent review.

## Exception contract

`scripts/audit-high-critical.mjs` skips an advisory only when all of these hold: the clock is
before expiry; `github_advisory_id` and `url` name GHSA-vfj7-8cjw-p6xm; `module_name` is
`braces`; severity is `high`; `vulnerable_versions` is `<=3.0.3`; every finding is version
`3.0.3`; every finding path is one of the eight reviewed paths below. Report validation,
metadata count checks, malformed/unreachable-registry handling and every other advisory are
unchanged. A new dependency edge to braces, another braces version or advisory, or a widened
range fails the gate.

## Dependency closure (pnpm 10.6.5 frozen lock at ba79f64b)

The only importer is `apps/web`. Live `pnpm audit --json` paths:

| Path | Consumer role |
| --- | --- |
| `apps/web > @ducanh2912/next-pwa@10.2.9 > fast-glob@3.3.2 > micromatch@4.0.8 > braces@3.0.3` | Webpack/workbox plugin wrapped around `next.config.js`; globs build output during `next build` |
| `apps/web > eslint-config-next@15.5.24 > @next/eslint-plugin-next@15.5.24 > fast-glob@3.3.1 > micromatch@4.0.8 > braces@3.0.3` | Lint only (`next lint`; builds set `ignoreDuringBuilds`) |
| `apps/web > tailwindcss@3.4.19 > chokidar@3.6.0 > braces@3.0.3` | Tailwind watch mode (dev/CLI) |
| `apps/web > tailwindcss@3.4.19 > fast-glob@3.3.3 > micromatch@4.0.8 > braces@3.0.3` | Tailwind content scanning at CSS build |
| `apps/web > tailwindcss@3.4.19 > micromatch@4.0.8 > braces@3.0.3` | Tailwind content scanning at CSS build |
| `apps/web > tailwindcss-animate@1.0.7 > tailwindcss@3.4.19 > …` (3 paths) | Same tailwind instance via plugin peer |

No repository source imports braces, micromatch, fast-glob or chokidar directly; only
`apps/web/next.config.js` (next-pwa) and `apps/web/tailwind.config.ts` (tailwind types and the
animate plugin) reference these consumers.

## Inputs reaching braces

braces expands glob *patterns*. In every path above the patterns are repository-controlled
configuration: the static `content` globs in `apps/web/tailwind.config.ts`, next-pwa/workbox
defaults plus the static options in `apps/web/next.config.js`, and eslint-plugin-next settings.
Matched subjects are repository and build-output file paths. Someone able to change these
values already controls the build, so the advisory adds no capability for them.

## Runtime boundary

Production web runs `node apps/web/server.js` from `.next/standalone` (`Dockerfile.web`,
`output: 'standalone'`). A local production build with the Dockerfile build commands
(`core`, `ui`, then `web`) completed, and neither `.next/standalone/node_modules` nor any
`.next/**/*.nft.json` trace contains braces, micromatch, fast-glob, chokidar, tailwindcss,
next-pwa or eslint-plugin-next. Static assets are prebuilt CSS/JS. The vulnerable package is
therefore not shipped in, or loaded by, the production server.

## Proof limits

- Exposure was proved for the lock at the base commit above. The path allowlist makes the
  gate fail if the graph changes, but a new consumer still needs a fresh review.
- The trace was a local Linux build (Node 26, pnpm 10.6.5), not the CI `node:22-alpine` image.
  The trace inputs are the same lock and config, but CI's Docker build has not been inspected
  for this commit.
- `next` vendors its own precompiled glob helpers under `next/dist/compiled`. They are outside
  the pnpm audit graph and this advisory record, and this exception neither covers nor
  evaluates them.
- Malicious repository changes (a crafted tailwind/next-pwa glob) can crash a build. That is
  build-time availability under the control of whoever already controls the build, not a
  production exposure.

## Expiry remediation

Before `2026-10-10T00:00:00Z`:

1. Check for a patched braces release: `npm view braces versions --json` and the GHSA record.
2. If a patched `3.x` exists, add an exact override such as
   `"braces@<=3.0.3": "<patched>"` in root `package.json` `pnpm.overrides`, regenerate the
   lock with pnpm 10.6.5, frozen-install, then remove `bracesException`, `isExcepted`, the
   braces fixture/tests and this document, keeping the consumer smoke test with the new version.
3. If no patch exists, do **not** extend the date silently. Re-run this exposure analysis and
   get fresh owner approval and independent review for a new expiry, or remove the consumers
   (for example tailwind/next-pwa/eslint-config-next upgrades that drop micromatch/braces) as a
   separately approved change.
