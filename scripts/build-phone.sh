#!/bin/sh
# Build (and optionally install) the iPhone relayer.
#   scripts/build-phone.sh            build for the connected device
#   scripts/build-phone.sh sim        build for the iOS simulator
#   scripts/build-phone.sh install    build + install to the phone
# First run needs Xcode signing set up once: open relayer-ios/HealthRelay.xcodeproj,
# pick your (free) Personal Team under Signing & Capabilities.
#
# Device builds share the auto re-sign machinery's rules (src/resign/):
#   - the same mkdir lock (~/Library/Application Support/health-resign/run.lock),
#     so a manual build and a timer run never mint profiles at the same time
#   - install quarantines ONLY the HealthRelay app + widget profiles from
#     Xcode's cache first, so a fresh 7-day profile is minted (other apps'
#     profiles are never touched), and puts them back if the build fails
#   - the phone is picked by resign.device_udid (config) or HEALTH_DEVICE_UDID
#   - success requires devicectl to print 'App installed'
#   - BOTH embedded profiles (app + widget) must clear the freshness floor
#     (6 days, capped at the signing certificate's notAfter minus 1h);
#     HEALTH_ALLOW_STALE_PROFILE=1 installs anyway when no fresh mint is possible
#   - xcodebuild runs under a wall timeout (HEALTH_BUILD_TIMEOUT_S, default
#     1800) and its pid is recorded in the lock, so nothing holds it forever
#   - after a verified install, the exact tree that was built becomes the
#     re-sign snapshot (source/ + source.json, version from the BUILT Info.plist)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/relayer-ios"

RESIGN_BASE="$HOME/Library/Application Support/health-resign"
LOCK="$RESIGN_BASE/run.lock"
LOCK_GRACE_S=60 # an owner-less lock dir younger than this is being taken right now
BUILD_TIMEOUT_S="${HEALTH_BUILD_TIMEOUT_S:-1800}"
APP_ID=com.s0nderlabs.HealthRelay
WIDGET_ID=com.s0nderlabs.HealthRelay.widgets
CONFIG="${HEALTH_CONFIG_PATH:-$HOME/.config/health/config.json}"
PROFILE_DIRS="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles
$HOME/Library/MobileDevice/Provisioning Profiles"

command -v xcodegen >/dev/null || { echo "xcodegen missing: brew install xcodegen"; exit 1; }
[ -d HealthRelay.xcodeproj ] || xcodegen generate

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# ISO (with or without milliseconds: the runner writes toISOString) to epoch; 0 when odd.
iso_epoch() {
  T=$(printf '%s' "${1:-}" | sed -E 's/\.[0-9]+Z$/Z/')
  date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$T" +%s 2>/dev/null || echo 0
}
# One key of a JSON or plist file, raw; empty when absent.
pget() { plutil -extract "$1" raw -o - "$2" 2>/dev/null || true; }
# When a pid started (epoch seconds), empty when it is gone.
proc_start() {
  L=$(ps -o lstart= -p "$1" 2>/dev/null | sed 's/[[:space:]]*$//')
  [ -n "$L" ] || return 0
  date -j -f "%a %b %e %T %Y" "$L" +%s 2>/dev/null || true
}
# Seconds since a path was modified (huge when it is gone).
mtime_age() { echo $(( $(date +%s) - $(stat -f %m "$1" 2>/dev/null || echo 0) )); }

