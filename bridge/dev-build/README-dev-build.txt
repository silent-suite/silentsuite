SilentSuite Bridge desktop - experimental development build
Commit: {{GIT_SHA}}

This is an experimental, unsigned development archive built by CI.
It is not an installer. It is not a release. Don't use it with a real
account, and don't use it in place of the Bridge you already run.

SilentSuite Bridge desktop uses Qt and PySide6 under the GNU LGPL. The
licence texts and notices are in NOTICES. SOURCE.txt says where the matching
source comes from. RELINKING.txt explains how to swap in your own builds of
those libraries.

Qt's font code includes parts of FreeType.
This software is based in part on the work of the FreeType Team.
Portions of this software are copyright (c) 1996-2026 The FreeType
Project (https://freetype.org). All rights reserved.


What's in the archive
---------------------
Linux:
  silentsuite-bridge-desktop/silentsuite-bridge-desktop   the program
  silentsuite-bridge-desktop/_internal/                   bundled libraries and resources
Windows:
  SilentSuite Bridge\SilentSuite Bridge.exe               the program
  SilentSuite Bridge\_internal\                           bundled libraries and resources

Next to that folder:
  NOTICES                  licence texts and third-party notices
  SOURCE.txt               how to get the matching source
  README-dev-build.txt     this file
  BUILD-INFO.json          build identity and per-file hashes

The program folder is left exactly as PyInstaller built it. The other files
sit beside it, not inside it.


Checking that you have the right build
--------------------------------------
There are two separate checks, and neither stands in for the other.

1. The archive file itself. A checksum for the downloaded archive should
   reach you separately, in the handoff for this build. That's the check
   that ties your download to the build. If you don't have one, you haven't
   done this check. This README doesn't contain a checksum.
2. The extracted files. BUILD-INFO.json records the commit and a hash for
   every file in the program folder. Check that the commit is {{GIT_SHA}}
   and that the file hashes match. This shows the folder matches what was
   built and tested. It can't prove the archive wasn't swapped, because
   BUILD-INFO.json travels inside the same archive.


How to test it without touching your working Bridge
---------------------------------------------------
1. Use a disposable VM or a separate OS user account.
2. Extract the archive into a new, empty folder. Don't extract it into
   /opt/silentsuite-bridge or %LOCALAPPDATA%\Programs, and don't overwrite
   anything that belongs to an installed Bridge.
3. Make a new, empty folder for test data and point SILENTSUITE_DATA_DIR at
   it. Never point it at your real Bridge data.
4. Pick a port nothing else uses and set it in SILENTSUITE_LISTEN_PORT. The
   default is 37358, which your normal Bridge probably uses, so choose a
   different one. The examples below use 47358; change it if that's taken.
5. Sign in only with a synthetic test account and made-up data.
6. The app has a start-at-login setting. Leave it off for this test, and
   don't add any other autostart or service entries.
7. Don't run it with --no-sandbox, and don't turn off OS security features
   to make it start. The app itself refuses to start if Qt WebEngine's
   sandbox is disabled or remote debugging is switched on.

Linux, from the folder you extracted into:

  mkdir -p "$HOME/ssb-test/data"
  SILENTSUITE_DATA_DIR="$HOME/ssb-test/data" SILENTSUITE_LISTEN_PORT=47358 \
    ./silentsuite-bridge-desktop/silentsuite-bridge-desktop

Windows (PowerShell), from the folder you extracted into:

  New-Item -ItemType Directory -Force "$env:TEMP\ssb-test\data" | Out-Null
  $env:SILENTSUITE_DATA_DIR = "$env:TEMP\ssb-test\data"
  $env:SILENTSUITE_LISTEN_PORT = "47358"
  & ".\SilentSuite Bridge\SilentSuite Bridge.exe"

These examples do not change system-wide configuration.

If a "Move to the desktop app?" prompt appears, choose Cancel. It means the
app found a command-line Bridge's start-at-login entry or a busy port, and
your test isn't isolated. Choosing to move would turn off the command-line
Bridge's start-at-login entry.

With start at login off, closing the window stops the Bridge. The menu
action "Quit SilentSuite Bridge" always stops it. When you're done, delete
the extracted folder and the test data folder.


What has and hasn't been tested
-------------------------------
Tested automatically: CI runs the source tests and the frozen-bundle
startup tests at the build commit. The frozen tests build this spec and
launch the unchanged program with a synthetic data folder, home folder and
loopback port. Before upload, CI also checks the licence notices and source
list against this build, and replaces one Qt library in an extracted copy of
this archive with a rebuilt one (RELINKING.txt describes it). The archive is
uploaded only if all of that passes and the maintainer has approved
publishing this commit. These checks show the bundle builds and starts. They
aren't hands-on acceptance.

Not tested by hand yet:
- install, upgrade and uninstall; a clean machine; launch at login
- real clients and real accounts
- privacy behaviour of the packaged build, the visible window, native Quit,
  real stdio
- the later network-policy activation, restart, rollback and UI work, which
  isn't built yet

Platforms: the archive is built for Linux x86_64 and Windows x86_64 only.
The Windows bundle relies on Windows' own C runtime files, which the spec
leaves out. CI also builds and startup-tests a macOS app, but no macOS
archive is produced. The macOS GUI is experimental and nobody has tested it
by hand. Don't read this build as a statement about which operating systems
are supported.

There is no installer and no code signing for this build.
