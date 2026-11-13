#!/usr/bin/env bash
# Self-test for drive.sh's crash detection, with a fake adb (no emulator needed).
# A crash buffer far larger than a pipe buffer must still count as a crash, and a crash buffer
# adb cannot read must not count as "no crash".
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
cat > "$tmp/bin/adb" <<'ADB'
#!/usr/bin/env bash
case "$FAKE_CRASH" in
  big) echo "E AndroidRuntime: Process: io.silentsuite.android, PID: 1234"
       yes "E AndroidRuntime:   at at.bitfire.vcard4android.Contact.<clinit>(Contact.kt:3)" | head -c 100000 ;;
  other) yes "E AndroidRuntime: Process: com.example.other, PID: 1" | head -c 100000 ;;
  empty) ;;
  fail) exit 1 ;;
esac
ADB
chmod +x "$tmp/bin/adb"

PATH="$tmp/bin:$PATH" OUT="$tmp/out" UPGRADE_SYNC_CHECK_SOURCE_ONLY=1 source "$HERE/drive.sh"

fails=0
for case in big:yes other:no empty:no fail:unreadable; do
  got="$(FAKE_CRASH="${case%%:*}" PATH="$tmp/bin:$PATH" crash_state)"
  if [ "$got" = "${case#*:}" ]; then echo "ok   ${case%%:*} -> $got"
  else echo "FAIL ${case%%:*} -> $got (want ${case#*:})"; fails=1; fi
done
exit "$fails"
