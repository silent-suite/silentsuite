# Getting Started

A walkthrough of creating your account and getting your first event syncing across two devices.

## 1. Create an Account

Go to [app.silentsuite.io](https://app.silentsuite.io/signup). For the hosted service the signup flow is three steps:

1. **Account** — email and password.
2. **Plan** — pick Monthly or Annual (Annual saves 17%) and choose your trial:
   - **7-day free trial** — full access, no credit card required.
   - **30-day free trial** — card secures the trial; you're not charged until day 30 and can cancel any time before then.
3. **Setup** — your encryption keys are derived from your password on this device. Store the password somewhere safe; without it, your data cannot be recovered. SilentSuite has no way to reset it because the server never sees your keys.

After signup, an inline **Verify your email** banner stays at the top of the app until you click the link sent to your registered address. (No banner on self-hosted accounts.)

Self-hosting your own server? Expand **Advanced Settings** on the signup page and enter your server URL before submitting. The flow becomes four steps (Account → Self-Hosting → Admin Setup → Setup) and skips the plan / billing entirely. See the [Self-Hosting guide](../self-hosting/) for the server side of that.

## 2. Add Your First Event

After signup you land on the calendar. Click any cell or tap the **+** button to create an event:

- Title, location, description, all-day, start/end with timezone, reminders (`VALARM`), recurrence rule
- Save — the event is encrypted in your browser before it leaves the page

See [Calendar](./calendar.md), [Contacts](./contacts.md), and [Tasks](./tasks.md) for what each section covers.

## 3. Add a Second Device

Your data is only useful if you can read it on the device you're carrying. Three supported surfaces, all talking to the same encrypted account:

### Web (any device with a browser)

Open [app.silentsuite.io](https://app.silentsuite.io/login) on the second device and log in with the same email and password. The web app is an offline-first PWA — you can install it to your home screen or dock from your browser's "install app" menu.

### Android

In **Settings → Mobile** there's a QR code that links to the latest signed APK on GitHub Releases. Scan it from your phone or download manually. Sideload, open the app, log in. The Android app supports a custom server URL in advanced settings if you self-host.

> Currently distributed as a sideloadable APK. Google Play and F-Droid listings are on the roadmap.

### Desktop (CalDAV / CardDAV via the bridge)

If you'd rather use Thunderbird, Apple Calendar, GNOME Calendar, Evolution, or any other standard CalDAV/CardDAV client, install the **SilentSuite bridge**. It runs a local DAV daemon on `localhost:37358` that translates between your client and the encrypted Etebase backend.

Install commands are in **Settings → Desktop** in the web app.

> The bridge keeps plaintext on `localhost` only — every byte that leaves your machine is encrypted by the bridge first.

### iOS

There's no SilentSuite iOS app yet (on the roadmap). In the meantime, the [EteSync iOS app](https://www.etesync.com/) speaks the same Etebase protocol and works against your SilentSuite account.

## 4. Confirm Sync Works

Create an event on device A. Within a few seconds it should appear on device B. If it doesn't:

- Check that both devices are signed in to the **same** account
- Check that both devices report a successful sync in their status indicator
- See the [FAQ](./faq.md) for common issues

That's the success state for setup. From here, see the per-section guides:

- [Calendar](./calendar.md) — events, recurrence, timezones, import/export
- [Contacts](./contacts.md) — vCard CRUD and import/export
- [Tasks](./tasks.md) — priorities, due dates, ICS task export
- [How Encryption Works](./encryption-explained.md) — what the server can and can't see
- [FAQ](./faq.md) — anything we get asked twice
