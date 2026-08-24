# Android release: Play Console upload checklist

Pushing a `v*` tag runs the signed `build-release` job in
`.github/workflows/build-android.yml`. It builds the signed AAB, manually
packages `native-debug-symbols.zip` from the locally rebuilt Etebase AAR (AGP
8.11.1 does not emit a standalone symbol ZIP for projects whose native
libraries arrive exclusively through prebuilt AARs), verifies both against the
expected native inventory, and attaches deterministic artifacts to the draft
umbrella GitHub release.

Native inventory of the release AAB, for arm64-v8a, armeabi-v7a, x86, and
x86_64:

- `libetebase_android.so` — from the local Etebase 2.3.2 16 KB AAR built by
  `android/scripts/build-etebase-client-16kb.sh`. Only the locally rebuilt
  64-bit copies retain symbol tables; the upstream 32-bit copies are stripped.
- `libconscrypt_jni.so` — from Conscrypt 2.6.3 and its recorded BoringSSL
  revision, rebuilt by `android/scripts/build-conscrypt-android-r28.sh` with
  NDK r28 and the explicit 16 KB max/common-page-size linker flags. All copies
  remain pre-stripped.

The credential-free `conscrypt-r28` job builds that AAR once and every app job
downloads the same run-scoped artifact. The AAR and final release APK/AAB are
checked for both 16 KB ELF `LOAD` alignment and a Conscrypt
`.note.android.ident` value of NDK r28 or newer. The Android signing-boundary
guard digest-binds the producer job and source-build script.

Because pre-stripped dependencies carry no extractable debug metadata, the
CI workflow packages the symbol ZIP manually via
`android/scripts/package-native-debug-symbols.py`, extracting only the two
symbol-bearing 64-bit Etebase libraries (`arm64-v8a/libetebase_android.so` and
`x86_64/libetebase_android.so`) from the same rebuilt AAR that feeds the build.
Each selected ELF is validated to have a real `.symtab` via `readelf` (fail-
closed). The ZIP is written atomically with deterministic entry ordering,
timestamps, and permissions.

Do not expect or claim symbols for the stripped Conscrypt or upstream 32-bit
Etebase payloads. The job fails closed if the ZIP is missing, malformed, or
missing those required entries, or if any symbol-bearing entry's bytes do not
match the byte-identical copy packaged in the AAB (SHA-256 comparison).

For every Play Console release, the operator must:

1. Download from the same draft GitHub release, for the same tag:
   `silentsuite-android-<tag>.aab` and
   `silentsuite-android-<tag>-native-debug-symbols.zip`. Verify each against
   its `.sha256` sidecar before upload.
2. Upload the AAB and the native debug-symbol ZIP together to the same Play
   Console release: after uploading the AAB, attach the ZIP as that version's
   native debug symbols (or via App bundle explorer → select that version →
   Downloads → native debug symbols).
3. Confirm Play Console accepted the symbols: the release page must show no
   missing-native-debug-symbols warning for that version code after upload.
   CI cannot verify Play Console state — this acceptance check is a manual
   release gate.
4. Confirm Play Console no longer shows the Conscrypt old-NDK compatibility warning
   for 16 KB-page devices. Treat the warning as a failed release gate even when
   Play accepted the AAB and its debug symbols.

Never upload an AAB and a symbol ZIP from different tags or workflow runs; the
symbol ZIP is validated only against the AAB built in the same job.
