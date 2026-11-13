#!/usr/bin/env bash
# Drives the Android upgrade-and-sync check on a CI emulator. Test-only; no app code.
#
# Inputs (env): APK_PREVIOUS (latest published release, release variant, CI-signed),
# APK_CANDIDATE (candidate, release variant, same CI key), CA_PEM (throwaway CA for the local
# server), SERVER_URL (as the emulator sees it), REPRO_USER, REPRO_PASS, OUT.
#
# The account's contacts are seeded server-side (signup.py). The emulator's egress is locked to
# 10.0.2.2 before any sign-in. Phases:
#   previous  install the previous release, sign in, sync: it must store the 3 seeded contacts
#   upgrade   add contact 4 server-side; adb install -r the candidate; sync must store it
#   fresh     uninstall; install the candidate; its first sync must store all 4 contacts
# A phase passes only when the app's crash buffer stays empty and the address book holds the
# expected contacts. Exits non-zero if any phase fails or is not exercised.
set -uo pipefail

PKG=io.silentsuite.android
AB_TYPE=io.silentsuite.android.address_book
HERE="$(cd "$(dirname "$0")" && pwd)"
UI="python3 $HERE/ui.py"
mkdir -p "$OUT"
SUMMARY="$OUT/summary.txt"
: > "$SUMMARY"

log() { echo "[check $(date -u +%H:%M:%S)] $*" | tee -a "$OUT/driver.log"; }

