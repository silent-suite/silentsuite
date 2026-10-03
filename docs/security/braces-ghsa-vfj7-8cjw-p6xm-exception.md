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
`3.0.3`; the single finding reports exactly the eight reviewed paths below (no subset,
duplicate or extra path). Report validation, malformed/unreachable-registry handling and every
other advisory are unchanged. A new dependency edge to braces, a removed edge, another braces
version or advisory, or a widened range fails the gate.

Count reconciliation: pnpm 10.6.5 (`dist/pnpm.cjs`, `audit()`) POSTs the lockfile audit tree to
the registry's `/-/npm/v1/security/audits`, returns the registry JSON, and only rewrites finding
paths from the lockfile (`extendWithDependencyPaths`); it never recomputes
`metadata.vulnerabilities` (`ignoreGhsas`/`ignoreCves` drop advisories without touching it, and
this repo configures neither). The live report counts one vulnerability per (advisory, installed
version) finding: moderate is 8 for 5 advisories with 8 findings (41 paths), high is 1 for 1
finding (8 paths), low is 4 for 4. Whenever the braces advisory is present, the wrapper therefore
requires the high and critical counts to equal their well-formed, version-unique findings before
anything is excepted; any excess, deficit or malformed finding fails the gate.

## Dependency closure (pnpm 10.6.5 frozen lock, unchanged from ba79f64b)

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

## Runtime boundary (reproducible check)

Production web runs `node apps/web/server.js` from `.next/standalone` (`Dockerfile.web`,
`output: 'standalone'`) with `.next/static` and `public` copied beside it. Reproduce with a
frozen install, the Dockerfile build steps (`core`, `ui`, `web`), then:

```sh
node scripts/verify-braces-tooling-exposure.mjs <out-dir> [compare-ref]
```

The script is read-only and bounded (100k entries per walk, 64 MiB per scanned file; larger files
fail the check). It exits 1 unless all of these hold, and writes `summary.json` plus
`standalone-inventory.tsv` (every standalone file with size and sha256, every symlink target):

- production inputs (`Dockerfile.web`, root manifests/lock, `apps/web`, `packages`) are clean at
  HEAD; HEAD, tree, a digest of their index entries, and the Node/pnpm versions are recorded;
- repository imports/requires of any consumer package occur only in `apps/web/next.config.js`,
  `apps/web/tailwind.config.ts` and `scripts/`;
- the reverse closure of every locked braces snapshot, parsed from `pnpm-lock.yaml` independently
  of the registry, is exactly `braces@3.0.3` and exactly the eight reviewed paths, and records each
  importer entry point with its dependency type;
- no standalone file path or symlink target, and no entry of any `.next/**/*.nft.json` trace,
  names braces, micromatch, fast-glob, chokidar, tailwindcss(-animate), next-pwa,
  eslint-config-next or eslint-plugin-next;
- braces source string literals (`exceeds max characters (`, `rangeLimit`) occur in no standalone,
  `.next/static` or `public` file except the single pinned file
  `node_modules/.pnpm/next@15.5.24_…645be988d9e529a02f3844286daf8410/node_modules/next/dist/compiled/@vercel/nft/index.js`
  with sha256 `19e4e6ea76d56deed0da625b0d9cbe5f5a761cf87a1c502bbb09c9406a70527e`; a changed bundle,
  another `next/dist/compiled` file or any app chunk fails (`scripts/verify-braces-tooling-exposure.test.mjs`,
  run by `pnpm run audit:security`);
- with `--runtime-smoke`, see below.

The name checks cover what the server can `require` from disk. The signature check covers code
inlined into bundles by webpack, which carries no package name; it relies on minifiers preserving
string literals and default property names, which is true for the build's Terser/SWC settings but
would not detect deliberately obfuscated copies.

Recorded result for the merged candidate (HEAD `596b3533`, tree `58ebbee1`, production input
digest `e27be868…5db8`, local Node 26.7.0 / pnpm 10.6.5): 3534 standalone entries (inventory
sha256 `86633134…394b`), 34 traces with 8758 entries, no consumer paths or trace hits; both
signature hits are the pinned nft file and hash. Evidence directory:
`~/.hermes/cache/scratch/braces-evidence-596b3533-final/` (`summary.json`,
`standalone-inventory.tsv`, `runtime-smoke/`). The only recorded failure is the uncommitted
`package.json` test-wiring line, a production input; re-run on the committed candidate.

