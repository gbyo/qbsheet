#!/usr/bin/env bash
#
# Run QBSheet Live in the iOS Simulator against a demo tournament.
#
# # Why a script
#
# QBSheet Live cannot be opened by hand in a simulator. There is no tournament until a backend is
# answering, the universal link that would carry one only works once `live.qbsheet.com` serves the
# AASA file and the app is signed with the matching Team ID, and a simulator has nothing to tap a
# QR code with. The app carries a Debug-only `-qblive-bootstrap` launch argument for exactly this
# situation (see `Shared/AppEntry.swift`), and this script is the thing that supplies it: it starts
# the demo backend, builds, installs, and launches with the bootstrap the backend is serving.
#
#   ./ios/scripts/simulate.sh                       # demo backend + full app, first-launch flow
#   ./ios/scripts/simulate.sh --clip                # the App Clip instead
#   ./ios/scripts/simulate.sh --team team-96a --tab standings
#   ./ios/scripts/simulate.sh --speed 1             # the tournament in real time
#   ./ios/scripts/simulate.sh --backend http://127.0.0.1:8788   # a backend already running
#
# See docs/QBLIVE_IOS.md § Simulating a tournament.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

device="${QBSHEET_SIMULATOR:-}"
scheme="QBSheetLive"
bundle_id="com.qbsheet.live"
backend=""
speed="30"
at="-2m"
team=""
tab=""
reset="no"
build="yes"

while [ $# -gt 0 ]; do
  case "$1" in
    --device) device="$2"; shift 2 ;;
    --clip) scheme="QBSheetLiveClip"; bundle_id="com.qbsheet.live.Clip"; shift ;;
    --backend) backend="$2"; shift 2 ;;
    --speed) speed="$2"; shift 2 ;;
    --at) at="$2"; shift 2 ;;
    --team) team="$2"; shift 2 ;;
    --tab) tab="$2"; shift 2 ;;
    --reset) reset="yes"; shift ;;
    --no-build) build="no"; shift ;;
    -h|--help)
      sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown option $1. Try --help." >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------- Xcode
#
# `xcode-select` may well point at the Command Line Tools, which cannot build an iOS app. Switching
# it needs a password, so instead of failing, find an Xcode and use it for this run only.
if ! xcrun --find xcodebuild >/dev/null 2>&1 || [ ! -d "$(xcode-select -p 2>/dev/null)/Platforms" ]; then
  for candidate in /Applications/Xcode.app /Applications/Xcode-beta.app /Applications/Xcode*.app; do
    if [ -d "$candidate/Contents/Developer/Platforms" ]; then
      export DEVELOPER_DIR="$candidate/Contents/Developer"
      echo "Using $candidate (xcode-select points at $(xcode-select -p))"
      break
    fi
  done
fi
if [ ! -d "${DEVELOPER_DIR:-$(xcode-select -p)}/Platforms/iPhoneSimulator.platform" ]; then
  echo "No Xcode with an iOS Simulator platform was found. Install Xcode, or run:" >&2
  echo "  sudo xcode-select -s /Applications/Xcode.app" >&2
  exit 1
fi

