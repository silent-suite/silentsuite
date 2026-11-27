# SilentSuite on StartOS

SilentSuite encrypts your calendar, contacts, tasks and notes on your own devices. This
server stores only encrypted data and never sees your account password.

## Create your account

1. Start SilentSuite and wait until every health check is green.
2. Run the **Show Installation Password** action and copy the password.
3. Open the **Web app and sync address** interface. Use an `https://` address.
4. Choose **Sign up**, enter the installation password, then choose your own username and
   account password.

Your account password encrypts your data on your device. It is never sent to this server
and nobody can recover it for you, so store it safely. Every new account on this server
needs the installation password, so only people you give it to can sign up.

## Addresses and certificates

- Always use the `https://` address. Plain `http://` requests are redirected or refused.
- **Browser on your local network:** the `.local` address uses your StartOS server's own
  certificate authority. Trust the StartOS root CA on that device first
  ([Start9's guide](https://docs.start9.com/start-os/0.4.2.x/trust-ca.html)).
- **Android app:** the SilentSuite Android app only trusts publicly issued certificates.
  Add a public domain to this interface in StartOS (it gets a Let's Encrypt certificate)
  and use that address as the server address in the app.
- **SilentSuite Bridge (desktop):** use the same `https://` address. On the `.local`
  address the computer must trust the StartOS root CA.
- **Tor:** an onion address has not been tested with this package yet.

## Backups

StartOS backups include the database (as a PostgreSQL dump), the server's own data and the
installation password. Your data stays encrypted inside the backup.

## Not verified yet

This package has been built and tested in CI. It has not yet been tested on a real StartOS
server: installation, sign-up, sync, backup and restore, and uninstall and reinstall are
still to be checked there.
