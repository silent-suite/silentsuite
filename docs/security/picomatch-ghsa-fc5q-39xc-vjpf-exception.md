# Bounded audit exception: picomatch GHSA-fc5q-39xc-vjpf

The owner approved this exception on 2026-11-17, without a local patch, after requiring a review
of the pattern inputs and the production boundary. It accepts one registry finding while those
reviewed conditions hold. The vulnerable package remains installed; this is not a remediation.

## Advisory and release state

[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) / CVE-2026-112366 is a high
severity denial of service advisory affecting picomatch `<=4.0.7`. It concerns repeated extglob
patterns supplied by an attacker. An attacker-controlled path being tested against a fixed,
ordinary glob is a different input boundary.

On 2026-11-17, the npm registry reported 4.0.7 as the latest release and the advisory reported no
patched release. The audit's literal marker was `patched_versions: "<0.0.0"`. The upstream
[leading-question-mark extglob change](https://github.com/micromatch/picomatch/pull/194), linked by
the advisory, was still open and unmerged. Its existence is not evidence of a released security fix.
The lock resolves one version, 4.0.4, under the existing `"picomatch": "^4.0.4"` override.
Upgrading to 4.0.7 would still match the vulnerable range. This change alters no dependency,
override, patch or lockfile bytes.

## Exact registry disposition

`pnpm audit --audit-level=high --json`, using pnpm 10.34.9, returned one finding for 4.0.4, with
exactly this path:

```text
apps__docs>vitepress>vite>picomatch
```

This is the quick endpoint's unversioned form, including its doubled underscore in the importer.
It is not the versioned `apps/docs > vitepress@…` form. The report does not enumerate all the
shared package's dependency paths; the lock closure below supplies that missing check.

The exception in `scripts/audit-high-critical.mjs` requires all of these:

- Exactly GHSA-fc5q-39xc-vjpf and `https://github.com/advisories/GHSA-fc5q-39xc-vjpf`, module
  `picomatch`, severity `high`, vulnerable range `<=4.0.7`, and patched marker `<0.0.0`.
- Exactly one finding, version 4.0.4, with exactly the path above. Missing, duplicate, additional,
  removed, malformed or differently formatted findings and paths fail.
- Exactly one picomatch advisory. Another picomatch record, including one of lower severity or a
  duplicate, fails. Other high or critical advisories still fail.
- Exact reconciliation of the report's high and critical counts with its findings, as for braces.
- The reviewed lock closure passes. The existing braces byte verification and behavior probe must
  also pass, even if the registry no longer reports the braces advisory.

The raw count remains visible. The additional log line says "Raw finding accepted as an exception"
and names the GHSA. It does not describe picomatch as patched. Braces retains its separate verified
patch disposition and log wording.

## Dependency paths and pattern inputs

`pnpm why picomatch -r` and a parsed reverse traversal of `pnpm-lock.yaml` established 78 unique
versioned paths, preserving each importer's dependency kind. The complete reviewed list is
[`picomatch-reviewed-paths.json`](../../scripts/test-fixtures/audit-high-critical/picomatch-reviewed-paths.json).
Peer-resolution suffixes are omitted from display paths; package versions and every consumer hop
remain explicit. The table groups those paths by entry point; every listed suffix ends at
`picomatch@4.0.4`.

| Entry point and downstream paths | Role | Pattern source |
| --- | --- | --- |
| `apps/docs` dev dependency `vitepress@1.6.4`, directly or through `@vitejs/plugin-vue@5.2.4`, then `vite@6.4.5`, directly or through `fdir@6.5.0` / `tinyglobby@0.2.17` | Docs build and development server | VitePress/Vite build defaults, repository imports and configuration; the published docs are static output |
| `apps/web` dependency `@ducanh2912/next-pwa@10.2.9` → `fast-glob@3.3.2` → `micromatch@4.0.8` | PWA asset discovery during the Next build | Plugin asset globs and options from `next.config.js` |
| The same PWA entry → `workbox-build@7.1.1`, or `workbox-webpack-plugin@7.1.0` → `workbox-build@7.1.0` → Rollup Babel/replace/node-resolve plugins → `@rollup/pluginutils@3.1.0` or `5.3.0` | Service worker compilation | Rollup include/exclude filters supplied by Workbox's bundler; the matcher is a build dependency, not a Workbox runtime cache rule |
| `apps/web` dependency `@sentry/nextjs@10.75.2` → `@rollup/plugin-commonjs@28.0.1`, directly or through `@rollup/pluginutils@5.3.0` / `fdir@6.5.0` | Webpack wrapping loader | CommonJS plugin options in Sentry's `config/loaders/wrappingLoader.js`; source modules are build inputs. The app also disables automatic server, middleware and app-directory wrapping |
| `apps/web` dependency `next-intl@4.13.0` → `@parcel/watcher@2.5.6` | Development extraction watcher | `SourceFileWatcher` constructs ignore globs from its fixed ignored-directory list. The app passes only `./i18n/request.ts` to the Next plugin and does not enable experimental extraction |
| `apps/web` dev dependency `eslint-config-next@15.5.29` → Next lint / TypeScript ESLint parser and utilities / import resolver chains → `fast-glob@3.3.1` → `micromatch@4.0.8`, or `tinyglobby@0.2.17` directly / through `fdir@6.5.0` | Lint and TypeScript project discovery | Repository lint/TypeScript configuration and package defaults |
| `apps/web` dev dependency `tailwindcss@3.4.19`, directly or through `tailwindcss-animate@1.0.7` → `micromatch@4.0.8`, `fast-glob@3.3.3`, `chokidar@3.6.0` → `anymatch@3.1.3` / `readdirp@3.6.0`, or `sucrase@3.35.1` → `tinyglobby@0.2.17` / `fdir@6.5.0` | CSS scanning, watch mode and configuration compilation | Three literal content globs in `tailwind.config.ts`, watch filters and build defaults |
| `apps/web` dev dependencies `vite@8.1.6`, `@vitejs/plugin-react@6.0.2`, `vitest@4.1.12`; `packages/core` dev dependency `vitest@4.1.12`; downstream Vite, `@vitest/mocker@4.1.12`, `tinyglobby@0.2.17` and `fdir@6.5.0` | Test discovery, transforms and local development | Repository Vitest include patterns, source import globs and tool defaults |

The source review found no application import of picomatch, micromatch, fast-glob, tinyglobby or
Parcel's watcher. It traced the production-declared PWA, Sentry and next-intl chains to build or
development entry points, rather than treating the dependency declaration as proof of runtime use.
Repository source and build configuration are trusted inputs here. Running builds or development
servers against hostile repository content is outside this exception's production-input claim.

`scripts/verify-picomatch-tooling-exposure.mjs` compares the current complete lock closure with the
78 reviewed paths and requires a single 4.0.4 snapshot. A new direct, transitive or optional consumer,
a changed version, a removed path, or an importer moving from development to runtime dependencies
fails even if the registry still returns only its docs path. The audit invokes this check before
accepting picomatch; its regression cases run in the existing dependency-security suite.

## Next's vendored matcher and the shipped image

Next 15.5.29 also vendors `next/dist/compiled/picomatch`. That copy is separate from the locked npm
package and is not covered by the registry exception. It may be included and loaded by the
production server. The existing exposure tests explicitly allow that compiled path.

The installed Next source imports it in `shared/lib/match-local-pattern.js` and
`match-remote-pattern.js`. `makeRe` receives configured `pathname` and `hostname` patterns; the
request URL supplies the string tested by the resulting regex. This app has no `images` pattern
overrides: Next defaults to `localPatterns: undefined` and `remotePatterns: []`. Neither path
compiles a request-supplied glob. The app's middleware matchers are the literals `/admin` and
`/admin/:path*`; Next compiles those at build time, and `middleware-route-matcher.js` executes their
stored regexes at runtime. They do not pass request text to picomatch as a pattern.

Next's vendored `@vercel/nft` also contains matching code for build-time output tracing. The existing
image verifier pins that bundle's bytes and rejects loading its build-only entry points during the
runtime smoke. Neither vendored copy is claimed to be patched by this exception.

`Dockerfile.web` copies only standalone output, static assets and public files into the runtime
stage. `scripts/verify-web-image.mjs` uses the existing exposure checks against the built image and
its sampled server module record. Those checks now also reject a separately packaged picomatch
file or symlink; the Next compiled copy remains permitted. This catches the unbundled locked package
surviving tracing, but is not a general detector for picomatch in arbitrary minified bundles.

Local verification covered the frozen install, source and lock inspection, dependency-security tests
and the live audit. The unchanged base audit failed on this finding after its dependency tests
passed. Docker/web image builds and their runtime smoke are CI-only on this host and were not run
locally. The image gate must pass on the final candidate before integration. No claim is made here
about the bytes of an already deployed image or exhaustive execution of every server path.

## Ending the exception

There is no calendar expiry. A registry report announcing any patched range other than `<0.0.0`,
a changed vulnerable range, another picomatch advisory, different installed version, changed registry
path set, or changed lock closure fails the gate and requires a new decision. Published-fix detection
uses the registry's advisory metadata; it does not independently infer security fixes from release
numbers. When a fixed version is available, update the dependency through the normal reviewed
process and remove this exception.

A source change that introduces request-controlled patterns also invalidates the exposure reasoning,
even if the lock graph is unchanged. The lock check cannot prove source-level data flow; reviewers
must revisit that boundary for such changes. A reviewed revert removes this exception and restores
the failing audit for the current vulnerable version. No deployment is part of this change.