# ── shared lock ──────────────────────────────────────────────────
LOCK_MINE=0
LOCK_STARTED=""
# owner.json, optionally with one recorded child (pid + spawn time) so a
# later stale takeover can reap exactly that process and nothing that reused
# its pid.
write_owner() {
  [ -n "$LOCK_STARTED" ] || LOCK_STARTED=$(now_iso)
  if [ -n "${1:-}" ]; then
    CH="[$1]"
    CHS="[{\"pid\": $1, \"started_at\": \"$2\"}]"
  else
    CH="[]"
    CHS="[]"
  fi
  printf '{"pid": %s, "started_at": "%s", "child_pids": %s, "children": %s, "holder": "build-phone"}\n' \
    "$$" "$LOCK_STARTED" "$CH" "$CHS" >"$LOCK/owner.json.tmp.$$"
  mv "$LOCK/owner.json.tmp.$$" "$LOCK/owner.json"
  LOCK_MINE=1
}
lock_is_mine() { [ "$LOCK_MINE" = 1 ] && [ "$(pget pid "$LOCK/owner.json")" = "$$" ]; }
take_lock() {
  mkdir -p "$RESIGN_BASE"
  if mkdir "$LOCK" 2>/dev/null; then write_owner; return 0; fi
  OPID=$(pget pid "$LOCK/owner.json")
  OSTART=$(pget started_at "$LOCK/owner.json")
  if [ -z "$OPID" ]; then
    # No owner yet: a taker between its mkdir and its owner.json write
    # (busy), or a crash in that gap long ago (stale). The runner's rule.
    if [ "$(mtime_age "$LOCK")" -lt "$LOCK_GRACE_S" ]; then
      echo "$LOCK is being taken right now; try again"
      exit 1
    fi
  elif kill -0 "$OPID" 2>/dev/null; then
    # A LIVE owner is never displaced by age (a run frozen by sleep resumes
    # and finishes). Only a reused pid, one that started after the owner took
    # the lock, is stale.
    PSTART=$(proc_start "$OPID")
    OEPOCH=$(iso_epoch "$OSTART")
    # When ps cannot tell the start time, fall back to the TS rule (age): a
    # live owner older than 50 min is stale, so the lock can never wedge.
    if [ -z "$PSTART" ] && [ "$OEPOCH" != 0 ] && [ $(( $(date +%s) - OEPOCH )) -gt 3000 ]; then
      echo "taking over a 50+ min old re-sign lock (owner start time unreadable)"
    elif [ -z "$PSTART" ] || [ "$OEPOCH" = 0 ] || [ "$PSTART" -le $((OEPOCH + 2)) ]; then
      echo "a re-sign run holds $LOCK (pid $OPID since $OSTART); try again when it finishes"
      exit 1
    fi
  fi
  # Stale: take it over in place behind the nested takeover gate (the
  # runner's rule). A gate abandoned by a crash is cleared after the grace.
  if ! mkdir "$LOCK/takeover" 2>/dev/null; then
    if [ "$(mtime_age "$LOCK/takeover")" -ge "$LOCK_GRACE_S" ] && rmdir "$LOCK/takeover" 2>/dev/null && mkdir "$LOCK/takeover" 2>/dev/null; then
      :
    else
      echo "lock takeover in progress; try again"
      exit 1
    fi
  fi
  # Inside the gate, re-read: if the owner is no longer the one judged stale,
  # another taker already won.
  if [ "$(pget pid "$LOCK/owner.json")" != "$OPID" ] || [ "$(pget started_at "$LOCK/owner.json")" != "$OSTART" ]; then
    rmdir "$LOCK/takeover" 2>/dev/null || true
    echo "the lock changed hands; try again"
    exit 1
  fi
  # Reap only recorded xcodebuild/devicectl children whose start time still
  # matches the recorded spawn time (pids get reused, owner.json survives reboots).
  I=0
  while CPID=$(plutil -extract "children.$I.pid" raw -o - "$LOCK/owner.json" 2>/dev/null); do
    CST=$(plutil -extract "children.$I.started_at" raw -o - "$LOCK/owner.json" 2>/dev/null || true)
    I=$((I + 1))
    COMM=$(basename "$(ps -o comm= -p "$CPID" 2>/dev/null || true)" 2>/dev/null || true)
    case "$COMM" in xcodebuild | devicectl) ;; *) continue ;; esac
    PST=$(proc_start "$CPID")
    REC=$(iso_epoch "$CST")
    [ -n "$PST" ] && [ "$REC" != 0 ] && [ $((PST - REC)) -le 3 ] && [ $((REC - PST)) -le 3 ] || continue
    kill -TERM "$CPID" 2>/dev/null || true
  done
  write_owner
  rmdir "$LOCK/takeover" 2>/dev/null || true
  echo "took over a stale lock (pid ${OPID:-?})"
}
release_lock() {
  [ "$LOCK_MINE" = 1 ] || return 0
  lock_is_mine && rm -rf "$LOCK"
  LOCK_MINE=0
}

