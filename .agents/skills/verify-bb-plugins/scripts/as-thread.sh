#!/usr/bin/env bash
# Run the test instance's bb CLI as a thread, the way an agent in that thread would.
#
#   .agents/skills/verify-bb-plugins/scripts/as-thread.sh <thread-id> <cwd> <bb args…>
#
# "$TB" drops every BB_* variable, so it can never run as a thread. Commands that
# act on "this thread" (secret requests, sauce, self-rename, genui ask) need
# BB_THREAD_ID. This reads the test server routing from the "$TB" wrapper, sets
# BB_THREAD_ID, and refuses to run unless the server is a loopback test port.
set -eu
: "${TB:?load current.env first: TB must name the test instance bb wrapper}"
[ $# -ge 3 ] || { echo "usage: as-thread.sh <thread-id> <cwd> <bb args…>" >&2; exit 2; }
tid=$1 dir=$2; shift 2
for name in "${!BB_@}"; do unset "$name"; done
eval "$(grep '^export BB_' "$TB")"
cli=$(sed -n 's/^exec "\(.*\)" "\$@"$/\1/p' "$TB")
case "${BB_SERVER_URL:-}" in
  http://127.0.0.1:*) ;;
  *) echo "refusing: $TB does not route to a loopback test server" >&2; exit 1 ;;
esac
[ -x "$cli" ] || { echo "refusing: no bb CLI found in $TB" >&2; exit 1; }
export BB_THREAD_ID=$tid
cd "$dir"
exec "$cli" "$@"
