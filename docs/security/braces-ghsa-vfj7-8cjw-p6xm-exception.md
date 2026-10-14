# Verified local remediation: braces GHSA-vfj7-8cjw-p6xm

- Advisory: [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) / CVE-2026-93687,
  "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
  high (CVSS 7.5, CWE-674). Vulnerable `<=3.0.3`; no patched release (`first_patched_version: null`;
  the registry audit reports `patched_versions: "<0.0.0"`).
- Package: `braces@3.0.3` (canonical registry tarball, integrity
  `sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==`),
  patched in this repository through pnpm `patchedDependencies` with `patches/braces@3.0.3.patch`. The
  version stays `3.0.3`; the upstream MIT license and copyright are unchanged. The older
  GHSA-grv7-fg5c-xmjg (`<3.0.3`) rules out any downgrade.
- Disposition: owner-approved and verification-bound, with no expiry. It replaces the former
  time-boxed exception for unpatched code (last expiry `2026-10-14T00:00:00Z`); nothing was renewed.
- Status: the patch, the byte preflight and the disposition are implemented with tests.
  - An earlier local verification ran at commit `20a97d028b9588b12ccdb14cbfb59144fbdb6874`, using
    Node 22.23.3 and pnpm 10.6.5. It covered a frozen install, the live `pnpm run audit:security`,
    lint, type-check, tests, the `core`, `ui` and `web` builds, and the exposure check below. That
    run is historical: it predates the fallback correction described under "The patch".
  - The corrected candidate's local checks are recorded with the pull request evidence.
  - Hosted CI on the corrected head (including the Docker build) and independent code review of it
    are pending; this record does not claim them.

## The patch

`patches/braces@3.0.3.patch` changes only `lib/constants.js`, `lib/parse.js`, `lib/compile.js`,
`lib/expand.js` and `lib/stringify.js`:

- `MAX_DEPTH = 100`. `parse` rejects the 101st open brace or parenthesis block with
  `SyntaxError: Input nesting exceeds max depth (100)`. Escaped characters, bracket classes and quoted
  runs are text and do not count.
- `compile`, `expand` and `stringify` take a depth that starts at 0 for the object passed in and
  throw `RangeError: AST depth exceeds max depth (100)` for a node with `nodes` deeper than 100. This
  also covers ASTs passed straight to `braces.compile`, `braces.expand` and `braces.stringify`, which
  never go through `parse`.
- `expand` hands some nodes to `stringify`: `dollar` or `invalid` nodes, and ranges that
  `fill-range` cannot expand. It passes its current depth along, so the limit stays measured from the
  AST root. `stringify`'s internal start depth honours only positive integers, so it can tighten the
  limit but never loosen it.
- There is no option to raise or disable the limit. `maxLength`, `rangeLimit` and every other option
  behave as before.

Intentional behavior change: more than 100 unclosed openers are now rejected instead of being
treated as text. No reviewed consumer pattern nests more than two levels. A controlled `SyntaxError`
or `RangeError` still fails a caller that does not catch it, as `maxLength` errors always have; the
patch removes the unbounded recursion, not the need to handle errors.

Not covered: hand-built queues or other caller-constructed structures, parent-pointer cycles in
caller-supplied ASTs, and the output volume of large comma expansions.

## What the audit reports

The registry still matches `braces@3.0.3` against `<=3.0.3`, so the raw finding stays in the report and
in the printed counts (`1 high`). `scripts/audit-high-critical.mjs` prints one extra line saying that
this raw finding is locally remediated by the verified patch. It never reports the finding as absent.

The finding counts as remediated only when all of these hold:

- the advisory is exactly GHSA-vfj7-8cjw-p6xm (id and URL), module `braces`, severity `high`,
  `vulnerable_versions` `<=3.0.3`, and `patched_versions` exactly `<0.0.0` (`<0.0.0>` and any real
  version range fail);
- there is exactly one finding, version `3.0.3`, with exactly the eight paths below (no subset,
  duplicate or extra path);
- the high and critical counts reconcile with well-formed findings; malformed reports, registry
  errors, unexpected exit statuses and spawn failures fail as before;
- the byte preflight and then the behavior probe pass for the installed package.

Every other high or critical advisory fails the gate, and so does a failed verification, even when
the report is clean.

## Trust roots and order

Trusted: Node, the reviewed `scripts/braces-byte-preflight.mjs`, and the expected values it contains.
Those values (the normalized patch sha256 and the sha256 of each of the ten tarball files after the
patch) were derived offline from the SHA512-verified tarball plus the reviewed patch. They are never
recomputed from the installed tree. The patch file, the lock, the declaration and `node_modules` are
untrusted inputs that are only read.

`scripts/braces-byte-preflight.mjs` loads no package code. It checks:

- `package.json` declares exactly `braces@3.0.3 → patches/braces@3.0.3.patch`;
- the patch matches the reviewed digest, using pnpm's rule (CRLF → LF, sha256). A patch and lock that
  agree with each other but not with the reviewed digest fail;
