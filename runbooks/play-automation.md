# Google Play publication lane

`.github/workflows/play-publish.yml` puts the newest published GitHub release of
the Android app on the Play **production** track, so nobody has to upload the
AAB by hand. It replaces steps 1 and 2 of the Play checklist in
`runbooks/android-release.md`; steps 3 and 4 (symbols accepted, no 16 KB
Conscrypt warning) are still checked in Play Console once Google has reviewed
the release.

## What a run does

Runs every three hours (`47 */3 * * *`) and on manual dispatch from `main`.

1. Picks the newest eligible published GitHub release, using the Zapstore
   lane's tag grammar and order (`scripts/zapstore/lib/eligibility.mjs`).
   Drafts never qualify.
2. Reads `versionCode` and `versionName` from `android/app/build.gradle` at the
   tag's commit (`versionName` must equal the tag without `v`), and the English
   notes from `android/fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`
   at the same commit (non-empty, at most 500 characters). Nothing from the tag
   is executed.
3. Opens a Play edit and reads the production track. If production already
   lists this versionCode (any status) or a higher one, it discards the edit
   and stops successfully. Manual uploads therefore never conflict with the
   lane.
4. Downloads `silentsuite-android-<tag>.aab` and
   `silentsuite-android-<tag>-native-debug-symbols.zip` and requires each hash
   to equal GitHub's asset digest and the release's own `.sha256` file.
5. Uploads the bundle (Play must report the same versionCode and sha256; Play
   itself rejects a bundle not signed with the upload key), attaches the
   native symbols, and sets one production release named
   `<versionCode> (<versionName>)`, status `completed`, with the English notes.
6. Validates the edit. In `validate` mode the edit is then discarded. In
   `publish` mode it is committed, which sends the release to Google's review;
   Play publishes it when the review passes. A fresh edit then reads the track
   back and must list the versionCode.

Any failure discards the uncommitted edit, so nothing half-done stays on Play.
A commit while other changes are in Google's review fails rather than
cancelling that review (`ERROR_IF_IN_REVIEW`); the next run retries.

## Configuration

| Item | Where | Value |
| --- | --- | --- |
| `PLAY_AUTOMATION_MODE` | repository variable | unset (off), `validate` or `publish` |
| `play-production` | environment | deployment branches: `main` only |
| `PLAY_SERVICE_ACCOUNT_JSON` | `play-production` secret | key of `play-publisher@silentsuite-play.iam.gserviceaccount.com` |

The master copy of the key is the Proton Pass item `Google Play API service
account` (vault `SilentSuite`, password field). The service account has view,
store-presence, testing and production release permissions on this app only.

## Operating it

- **Run now** after a release: Actions → Google Play Publication → Run workflow
  on `main`.
- **Pause**: delete the `PLAY_AUTOMATION_MODE` variable. A running job finishes.
- **Wrong release committed**: halt or replace it in Play Console (Production →
  release → Halt rollout), or upload a fixed release with a higher versionCode.
  A committed Play release cannot be deleted through the API.
- **Rotate the key**: create a new key for the service account, update the
  Proton Pass item and the environment secret, then delete the old key in
  Google Cloud.

Release notes in other languages, the store listing and the proguard mapping
are not uploaded by this lane.
