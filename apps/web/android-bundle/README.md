# Android web bundle

Android debug builds carry a static copy of this web app's login and calendar
pages and show it in a web view (`android/app/src/debug/.../ui/webapp/`). It is
an experiment: release builds contain neither the pages nor the screen, and
nothing changes for people using the app.

## Build

```
node apps/web/android-bundle/build.mjs    # next build (static export), then package
node apps/web/android-bundle/verify.mjs   # check the packaged result
```

The result lands in `android-bundle/dist/webapp/` (not committed), and the
Android debug build packages that folder as `assets/webapp/`. Without it the
screen says the build carries no bundle.

- `manifest.json` lists every URL path the app answers, the stored file, its
  content type and SHA-256, and for each page its Content-Security-Policy.
- `files/` holds the files under their hash. Android's packager drops folders
  whose names start with an underscore, which is where Next.js keeps scripts.
- `LICENSE-AGPL-3.0.txt` is the licence of the bundled web code. The Android
  app itself is GPL-3.0; the source of both is this repository.

## What differs from the hosted build

`SILENTSUITE_ANDROID_BUNDLE=1` switches `next.config.js` to this build. Without
that variable the hosted and self-hosted builds are unchanged.

- Static export, no server: `app/api/**` route handlers and `middleware.ts`
  are left out, and the language is always the default (no cookie to read).
- Only `/login/` and `/calendar/` are packaged (`bundle-contract.mjs`). Sign-up,
  subscription and payment, admin, settings, tasks, contacts and notes are not,
  and `NEXT_PUBLIC_ANDROID_BUNDLE` hides the links to them.
- No error reporter (`@sentry/nextjs` resolves to `sentry-stub.js`), no
  analytics, no speed reporting and no service worker.
- It talks to the hosted service only: `server.silentsuite.io` and
  `api.silentsuite.io`. Self-hosted accounts are not supported in this view.
- The login page accepts only the Android account the app opened it for, which
  the app passes in the start URL's fragment (`app/lib/android-bundle.ts`).

## How the app serves it

The sync server accepts browser requests from `https://app.silentsuite.io`
only, so the app answers the bundled files under that address itself and never
fetches anything from it. Each page is sent with a policy that runs only the
bundle's own scripts (inline ones by hash) and reaches only the two servers
above. Requests to any other address are refused by the app as well.

## Known limits

- Two builds of one commit are compared byte for byte in CI
  (`android-web-bundle.yml`). The build downloads nothing: the font files are in
  `app/fonts/inter/`.
- Reminders do not come from this view; Android's calendar sync provides them.
- After an offline start the calendar is empty, as in the hosted web app.