- the lock binds that digest and path, keeps the canonical integrity, and holds one patched braces
  snapshot referenced only by `chokidar@3.6.0` and `micromatch@4.0.8`;
- each of the eight consumer chains resolves hop by hop from the parent's entry, with the expected
  versions, to one braces directory;
- that directory holds exactly the ten tarball files as regular files with the reviewed bytes, and
  nothing else (no symlink, no extra name such as an extensionless `lib/compile`, `.json` or `.node`);
- every package-internal `require` resolves, under Node's own rules, to the hashed file.

The behavior probe runs in a bounded child (15 s, exact output) only after the preflight has passed.
It checks rejection at depth 101 and at 4998 through all five APIs, direct-AST rejection at depth 101
(also through `expand`'s `dollar`/`invalid` fallback), and exact depth-100 output. It corroborates behavior and does not replace the byte check.

`pnpm run audit:security` is
`node scripts/braces-byte-preflight.mjs && pnpm run test:dependency-security && node scripts/audit-high-critical.mjs`.
The preflight runs before any test loads braces, and the audit script runs the preflight and probe
again before it reads the registry report.

## Dependency closure

The only importer is `apps/web`. Reviewed paths:

| Path | Consumer role |
| --- | --- |
| `apps/web > @ducanh2912/next-pwa@10.2.9 > fast-glob@3.3.2 > micromatch@4.0.8 > braces@3.0.3` | Webpack/workbox plugin wrapped around `next.config.js`; globs build output during `next build` |
| `apps/web > eslint-config-next@15.5.24 > @next/eslint-plugin-next@15.5.24 > fast-glob@3.3.1 > micromatch@4.0.8 > braces@3.0.3` | Lint only (`next lint`; builds set `ignoreDuringBuilds`) |
| `apps/web > tailwindcss@3.4.19 > chokidar@3.6.0 > braces@3.0.3` | Tailwind watch mode (dev/CLI) |
| `apps/web > tailwindcss@3.4.19 > fast-glob@3.3.3 > micromatch@4.0.8 > braces@3.0.3` | Tailwind content scanning at CSS build |
| `apps/web > tailwindcss@3.4.19 > micromatch@4.0.8 > braces@3.0.3` | Tailwind content scanning at CSS build |
| `apps/web > tailwindcss-animate@1.0.7 > tailwindcss@3.4.19 > …` (3 paths) | Same tailwind instance via plugin peer |

The patterns these tools pass to braces are repository-controlled configuration: the static
`content` globs in `apps/web/tailwind.config.ts`, the next-pwa/workbox defaults and options in
`apps/web/next.config.js`, and eslint-plugin-next settings. `Dockerfile.web` copies `patches/` into
its dependency stage so the frozen install applies the patch there too.

## Runtime boundary

Production web runs `node apps/web/server.js` from `.next/standalone`. After a frozen install and the
Dockerfile build steps (`core`, `ui`, `web`), run:

```sh
node scripts/verify-braces-tooling-exposure.mjs <out-dir> 3e1a0fb1965fc17c8b7d552d8336f3c9d05285ef --runtime-smoke
```

It requires the lock's only braces snapshot to be the patched `braces@3.0.3`, with exactly the eight
paths. It treats `patches/` as a production input. It fails if a standalone file, symlink or
`.nft.json` trace names a consumer package. braces source signatures may appear only in the pinned
`next/dist/compiled/@vercel/nft/index.js` file with its pinned hash. `--runtime-smoke` samples a few
routes and does not prove that no other path loads the chain.

Local result from the earlier `20a97d02` run (historical, before the fallback correction):

- The only locked braces is the patched `braces@3.0.3`, on exactly the eight paths.
- No standalone file (3534 entries) or `.nft.json` trace (34 traces) names a consumer package.
- Both signatures occur only in the pinned nft file, whose hash is unchanged.
- The runtime smoke returned 200 for the five pages, 503 for deployment identity (no deploy env)
  and 404 for an unknown route. No consumer or build-only module was loaded, and there were no
  outbound attempts.

The web build rewrites a tracked PWA fallback file in `apps/web/public`. That file was restored to
its committed bytes before the check, so the committed version was scanned, not the freshly
generated one. This ran on local Node over glibc, not the CI `node:22-alpine` image.

`next@15.5.24` vendors its own unversioned braces copy inside the nft bundle, used for build-time
output tracing. It is not `braces@3.0.3`, is outside this remediation, and is evaluated only for
reachability from the production server.

## Migration and rollback

When the registry reports a patched release (any `patched_versions` other than `<0.0.0`), the gate
fails. Then:

1. Pin an exact override to the patched release.
2. Remove `patches/braces@3.0.3.patch`, its declaration, the preflight and this disposition.
3. Regenerate the lock with pnpm 10.6.5 and have the change reviewed.

Rollback is a reviewed revert. It restores the old time-boxed exception, which accepts the
unpatched finding only before `2026-10-14T00:00:00Z`; at or after that instant the audit fails
closed. No production action is involved.
