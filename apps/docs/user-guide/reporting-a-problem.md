# Reporting a Problem

You can report a problem or ask for a feature from inside SilentSuite. Nothing is sent until you press **Send** or choose an email app.

## Where to find it

- **Web:** **Settings → Report a problem** (listed under **Help**).
- **Android:** **Settings → Help → Report a problem**.
- **Bridge:** **Report a problem** in the tray menu, or the **Report a problem** page on the Bridge dashboard. On a headless install, open the dashboard in your browser.

## What you can send

- **Problem** or **Feature request**.
- A **summary** (up to 120 characters) and a **description** (up to 4000 characters).
- A **reply email**, if you want an answer. Leave it empty otherwise. Enter one address only.

## Include diagnostic info

This box is ticked for problems and unticked for feature requests. While it is ticked, a read-only preview shows the exact diagnostic info that will be sent with your report. It contains only fixed, coarse values:

- App version.
- A coarse platform label, such as `firefox-linux` or `android-34`.
- Whether you use the hosted server or a custom server.
- Sync status (synced, syncing, offline, error or unknown).
- Roughly when sync last succeeded: under an hour, under a day, under a week, longer, never, or unknown.
- Error codes from a fixed list, such as `sync_failed`. Anything the app has no code for is sent as `other`.
- A few app-specific values:
  - **Web:** whether calendar, contacts, tasks and notes loaded, and whether the last session restore worked.
  - **Android:** the version code, the number of accounts and whether the last startup succeeded.
  - **Bridge:** the install type, the number of accounts and whether the tray and SSL are on.

Diagnostic info never includes:

- account names or email addresses
- server URLs or hostnames
- collection names or IDs
- the content of events, contacts, tasks or notes
- error messages or stack traces
- device model or build strings, the installer package, or your full browser user agent
- IP addresses
- timestamps more precise than the time ranges above

## What happens when you press Send

Your report is sent through Cloudflare and delivered by email (via Resend) to the SilentSuite support inbox. It is not end-to-end encrypted and not linked to your account. We delete it 90 days after we've dealt with it. To have it deleted sooner, email [support@silentsuite.io](mailto:support@silentsuite.io). See the [privacy policy](https://silentsuite.io/privacy#problem-reports).

If the report goes through, you see "Thanks, your report was sent." If the app can't confirm it (for example, the connection dropped or timed out), it says so and does not try again by itself, because the report may already have arrived. Use **Email instead** or **Copy** from there.

## Email instead or Copy

- **Email instead** opens your email app with a message to support@silentsuite.io containing the same text. Nothing is sent until you send that email yourself.
- **Copy** copies the same text to your clipboard so you can paste it wherever you like.

Use these if you'd rather not use Send, or if Send didn't work.

## Self-hosting

If you use [app.silentsuite.io](https://app.silentsuite.io) with your own server, you can send reports too. The diagnostic info only says "custom server". It never contains your server's address.

If you run your own build of the web app, Send may not reach SilentSuite. Use **Email instead** or **Copy**.
