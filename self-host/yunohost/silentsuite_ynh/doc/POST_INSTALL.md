To create the first account you need the installation password. Read it as an administrator on the server:

    sudo yunohost app setting __APP__ owner_password

Then open `https://__DOMAIN__/signup`, enter the installation password when asked, and choose your own account password. Your account password encrypts your data and is never sent to the server, so keep it safe: it cannot be recovered.

Only YunoHost administrators can use the installation password page. The sync paths that the Android app and SilentSuite Bridge use are reachable without the YunoHost login.
