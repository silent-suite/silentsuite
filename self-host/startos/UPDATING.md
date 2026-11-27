# Updating the SilentSuite images

1. Pick the released SilentSuite tag `vX.Y.Z[-pre]` (a published GitHub release).
2. Look up the multi-arch index digests of
   `ghcr.io/silent-suite/silentsuite-server:<tag>` and
   `ghcr.io/silent-suite/silentsuite-web-selfhost:<tag>` (for example with
   `docker buildx imagetools inspect <ref>`; use the top-level index digest, not a
   per-platform digest). Cross-check them against the release's paired image manifest.
3. Update `serverImage` and `webImage` in `startos/manifest/index.ts` as `<repo>:<tag>@<digest>`.
4. Update `version` in `startos/versions/current.ts` to `X.Y.Z[-pre]:0`. The image tag must
   equal `v` plus the upstream part of the version; CI checks this. Move the old version
   into its own file in `startos/versions/` and list it under `other` in
   `startos/versions/index.ts`.
5. Bump `postgres` or `router` digests only on purpose, the same way. A PostgreSQL major
   upgrade needs a migration and is not a digest bump.
6. Build both architectures and test install, update from the previous version, backup and
   restore on StartOS.

The images first pinned here (v0.5.20-beta) are the ones the Umbrel package pins at
commit 67eaa25f6.