# ── xcodebuild under a wall timeout, pid recorded in the lock ────
XPID=""
WPID=""
stop_watchdog() {
  [ -n "$WPID" ] || return 0
  pkill -P "$WPID" 2>/dev/null || true
  kill "$WPID" 2>/dev/null || true
  WPID=""
}
build_device() {
  xcodebuild -project HealthRelay.xcodeproj -scheme HealthRelay \
    -destination 'generic/platform=iOS' -allowProvisioningUpdates -quiet build &
  XPID=$!
  if lock_is_mine; then write_owner "$XPID" "$(now_iso)"; fi
  (sleep "$BUILD_TIMEOUT_S" && echo "xcodebuild passed ${BUILD_TIMEOUT_S}s: killing it" >&2 && kill -TERM "$XPID" 2>/dev/null) &
  WPID=$!
  RC=0
  wait "$XPID" || RC=$?
  XPID=""
  stop_watchdog
  if lock_is_mine; then write_owner; fi
  return "$RC"
}

# ── profile quarantine (install only) ────────────────────────────
MOVES=""
MINT_OK=0
TEAM=$(sed -nE 's/^[[:space:]]*DEVELOPMENT_TEAM:[[:space:]]*"?([A-Z0-9]{10})"?[[:space:]]*$/\1/p' project.yml | head -1)
quarantine() {
  BACKUP="$RESIGN_BASE/profile-backups/$(date +%Y%m%d-%H%M%S)-build-phone"
  MOVES="$BACKUP/moves.tsv"
  mkdir -p "$BACKUP"
  : >"$MOVES"
  # 'active' until a fresh mint is verified or the originals are back: if this
  # script dies in between, the runner's recover() puts them back.
  : >"$BACKUP/active"
  TMPP=$(mktemp -t health-profile)
  echo "$PROFILE_DIRS" | while IFS= read -r DIR; do
    [ -d "$DIR" ] || continue
    for F in "$DIR"/*.mobileprovision; do
      [ -f "$F" ] || continue
      security cms -D -i "$F" -o "$TMPP" 2>/dev/null || continue
      AID=$(pget Entitlements.application-identifier "$TMPP")
      if [ -n "$TEAM" ] && { [ "$AID" = "$TEAM.$APP_ID" ] || [ "$AID" = "$TEAM.$WIDGET_ID" ]; }; then
        TO="$BACKUP/$(basename "$F")"
        [ -e "$TO" ] && TO="$BACKUP/$(date +%s)-$(basename "$F")"
        printf '%s\t%s\n' "$F" "$TO" >>"$MOVES"
        mv "$F" "$TO"
      fi
    done
  done
  rm -f "$TMPP"
  echo "quarantined $(wc -l <"$MOVES" | tr -d ' ') HealthRelay profile(s) into $BACKUP"
}
restore_profiles() {
  [ -n "$MOVES" ] && [ -f "$MOVES" ] || return 0
  [ "$MINT_OK" = 1 ] && return 0 # a fresh mint verified: originals stay in the backup
  while IFS="$(printf '\t')" read -r FROM TO; do
    [ -n "$FROM" ] || continue
    if [ -e "$FROM" ]; then continue; fi # never clobber what Xcode wrote
    [ -e "$TO" ] && mv "$TO" "$FROM"
  done <"$MOVES"
  rm -f "$(dirname "$MOVES")/active"
  echo "restored the quarantined profiles"
  MOVES=""
}
cleanup() {
  if [ -n "$XPID" ]; then kill -TERM "$XPID" 2>/dev/null || true; fi
  stop_watchdog || true
  restore_profiles || true
  release_lock || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

case "${1:-device}" in
  sim)
    xcodebuild -project HealthRelay.xcodeproj -scheme HealthRelay \
      -destination 'generic/platform=iOS Simulator' -quiet build
    ;;
  install)
    take_lock
    # Snapshot the exact tree being built; it is promoted only after a
    # verified install (WIP never becomes the re-sign input otherwise).
    NEXT="$RESIGN_BASE/source.next"
    rm -rf "$NEXT"
    mkdir -p "$NEXT"
    rsync -a --delete --exclude 'build/' --exclude 'xcuserdata' --exclude '*.xcuserstate' "$ROOT/relayer-ios/" "$NEXT/relayer-ios/"
    quarantine
    MARK="$RESIGN_BASE/.build-phone-start"
    touch "$MARK"
    build_device
    # Never the Index.noindex copy (an indexer product has no fresh profile).
    APP=$(find ~/Library/Developer/Xcode/DerivedData -path '*Build/Products/*-iphoneos/HealthRelay.app' \
      -not -path '*Index.noindex*' -newer "$MARK" -print -quit)
    [ -n "$APP" ] || { echo "no fresh HealthRelay.app under DerivedData"; exit 1; }
    # App Intents metadata must be in the bundle whenever the source uses
    # AppIntents, or Shortcuts loses "Log Money Notification" (Nov 16 2026:
    # an incremental Debug build dropped Metadata.appintents silently).
    if grep -rqE '^[[:space:]]*import[[:space:]]+AppIntents' --include='*.swift' HealthRelay \
      && [ ! -f "$APP/Metadata.appintents/extract.actionsdata" ]; then
      echo "ABORT: $APP has no Metadata.appintents but the source imports AppIntents (Shortcuts actions would vanish)."
      echo "Clean build: rm -rf ~/Library/Developer/Xcode/DerivedData/HealthRelay-* then re-run."
      exit 1
    fi
    # BOTH embedded profiles must be fresh (a reused cached profile installs
    # a build that dies on the OLD date; the widget's alone is enough to fail
    # the mint). The floor: 6 days, capped at the signing certificate's
    # notAfter minus 1h when it is readable (a cert dying sooner cannot do better).
    embedded_exp() {
      TMPE=$(mktemp -t health-embedded)
      if security cms -D -i "$1" -o "$TMPE" 2>/dev/null; then pget ExpirationDate "$TMPE"; fi
      rm -f "$TMPE"
    }
    APP_EXP=$(embedded_exp "$APP/embedded.mobileprovision")
    WID_EXP=$(embedded_exp "$APP/PlugIns/HealthRelayWidgets.appex/embedded.mobileprovision")
    NOW=$(date +%s)
    FLOOR=$((NOW + 144 * 3600))
    CERTD=$(mktemp -d -t health-cert)
    if codesign -d --extract-certificates="$CERTD/c" "$APP" >/dev/null 2>&1 && [ -f "$CERTD/c0" ]; then
      CEND=$(openssl x509 -inform DER -in "$CERTD/c0" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')
      CEPOCH=$(date -j -u -f "%b %e %T %Y GMT" "$CEND" +%s 2>/dev/null || echo 0)
      if [ "$CEPOCH" -gt 0 ] && [ $((CEPOCH - 3600)) -lt "$FLOOR" ]; then
        FLOOR=$((CEPOCH - 3600))
        echo "freshness floor capped by the signing certificate (notAfter $CEND)"
      fi
    fi
    rm -rf "$CERTD"
    APP_E=$(iso_epoch "$APP_EXP")
    WID_E=$(iso_epoch "$WID_EXP")
    echo "embedded profiles: app expires ${APP_EXP:-unreadable} ($(( (APP_E - NOW) / 3600 ))h), widget ${WID_EXP:-unreadable} ($(( (WID_E - NOW) / 3600 ))h)"
    if [ "$APP_E" -ge "$FLOOR" ] && [ "$WID_E" -ge "$FLOOR" ]; then
      MINT_OK=1
      rm -f "$BACKUP/active" # a verified mint: the originals stay in the backup
    elif [ "${HEALTH_ALLOW_STALE_PROFILE:-}" = 1 ]; then
      echo "WARNING: an embedded profile is not fresh (a cached profile was reused); installing anyway (HEALTH_ALLOW_STALE_PROFILE=1): the phone keeps the dates above"
    else
      echo "an embedded profile is not fresh (a cached profile was reused, or the app or widget profile is short): not installing"
      echo "to install anyway (a feature install when no fresh mint is possible): HEALTH_ALLOW_STALE_PROFILE=1 scripts/build-phone.sh install"
      exit 1
    fi
    # The phone by UDID: env, then config resign.device_udid, then the
    # first reachable physical device as before.
    DEVICE_ID="${HEALTH_DEVICE_UDID:-}"
    [ -n "$DEVICE_ID" ] || DEVICE_ID=$(pget resign.device_udid "$CONFIG")
    if [ -z "$DEVICE_ID" ]; then
      # The model column contains spaces, so take the id right before its
      # "(UDID)" label. Simulators and "unavailable" rows are dropped first.
      DEVICE_ID=$(xcrun devicectl list devices --hide-headers 2>/dev/null \
        | grep -v 'simulated' \
        | grep -v 'unavailable' \
        | grep -E 'available|connected' \
        | sed -nE 's/.*[[:space:]]([0-9A-Fa-f][0-9A-Fa-f-]{15,})[[:space:]]+\(UDID\).*/\1/p' | head -1)
    fi
    [ -n "$DEVICE_ID" ] || { echo "no device (set resign.device_udid, or cable / same Wi-Fi with pairing)"; exit 1; }
    OUT=$(xcrun devicectl device install app --device "$DEVICE_ID" --timeout 150 "$APP" 2>&1) || true
    echo "$OUT"
    echo "$OUT" | grep -q 'App installed' || { echo "install NOT confirmed (no 'App installed')"; exit 1; }
    # Promote the snapshot + write source.json from the BUILT Info.plist.
    SHORT=$(pget CFBundleShortVersionString "$APP/Info.plist")
    BUILD=$(pget CFBundleVersion "$APP/Info.plist")
    COMMIT=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo "")
    if [ -n "$(git -C "$ROOT" status --porcelain -- relayer-ios 2>/dev/null)" ]; then DIRTY=true; else DIRTY=false; fi
    SHA=$(cd "$NEXT/relayer-ios" && find . -type f | LC_ALL=C sort | xargs -I{} shasum -a 256 {} | shasum -a 256 | cut -d' ' -f1)
    rm -rf "$RESIGN_BASE/source.old"
    [ -d "$RESIGN_BASE/source" ] && mv "$RESIGN_BASE/source" "$RESIGN_BASE/source.old"
    mv "$NEXT" "$RESIGN_BASE/source"
    rm -rf "$RESIGN_BASE/source.old"
    printf '{"version": "%s (%s)", "git_commit": "%s", "dirty": %s, "content_sha256": "%s", "captured_at": "%s"}\n' \
      "$SHORT" "$BUILD" "$COMMIT" "$DIRTY" "$SHA" "$(now_iso)" >"$RESIGN_BASE/source.json.tmp"
    mv "$RESIGN_BASE/source.json.tmp" "$RESIGN_BASE/source.json"
    echo "installed $SHORT ($BUILD) to $DEVICE_ID; re-sign snapshot updated"
    ;;
  *)
    take_lock
    build_device
    ;;
esac
echo "build ok"
