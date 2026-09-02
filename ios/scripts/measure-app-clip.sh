#!/usr/bin/env bash
#
# Measure the App Clip against Apple's physical-invocation size limit.
#
# # Why this is a release blocker
#
# QBSheet Live's App Clip is invoked from printed QR codes on posters and table cards. That is a
# *physical* invocation, so Apple's **15 MB uncompressed, thinned** limit applies — not the 50 MB
# limit that iOS 17 introduced for digital invocations. An App Clip over the physical limit does not
# launch from a code at all, which would break the product's primary entry point silently.
#
# # What is measured
#
# The uncompressed size of the App Clip bundle after app thinning, which is what Apple's rule is
# stated against. A simulator build is a close approximation and is what CI can produce without
# signing; an `xcarchive`'s thinned variant is the exact number and is what a release should use.
#
# Usage:
#   ./ios/scripts/measure-app-clip.sh                       # build for the simulator and measure
#   ./ios/scripts/measure-app-clip.sh path/to/Clip.app      # measure an existing bundle
#
# Exits non-zero above the budget.
set -euo pipefail

# Apple's limit for an App Clip that supports physical invocation (App Clip Codes, NFC, QR).
readonly LIMIT_BYTES=$((15 * 1024 * 1024))
# The number the build fails at. Below the limit on purpose: a Clip that fits by 200 KB today fails
# the first time a system framework grows, in the week before a tournament.
readonly BUDGET_BYTES=$((12 * 1024 * 1024))

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bundle="${1:-}"

if [ -z "$bundle" ]; then
  derived="${QBSHEET_DERIVED_DATA:-$(mktemp -d)/dd}"
  echo "Building QBSheetLiveClip for the simulator…"
  xcodebuild \
    -project "$repo_root/ios/QBSheetLive.xcodeproj" \
    -scheme QBSheetLiveClip \
    -configuration Release \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$derived" \
    CODE_SIGNING_ALLOWED=NO \
    build >/dev/null
  bundle="$derived/Build/Products/Release-iphonesimulator/QBSheetLiveClip.app"
fi

if [ ! -d "$bundle" ]; then
  echo "No App Clip bundle at $bundle" >&2
  exit 2
fi

bytes="$(find "$bundle" -type f -print0 | xargs -0 stat -f%z | awk '{ total += $1 } END { print total+0 }')"
megabytes="$(awk -v b="$bytes" 'BEGIN { printf "%.2f", b / 1048576 }')"
limit_mb="$(awk -v b="$LIMIT_BYTES" 'BEGIN { printf "%.0f", b / 1048576 }')"
budget_mb="$(awk -v b="$BUDGET_BYTES" 'BEGIN { printf "%.0f", b / 1048576 }')"

echo
echo "App Clip bundle:  $bundle"
echo "Uncompressed:     ${megabytes} MB (${bytes} bytes)"
echo "QBSheet budget:   ${budget_mb} MB"
echo "Apple hard limit: ${limit_mb} MB (physical invocation: App Clip Code, NFC, QR)"
echo

echo "Largest contents:"
find "$bundle" -type f -print0 \
  | xargs -0 stat -f'%z %N' \
  | sort -rn \
  | head -8 \
  | awk '{ printf "  %8.2f KB  %s\n", $1/1024, substr($0, index($0, $2)) }'
echo

if [ "$bytes" -gt "$LIMIT_BYTES" ]; then
  echo "FAIL: over Apple's physical-invocation limit. This App Clip would not launch from a printed code." >&2
  exit 1
fi
if [ "$bytes" -gt "$BUDGET_BYTES" ]; then
  echo "FAIL: over QBSheet's budget. Under Apple's limit, but with no headroom left." >&2
  exit 1
fi
echo "OK: inside the budget with $(awk -v a="$BUDGET_BYTES" -v b="$bytes" 'BEGIN { printf "%.2f", (a-b)/1048576 }') MB to spare."
