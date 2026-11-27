# Getting Started

Set up SilentSuite and start syncing your calendar, contacts, tasks, and notes with end-to-end encryption.

## 1. Create an Account

1. Go to [app.silentsuite.io](https://app.silentsuite.io).
2. Click **Sign Up**, then enter your email and choose a strong password.
3. Verify your email — hosted signup pauses while SilentSuite emails you a verification link. Open the link in the same browser you signed up in; the plan step stays locked until the link is opened, and your password is not saved while you wait.
4. Re-enter your password, then choose your plan. New hosted billing is annual only: Early Adopter access is €36 annually (€3 per month, billed annually), while future Standard access is €48 annually (€4 per month, billed annually). Choose a 7-day no-card trial with no automatic charge or a 30-day card-backed trial. Billing shows the exact annual charge date and cancellation deadline; cancel before that deadline. Card and prepaid Bitcoin annual payments include a 30-day refund promise. Self-hosting is free with every feature unlocked and skips the verification and billing steps entirely.

Self-hosting your own server? Expand **Advanced Settings** on the signup page and enter your server URL before submitting. See the [Self-Hosting guide](/self-hosting/) for the server side.

Your password is used to derive your encryption keys locally on your device. It never leaves your device, and the server never sees it.

**Important:** There is no password reset. Your encryption keys are derived from your password, so if you forget it, your data cannot be recovered. Use a password manager.

## 2. Set Up Your First Device

After creating your account, you can use SilentSuite immediately in the web app. Add calendar events, contacts, and tasks right from your browser, and turn on experimental [Notes](./notes.md#turn-on-notes) under **Settings → Experimental** if you want them. You can also [install the web app](./apps/web.md) on your computer or phone.

To sync with other apps and devices, see the [Apps & Integrations](./apps/index.md) page for supported Android and desktop setup guides. iOS is not supported yet; a native app is [planned](./apps/ios.md).

## 3. Add Your Data

Once set up, you can start adding:

- **Calendar events** -- see [Calendar](./calendar.md)
- **Contacts** -- see [Contacts](./contacts.md)
- **Tasks** -- see [Tasks](./tasks.md)
- **Notes** (experimental) -- see [Notes](./notes.md)

All data is encrypted on your device before syncing.

## 4. Add More Devices

To sync across multiple devices, sign in with the same account on each device. Your encryption keys are derived from your password on each device independently -- the server never sees them.

## 5. Confirm Sync Works

Create an event on one device. Within a few seconds it should appear on the other. If it doesn't:

- Check that both devices are signed in to the **same** account.
- Check that both devices report a successful sync in their status indicator.
- See the [FAQ](./faq.md) for common issues.