wait_boot() {
  timeout 300 adb wait-for-device || { log "device did not attach"; return 1; }
  for _ in $(seq 1 120); do
    [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && return 0
    sleep 2
  done
  log "boot did not complete"; return 1
}

# Adds the throwaway CA to the system store without a reboot (a reboot hung the first run):
# a tmpfs over cacerts holding the existing anchors plus ours. Works on Android <= 13; new app
# processes see it.
install_ca() {
  local hash
  hash="$(openssl x509 -inform PEM -subject_hash_old -in "$CA_PEM" -noout)"
  log "installing CI CA as ${hash}.0"
  adb root >/dev/null 2>&1; sleep 3; timeout 120 adb wait-for-device
  adb push "$CA_PEM" "/data/local/tmp/${hash}.0" >/dev/null
  adb shell "set -e; rm -rf /data/local/tmp/cacerts; mkdir -m 700 /data/local/tmp/cacerts; \
    cp /system/etc/security/cacerts/* /data/local/tmp/cacerts/; \
    mount -t tmpfs tmpfs /system/etc/security/cacerts; \
    cp /data/local/tmp/cacerts/* /system/etc/security/cacerts/; \
    cp /data/local/tmp/${hash}.0 /system/etc/security/cacerts/; \
    chown root:root /system/etc/security/cacerts/*; chmod 644 /system/etc/security/cacerts/*; \
    chcon u:object_r:system_file:s0 /system/etc/security/cacerts/*" 2>&1 | tee -a "$OUT/driver.log"
  adb shell ls -lZ "/system/etc/security/cacerts/${hash}.0" 2>&1 | tee -a "$OUT/driver.log"
}

grant() {
  for p in READ_CONTACTS WRITE_CONTACTS READ_CALENDAR WRITE_CALENDAR; do
    adb shell pm grant "$PKG" "android.permission.$p" 2>/dev/null || true
  done
}

launch() { adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 4; }

alive() { adb shell pidof "$PKG" >/dev/null 2>&1; }

hide_keyboard() {
  if adb shell dumpsys input_method 2>/dev/null | grep -q "mInputShown=true"; then
    adb shell input keyevent 4; sleep 1
  fi
}

# The emulator may reach only the CI server on 10.0.2.2: no hosted service, whatever the app does.
lock_network() {
  adb shell "iptables -I OUTPUT 1 -o lo -j ACCEPT; iptables -I OUTPUT 2 -d 10.0.2.2 -j ACCEPT; \
    iptables -I OUTPUT 3 -j REJECT; ip6tables -I OUTPUT 1 -o lo -j ACCEPT; ip6tables -I OUTPUT 2 -j REJECT" \
    2>&1 | tee -a "$OUT/driver.log"
  # With egress blocked the captive-portal probe fails, the network never validates and
  # JobScheduler holds every sync ("Android is waiting to run it"). Skip validation, reconnect.
  adb shell settings put global captive_portal_mode 0
  adb shell settings put global captive_portal_detection_enabled 0
  adb shell cmd connectivity airplane-mode enable; sleep 5
  adb shell cmd connectivity airplane-mode disable; sleep 20
  adb shell dumpsys connectivity 2>/dev/null | tr -d '\r' | grep -m3 -E "NetworkAgentInfo.*(VALIDATED|Capabilities)" \
    > "$OUT/network-validation.txt"
  log "network validated: $(grep -c VALIDATED "$OUT/network-validation.txt")"
  local outside inside
  outside="$(adb shell 'toybox nc -w 5 1.1.1.1 443 </dev/null >/dev/null 2>&1 && echo OPEN || echo BLOCKED' | tr -d '\r')"
  inside="$(adb shell 'toybox nc -w 5 10.0.2.2 3735 </dev/null >/dev/null 2>&1 && echo OPEN || echo BLOCKED' | tr -d '\r')"
  log "egress check: outside=$outside ci-server=$inside"
  [ "$outside" = BLOCKED ] && [ "$inside" = OPEN ]
}

shot() { adb exec-out screencap -p > "$OUT/$1.png" 2>/dev/null || true; }

# One quoted device-side command: adb shell re-splits arguments, which cut the old --where.
contacts() {
  adb shell "content query --uri content://com.android.contacts/raw_contacts \
    --projection _id:sourceid:dirty:deleted:sync2:sync4 \
    --where \"account_type='$AB_TYPE' AND deleted=0\"" 2>/dev/null | tr -d '\r'
}

# Every phase starts with empty log buffers, so a crash is only ever counted for its own phase.
phase_start() { adb logcat -b all -c 2>/dev/null || true; log "phase $1 starts"; }

# Distinct server items stored (0.5.17 can store a contact twice; duplicates must not count).
contact_count() { contacts | grep -o "sourceid=[^,]*" | grep -v "=NULL" | sort -u | grep -c . || true; }

# Adds server-side contact $1 for the synthetic account (host-side etebase-py, plain HTTP on 8000).
server_add() { python "$HERE/signup.py" http://127.0.0.1:8000 "$REPRO_USER" "$REPRO_PASS" add "$1" | tee -a "$OUT/driver.log"; }

# Installs $2 ($1 = -r for an in-place upgrade) and fails unless the package manager says so.
install_apk() {
  local out
  out="$(adb install $1 "$2" 2>&1)"; echo "$out" | tee -a "$OUT/driver.log"
  grep -q "Success" <<<"$out" || return 1
  grant
}

crashed() { adb logcat -b crash -d 2>/dev/null | grep -q "$PKG"; }

# Signs in from whatever screen the app shows and walks post-login setup to the dashboard.
sign_in() {
  local phase="$1" typed=0 i ids x
  x="$OUT/$phase-ui.xml"
  launch
  for i in $(seq 1 60); do
    $UI dump "$x"; ids="$($UI ids "$x")"
    if grep -qx sync_now <<<"$ids"; then log "$phase: dashboard reached"; shot "$phase-dashboard"; return 0; fi
    if grep -qx permission_allow_button <<<"$ids"; then $UI tap "$x" id:permission_allow_button; sleep 2; continue; fi
    if grep -qx account_choice_sign_in <<<"$ids"; then $UI tap "$x" id:account_choice_sign_in; sleep 3; continue; fi
    if grep -qx user_name <<<"$ids" && [ "$typed" = 0 ]; then
      $UI tap "$x" id:user_name; adb shell input text "$REPRO_USER"
      $UI tap "$x" id:login_password; adb shell input text "$REPRO_PASS"
      hide_keyboard
      # The server field sits below the fold: scroll until the advanced toggle or field shows.
      for _ in 1 2 3 4; do
        $UI dump "$x"
        $UI ids "$x" | grep -qx custom_server && break
        $UI tap "$x" id:show_advanced >/dev/null 2>&1 && { sleep 1; continue; }
        adb shell input swipe 160 420 160 120 300; sleep 1
      done
      $UI tap "$x" id:custom_server && adb shell input text "$SERVER_URL"
      hide_keyboard; $UI dump "$x"
      shot "$phase-credentials"; cp "$x" "$OUT/$phase-credentials.xml"
      # Never sign in anywhere but the CI server: no tap unless the field holds its URL.
      if ! $UI has-text "$x" custom_server "$SERVER_URL"; then
        log "$phase: server field not set to the CI server; not signing in"; return 1
      fi
      $UI tap "$x" id:login
      typed=1; sleep 8; continue
    fi
    for target in setup_done setup_continue_limited; do
      if grep -qx "$target" <<<"$ids"; then $UI tap "$x" "id:$target"; sleep 5; continue 2; fi
    done
    $UI tap "$x" "text:(allow|ok|continue|got it|done|next)" >/dev/null 2>&1 && { sleep 3; continue; }
    alive || { log "$phase: app process gone during sign-in"; return 2; }
    shot "$phase-wait-$i"; sleep 4
  done
  log "$phase: dashboard not reached"; shot "$phase-stuck"; cp "$x" "$OUT/$phase-stuck.xml"; return 1
}

tap_sync() {
  local x="$OUT/$1-sync.xml"
  launch; $UI dump "$x"
  $UI tap "$x" id:sync_now && log "$1: sync_now tapped" || log "$1: sync_now not found"
}

# Watches phase $1 for up to $2 seconds until the address book holds $3 distinct contacts, then
# gives a late crash 20 s to show. Saves the evidence and returns 0 only if the phase was
# exercised (expected contacts stored) and the app's crash buffer is empty.
watch_phase() {
  local phase="$1" secs="$2" want="$3" t=0 crash=no count=0
  while [ "$t" -lt "$secs" ]; do
    crashed && break
    count="$(contact_count)"
    [ "$count" -ge "$want" ] && { sleep 20; break; }
    sleep 5; t=$((t + 5))
  done
  crashed && crash=yes
  count="$(contact_count)"
  adb logcat -b crash -d > "$OUT/$phase-logcat-crash.txt" 2>&1
  adb logcat -d -v threadtime > "$OUT/$phase-logcat-all.txt" 2>&1
  contacts > "$OUT/$phase-raw-contacts.txt"
  adb shell dumpsys content 2>/dev/null | tr -d '\r' | grep -i -A3 "silentsuite" | head -60 > "$OUT/$phase-sync-state.txt"
  adb shell dumpsys package "$PKG" | grep -E "versionCode|versionName|lastUpdateTime" > "$OUT/$phase-package.txt"
  shot "$phase-end"
  local cause version verdict=PASS
  cause="$(grep "Caused by" "$OUT/$phase-logcat-crash.txt" | tail -1 | sed 's/^.*AndroidRuntime: //' | tr -d '\r')"
  [ -n "$cause" ] || cause="$(grep -m1 -A1 "FATAL EXCEPTION" "$OUT/$phase-logcat-crash.txt" | tail -1 | sed 's/^.*AndroidRuntime: //' | tr -d '\r')"
  version="$(grep -m1 -o "versionName=[^ ]*" "$OUT/$phase-package.txt")"
  [ "$crash" = yes ] && verdict="FAIL (app crashed)"
  [ "$crash" = no ] && [ "$count" -lt "$want" ] && verdict="FAIL (not exercised: $count of $want contacts stored)"
  echo "$phase [$version]: $verdict contacts=$count/$want${cause:+ | $cause}" | tee -a "$SUMMARY"
  adb logcat -b all -c 2>/dev/null || true
  [ "$verdict" = PASS ]
}

# Fails phase $1 that could not start ($2 says why), keeping what evidence there is.
not_exercised() {
  adb logcat -b crash -d > "$OUT/$1-logcat-crash.txt" 2>&1
  adb logcat -d -v threadtime > "$OUT/$1-logcat-all.txt" 2>&1
  shot "$1-end"
  echo "$1: FAIL (not exercised: $2)" | tee -a "$SUMMARY"
  return 1
}

# Signs in on an installed build and syncs until $2 contacts are stored.
sign_in_and_sync() {
  sign_in "$1" || { watch_phase "$1" 20 "$2"; return 1; }
  tap_sync "$1"
  watch_phase "$1" 240 "$2"
}

previous_phase() {
  phase_start previous
  adb uninstall "$PKG" >/dev/null 2>&1
  install_apk "" "$APK_PREVIOUS" || { not_exercised previous "install failed"; return 1; }
  sign_in_and_sync previous 3
}

upgrade_phase() {
  server_add 4 || { not_exercised upgrade "could not add contact 4 server-side"; return 1; }
  phase_start upgrade
  install_apk -r "$APK_CANDIDATE" || { not_exercised upgrade "in-place install failed"; return 1; }
  launch; sleep 6; tap_sync upgrade; sleep 10; tap_sync upgrade-2
  watch_phase upgrade 240 4
}

fresh_phase() {
  phase_start fresh
  adb uninstall "$PKG" >/dev/null 2>&1
  install_apk "" "$APK_CANDIDATE" || { not_exercised fresh "install failed"; return 1; }
  sign_in_and_sync fresh 4
}

wait_boot || exit 1
install_ca
lock_network || { log "egress lock not verified; stopping before any sign-in"; exit 1; }

failed=0
if previous_phase; then
  upgrade_phase || failed=1
else
  failed=1
  echo "upgrade: FAIL (not exercised: the previous release did not sync)" | tee -a "$SUMMARY"
fi
fresh_phase || failed=1

log "summary:"; cat "$SUMMARY"
[ "$failed" = 0 ] && grep -c PASS "$SUMMARY" | grep -qx 3