## Vendored braces copy inside Next (outside this exception)

`next@15.5.24` ships `next/dist/compiled/@vercel/nft/index.js` (pinned above), which bundles a
braces copy as an internal webpack module. Its constants use `MAX_LENGTH: 1024 * 64`, whereas
`braces@3.0.3` `lib/constants.js` uses `10000`, so it is not 3.0.3 source; its version cannot be
determined (the vendored `package.json` carries no version). It is outside the pnpm audit graph
and this exception; no claim is made here about which advisories apply to it. Source-level load
chain in the standalone tree (`S` = `node_modules/.pnpm/next@15.5.24_…/node_modules/next/dist`):

1. `apps/web/server.js` sets `NODE_ENV=production` and calls `startServer({ isDev: false, … })`.
2. `S/server/lib/start-server.js:180` destructures `isDev`; `:366-374` passes it to
   `getRequestHandlers` (`:164`), which calls `initialize({ …, dev: isDev })` (`:170`).
3. `S/server/lib/router-server.js:100` `initialize(opts)`; the only require of
   `./router-utils/setup-dev-bundler` is inside `if (opts.dev)` (`:122`, `:129`).
4. `setup-dev-bundler` → `server/dev/hot-reloader-webpack` → `build/webpack-config`, which lazily
   requires `build/webpack/plugins/next-trace-entrypoints-plugin` only when building a production
   node server (`isNodeServer && !dev`, `:1641`); that plugin is the only requirer of the nft bundle
   (`:29`). A quote-insensitive search of `S` for `webpack-config`, `next-trace-entrypoints-plugin`
   and `@vercel/nft` finds only build/dev files (`create-compiler-aliases`, `handle-externals`,
   `webpack-config`, `blocks/images`, the plugin, `hot-reloader-webpack`, nft's own `package.json`).
5. Inside the bundle, braces (module 8333) is required once, by its micromatch module; nft calls
   micromatch only via `isMatch` when `ignore` is an array, and Next passes an `ignore` function
   built with `next/dist/compiled/picomatch`.

### Runtime smoke (corroboration only)

`--runtime-smoke` starts the standalone `server.js` with a sanitized environment (PATH, a temporary
HOME, `NODE_ENV=production`, loopback host, free port, telemetry off; no `.env` files exist in the
standalone app), preloads a recorder that logs every resolved module and refuses non-loopback
sockets/fetches, requests `/`, `/login`, `/offline`, `/calendar`, `/settings`,
`/api/deployment-identity` and an unknown route with a 10 s timeout each, then SIGTERMs (SIGKILL
after 10 s) and removes the temporary HOME. Only status codes and module paths are stored.
Result: 200 for the five pages, 503 for deployment identity (no deploy env), 404 for the unknown
route; no outbound attempts; no module from the chain above (or any consumer package) was loaded.
This samples a few routes and does not prove that no other path loads the chain; the
source-level chain above is the proof.

The only importer entry point declared as a production dependency is
`@ducanh2912/next-pwa`. It is required by `next.config.js`, a build-time wrapper; the standalone
inventory and traces show neither it nor fast-glob/micromatch/braces in the runtime output.

## Proof limits

- Exposure was proved for the lock at the candidate above. The exact path-set match makes the
  gate fail if the graph changes in either direction, and a new consumer needs a fresh review.
- The artifact check and runtime smoke ran on a local Linux build (Node 26), not the CI
  `node:22-alpine` Docker image. The gating above is plain JavaScript in `next@15.5.24`, pinned by
  lock integrity and identical in both, and `Dockerfile.web` runs the same `server.js`. The Alpine
  image's standalone inventory has not been inspected: preview run 37103603984 (job 111147749712)
  built it at `b797bab4` without listing contents. Between `b797bab4` and this candidate only
  `apps/web` billing/settings source and tests changed.
- The source chain was read for the static requires listed; computed requires are not provable by
  search. The runtime smoke corroborates but samples only the listed routes.
- The vendored nft braces copy is outside this exception; its version and advisory status are
  unknown, and it is evaluated here only for reachability from the production server.
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
