#!/usr/bin/env bash
#
# Measure APNs transport reachability from wherever this script runs.
#
# Answers, with evidence rather than documentation:
#   1. Do Apple's APNs hosts speak HTTP/2 on their published ports?
#   2. Do they refuse HTTP/1.1? (They do, and this is why a client that speaks 1.1 sees a dropped
#      connection rather than an error status.)
#
# Run it on a laptop to get a baseline, then run the /reachability route of the deployed Worker to
# get the same measurement from the Cloudflare edge. The two together are the prototype result.
#
# Usage: ./scripts/measure-transport.sh
set -uo pipefail

hosts=(
  "production-send|https://api.push.apple.com/4/broadcasts/apps/com.example.probe"
  "production-manage|https://api-manage-broadcast.push.apple.com:2196/1/apps/com.example.probe/channels"
  "sandbox-send|https://api.sandbox.push.apple.com/4/broadcasts/apps/com.example.probe"
  "sandbox-manage|https://api-manage-broadcast.sandbox.push.apple.com:2195/1/apps/com.example.probe/channels"
)

printf '%-22s %-10s %-8s %-10s %s\n' TARGET PROTOCOL STATUS TIME BODY

for entry in "${hosts[@]}"; do
  name="${entry%%|*}"
  url="${entry#*|}"
  read -r version status seconds <<<"$(
    curl -s -o /tmp/qblive-apns-body --http2 -X GET "$url" --max-time 20 \
      -w '%{http_version} %{http_code} %{time_total}' 2>/dev/null
  )"
  body="$(head -c 80 /tmp/qblive-apns-body 2>/dev/null | tr -d '\n')"
  printf '%-22s %-10s %-8s %-10s %s\n' "$name" "HTTP/${version:-?}" "${status:-0}" "${seconds:-?}" "${body:-<none>}"
done

echo
echo "HTTP/1.1 negotiation (expected to fail: APNs advertises only h2 in ALPN):"
for entry in "${hosts[@]}"; do
  name="${entry%%|*}"
  url="${entry#*|}"
  result="$(curl -s --http1.1 -o /dev/null -w '%{http_code}' "$url" --max-time 20 2>&1 || true)"
  if [ "$result" = "000" ] || [ -z "$result" ]; then
    printf '  %-22s connection refused or dropped (as expected)\n' "$name"
  else
    printf '  %-22s answered %s over HTTP/1.1 (unexpected)\n' "$name" "$result"
  fi
done

echo
echo "ALPN advertised by the management host:"
echo | openssl s_client -alpn h2,http/1.1 -connect api-manage-broadcast.push.apple.com:2196 2>/dev/null \
  | grep -i 'ALPN protocol' | sed 's/^/  /'
