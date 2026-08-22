#!/usr/bin/env bash
# Fire Keep drone API by hand, the way n8n sees it. Run from the fabric/ directory with the
# python hub and the Minecraft server both up.
#
#   ./examples/n8n/curl-examples.sh
#
# These go through the hub, which is the only exposed process: it holds the mod's API key and
# re-serves the mod's control API under /api/fleet. To call the mod directly instead - useful
# when you are debugging which of the two is broken - set
#   HUB=http://127.0.0.1:8090 FLEET=/api KEY=$(...the apiKey from config/firekeep-drones.json)
set -euo pipefail

HUB="${FIREKEEP_HUB:-http://127.0.0.1:8000}"
FLEET="${FLEET:-/api/fleet}"
API="$HUB$FLEET"
# The hub only asks for a key if it was started with one, so an unset key is not an error here.
KEY="${FIREKEEP_API_KEY:-}"
AUTH="Authorization: Bearer $KEY"
JSON="Content-Type: application/json"

pretty() { python3 -m json.tool 2>/dev/null || cat; }
step()   { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "health (the one endpoint that needs no key) - the hub's own, not the fleet's"
curl -s "$HUB/api/health" | pretty

step "world summary"
curl -s -H "$AUTH" "$API/world" | pretty

step "spawn drone_01"
curl -s -X POST -H "$AUTH" -H "$JSON" \
  -d '{"id":"drone_01","x":0.5,"y":80,"z":0.5}' "$API/drones" | pretty

step "the roster"
curl -s -H "$AUTH" "$API/drones" | pretty

step "one drone"
curl -s -H "$AUTH" "$API/drones/drone_01" | pretty

step "perception (forced fresh scan)"
curl -s -H "$AUTH" "$API/drones/drone_01/perception?fresh=true" | pretty

step "just the local map"
curl -s -H "$AUTH" "$API/drones/drone_01/perception" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['local_map']['grid'])"

step "move east 5, waiting for the drone to finish"
curl -s -X POST -H "$AUTH" -H "$JSON" \
  -d '{"command":"move","direction":"east","distance":5,"await":true}' \
  "$API/drones/drone_01/command" | pretty

step "move to a point (async: returns immediately)"
curl -s -X POST -H "$AUTH" -H "$JSON" \
  -d '{"command":"move_to","x":20,"y":85,"z":-10}' \
  "$API/drones/drone_01/command" | pretty

step "what is it doing?"
curl -s -H "$AUTH" "$API/drones/drone_01/command" | pretty

step "hold position"
curl -s -X POST -H "$AUTH" -H "$JSON" \
  -d '{"command":"hover","await":true}' "$API/drones/drone_01/command" | pretty

step "put out any fire below it"
curl -s -X POST -H "$AUTH" -H "$JSON" \
  -d '{"command":"dispense_water","await":true}' "$API/drones/drone_01/command" | pretty

step "send whichever drone is nearest and free"
curl -s -X POST -H "$AUTH" -H "$JSON" \
  -d '{"x":20,"y":85,"z":-10}' "$API/dispatch" | pretty

step "go home"
curl -s -X POST -H "$AUTH" -H "$JSON" \
  -d '{"command":"return_home","await":true,"timeout_ms":60000}' \
  "$API/drones/drone_01/command" | pretty

step "recent events, straight from the mod's ring buffer"
curl -s -H "$AUTH" "$API/events?limit=10" | pretty

step "the same events as the hub saw them, which is what it forwards to n8n"
curl -s -H "$AUTH" "$HUB/api/mod/events?limit=10" | pretty

step "rejections: bad key, unknown drone, malformed command"
curl -s -o /dev/null -w '  no key      -> %{http_code}\n' "$API/drones"
curl -s -o /dev/null -w '  no drone    -> %{http_code}\n' -H "$AUTH" "$API/drones/nope"
curl -s -w '\n' -X POST -H "$AUTH" -H "$JSON" \
  -d '{"command":"move","distance":3}' "$API/drones/drone_01/command"
