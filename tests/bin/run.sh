#!/usr/bin/env bash
# Smoke tests for bin/azeron. The unit tests cover the library; this checks the CLI
# actually starts from the built artifact and reports failure with a non-zero exit code.
set -uo pipefail
cd "$(dirname "$0")/../.."
# Against the frozen copy of the data, like every other test: the owner's layouts can be half
# way through a change without failing a check of the code. See tests/fixtures/repo.
export AZERON_DATA="$PWD/tests/fixtures/repo"
# An Azeron app profile folder that is not there, so no test reads the real one.
export AZERON_STORE="$PWD/tests/fixtures/no-azeron-app"

fails=0
check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "ok   $name"
  else
    echo "FAIL $name (exit $?)"
    fails=$((fails + 1))
  fi
}
# Exit codes alone let a command pass for the wrong reason: roundtrip exits 0 when it
# skips every profile, and a refusal can come from a missing store rather than the check
# being tested. These also require what was said.
says() {
  local name="$1" pattern="$2"; shift 2
  local output status
  output="$("$@" 2>&1)"; status=$?
  if grep -qE -- "$pattern" <<<"$output"; then
    echo "ok   $name"
  else
    echo "FAIL $name (exit $status, expected /$pattern/)"
    printf '%s\n' "$output" | sed 's/^/     /' | head -8
    fails=$((fails + 1))
  fi
}
check_fails() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "FAIL $name (expected non-zero exit)"
    fails=$((fails + 1))
  else
    echo "ok   $name"
  fi
}

check "azeron --help" ./bin/azeron --help
says "azeron help prints usage" "^azeron <command>" ./bin/azeron help
says "azeron lint is clean" "everspace: 0 error\(s\), 0 warning\(s\)" ./bin/azeron lint
check "azeron build --check" ./bin/azeron build --check
says "azeron roundtrip checks the golden profile" "round trip ok: .*single-v5" ./bin/azeron roundtrip
says "the committed game bindings agree with actions.yaml" " 0 differ" \
  ./bin/azeron ingame everspace --config "$AZERON_DATA/dist/SpaceSims/everspace/Input.ini"
says "the pedals are reported with how far each name is trusted" "rudder .*\[inferred\] -- not flown" \
  ./bin/azeron ingame everspace --config "$AZERON_DATA/dist/SpaceSims/everspace/Input.ini"
says "capturing finds the recorded rudder where the layout expects it" "already recorded: rudder .*inferred" \
  ./bin/azeron ingame everspace --capture-pedals --config "$AZERON_DATA/dist/SpaceSims/everspace/Input.ini"
check_fails "unknown command exits non-zero" ./bin/azeron nonsense
check_fails "the cheatsheet command is gone" ./bin/azeron cheatsheet
check "no generated HTML is tracked" bash -c '[ -z "$(git ls-files "*.html")" ]'
check_fails "unknown game exits non-zero" ./bin/azeron lint no-such-game
says "defaults lists the genres and their layouts" "FPS +controller, keyboard, default" ./bin/azeron defaults
says "defaults prints a genre's pad" "^FPS: the Xbox pad" ./bin/azeron defaults FPS
says "defaults prints the controller layout of the pair" "Like a controller \(controller\)" ./bin/azeron defaults FPS
says "defaults prints the one unit layout asked for" "One unit \(default\)" ./bin/azeron defaults FPS --style default
check_fails "defaults refuses a genre that is not there" ./bin/azeron defaults NoSuchGenre
check_fails "defaults refuses a layout that is not there" ./bin/azeron defaults FPS --style nope
# Refusals only: a game or layout that was made would be written into the frozen fixture.
says "new needs a genre" "new needs a name and --genre" ./bin/azeron new Some Game
says "new refuses a genre that is not there" "not a genre" ./bin/azeron new Some Game --genre Nope
says "layout refuses a name already in use" "already has a layout called" \
  ./bin/azeron layout everspace single-v5 --units left
says "units says when the app has no copy of a layout" 'has no profile named "Everspace 2 akimbo v10 \(right\)"' \
  ./bin/azeron units everspace --set akimbo-v10
check_fails "units exits non-zero while the app is behind" ./bin/azeron units everspace --set akimbo-v10
says "install refuses without --yes" "Re-run with --yes" ./bin/azeron install everspace
says "install refuses one device id for a pair" "would send profiles for 2 units" \
  ./bin/azeron install everspace --device-id 0 --dry-run

# The editor server and its stop command, on a port nothing else is using. The port is one the
# system hands out, and the server is only stopped once it has said it started: a server
# that was already on the port would otherwise be the one `stop` shut down.
stop_port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
stop_log="$(mktemp)"
./bin/azeron serve --port "$stop_port" >"$stop_log" 2>&1 &
serve_pid=$!
for _ in $(seq 1 50); do
  grep -q "editor on" "$stop_log" 2>/dev/null && break
  grep -q "already in use" "$stop_log" 2>/dev/null && break
  sleep 0.2
done
if grep -q "editor on" "$stop_log" && ! grep -q "already in use" "$stop_log"; then
  says "stop ends a running editor server" "stopped the editor server on port $stop_port"     ./bin/azeron stop --port "$stop_port"
  says "stop says when nothing is running" "nothing is running on port $stop_port"     ./bin/azeron stop --port "$stop_port"
else
  echo "FAIL the test's own editor server did not start on port $stop_port"
  sed 's/^/     /' "$stop_log" | head -5
  fails=$((fails + 2))
fi
kill "$serve_pid" 2>/dev/null
rm -f "$stop_log"

exit "$fails"
