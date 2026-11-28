# SilentSuite for YunoHost

A YunoHost package (packaging v2, helpers 2.1) for [SilentSuite](https://silentsuite.io): end-to-end encrypted calendar, contacts, tasks and notes.

It installs the published SilentSuite server and web images without Docker. The install script downloads each image from `ghcr.io` by its pinned digest with `skopeo`, unpacks it with `umoci`, and runs it under systemd with `RootDirectory=`. PostgreSQL comes from YunoHost's database resource.

Status: beta, amd64 only (arm64 is untested on YunoHost). Not yet in the YunoHost catalogue.

Install from a local copy of this directory:

    sudo yunohost app install ./silentsuite_ynh --args "domain=cal.example.org&init_main_permission=all_users"

See `doc/ADMIN.md` for the installation password and access rules.