# ------------------------------------------------------------------- the demo
#
# Unless a backend was named, start one and stop it on the way out. The tournament lives in that
# process's memory, so leaving one running after the script exits would leave a stale demo behind.
demo_pid=""
cleanup() {
  if [ -n "$demo_pid" ] && kill -0 "$demo_pid" 2>/dev/null; then
    kill "$demo_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [ -z "$backend" ]; then
  port="${QBSHEET_DEMO_PORT:-8788}"
  echo "Starting the demo backend on port $port…"
  node "$repo_root/scripts/qblive-demo/server.mjs" --port "$port" --speed "$speed" --at "$at" &
  demo_pid=$!
  backend="http://127.0.0.1:$port"
  for _ in $(seq 1 40); do
    if curl -fsS "$backend/" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
fi

publication="$(curl -fsS "$backend/" | sed -n 's|.*/t/\([0-9bcdfghjkmnpqrstvwxyz]\{20\}\).*|\1|p' | head -1)"
if [ -z "$publication" ]; then
  echo "The backend at $backend did not say which tournament it is serving." >&2
  exit 1
fi
# The bootstrap the app parses. Percent-encoded because the backend origin is a query value.
encoded_backend="$(printf '%s' "$backend" | sed 's|:|%3A|g; s|/|%2F|g')"
bootstrap="https://live.qbsheet.com/t/$publication?b=$encoded_backend&v=1"

# --------------------------------------------------------------- the simulator
if [ -z "$device" ]; then
  device="$(xcrun simctl list devices available -j |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const runtimes = JSON.parse(s).devices;
      const all = Object.entries(runtimes)
        .filter(([runtime]) => runtime.includes("iOS"))
        .flatMap(([, devices]) => devices);
      const booted = all.find((device) => device.state === "Booted");
      const preferred = all.find((device) => device.name.startsWith("iPhone 17 Pro"));
      const iphone = all.find((device) => device.name.startsWith("iPhone"));
      const chosen = booted ?? preferred ?? iphone;
      if (chosen) process.stdout.write(chosen.udid);
    })')"
fi
if [ -z "$device" ]; then
  echo "No iOS simulator is available. Install an iOS runtime in Xcode." >&2
  exit 1
fi

echo "Booting $device…"
xcrun simctl boot "$device" 2>/dev/null || true
xcrun simctl bootstatus "$device" -b >/dev/null 2>&1 || true
open -a "$(dirname "${DEVELOPER_DIR:-$(xcode-select -p)}")/Applications/Simulator.app" 2>/dev/null ||
  open -a Simulator 2>/dev/null || true

# ------------------------------------------------------------------- the build
derived="$repo_root/ios/.build/simulate"
if [ "$build" = "yes" ]; then
  if command -v xcodegen >/dev/null 2>&1; then
    (cd "$repo_root/ios" && xcodegen generate --quiet)
  fi
  echo "Building $scheme…"
  build_log="$(mktemp)"
  if xcodebuild \
    -project "$repo_root/ios/QBSheetLive.xcodeproj" \
    -scheme "$scheme" \
    -configuration Debug \
    -destination "id=$device" \
    -derivedDataPath "$derived" \
    CODE_SIGNING_ALLOWED=NO \
    build >"$build_log" 2>&1; then
    build_status=0
  else
    build_status=$?
  fi
  grep -E "error:|warning: .*(deprecated|unused)|BUILD" "$build_log" || true
  rm -f "$build_log"
  if [ "$build_status" -ne 0 ]; then
    echo "Build failed." >&2
    exit "$build_status"
  fi
fi

app="$derived/Build/Products/Debug-iphonesimulator/$scheme.app"
if [ ! -d "$app" ]; then
  echo "No built app at $app. Run without --no-build." >&2
  exit 1
fi

echo "Installing $scheme…"
xcrun simctl install "$device" "$app"

launch_arguments=(-qblive-bootstrap "$bootstrap")
[ "$reset" = "yes" ] && launch_arguments+=(-qblive-reset)
[ -n "$team" ] && launch_arguments+=(-qblive-team "$team")
[ -n "$tab" ] && launch_arguments+=(-qblive-tab "$tab")

xcrun simctl terminate "$device" "$bundle_id" >/dev/null 2>&1 || true
echo "Launching $bundle_id against $backend…"
xcrun simctl launch --console-pty "$device" "$bundle_id" "${launch_arguments[@]}" &
launch_pid=$!

cat <<EOF

QBSheet Live is running in the simulator.

  tournament   $bootstrap
  backend      $backend  (${speed}× real time)
  device       $device

Ctrl-C stops the demo backend and the app's console.
EOF

wait "$launch_pid" 2>/dev/null || true
# The launch returns as soon as the app is up; keep the demo backend alive until interrupted.
if [ -n "$demo_pid" ]; then
  wait "$demo_pid" 2>/dev/null || true
fi
