### Installation password

New accounts need the installation password. Read it with:

    sudo yunohost app setting __APP__ owner_password

### Access

- The web app follows the main permission you chose at install (YunoHost users only, or public).
- The installation-owner page (`/api/v1/owner/`) is limited to YunoHost administrators.
- The sync API paths used by native clients are always public, because those clients cannot log in to the YunoHost portal. They still need a SilentSuite account.

### Live updates

This package does not include Redis, so live push notifications are off. Clients fetch changes on their normal sync schedule.

### How it runs

The services run the published SilentSuite images as plain file trees under systemd (`RootDirectory=`), with no container runtime. The trees live in `__INSTALL_DIR__/server` and `__INSTALL_DIR__/web` and are owned by root; the app only writes to `__DATA_DIR__`.
