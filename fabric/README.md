# Fire Keep — Fabric mod

A Minecraft **26.2** Fabric mod for autonomous disaster-response drones. Drones fly themselves;
an AI agent, reached through n8n, only ever tells them *what* to do.

```
Minecraft world ─► DronePerception ─► HTTP / webhook ─► n8n ─► AI agent
                                                                  │
Drone executes ◄─ DroneController ◄─ DroneCommandExecutor ◄─ n8n ◄┘
```

Perception is built entirely from Minecraft's own block, entity and world APIs. **No screenshots
and no computer vision are involved anywhere in the decision loop.** (The mod also ships an
unrelated camera/agent system for *filming* drones — that is for the dashboard, not for the AI.)

---

## Contents

- [What the drone bridge does](#what-the-drone-bridge-does)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Starting the API](#starting-the-api)
- [API reference](#api-reference)
- [Commands](#commands)
- [Perception payload](#perception-payload)
- [Events](#events)
- [Connecting it to n8n](#connecting-it-to-n8n)
- [Testing a drone by hand](#testing-a-drone-by-hand)
- [Limitations and what to build next](#limitations-and-what-to-build-next)

---

## What the drone bridge does

Each drone can:

1. Report its position, rotation, velocity and status.
2. Inspect the blocks and entities around it, on a configurable 3-D radius.
3. Recognise fire, lava, water, trees, buildings, terrain, obstacles, open space, mobs and players.
4. Reduce all of that to a few kilobytes of structured JSON plus a coarse ASCII map.
5. Push that perception, and every notable event, to an n8n webhook.
6. Accept high-level commands over HTTP.
7. Execute them itself — pathfinding, collision avoidance and flight are all server-side.
8. Report the result back, synchronously on the request or asynchronously as an event.

A default scan is 21 × 11 × 21 = **4,851 blocks**, and the JSON that leaves the mod is about
**3 KB**. Nine drones scanning once a second cost roughly **0.1 ms** of extra server tick time.

---

## Architecture

All the new code lives in `src/main/java/dev/awsaf/firekeep/drone/`.

| Class | Job |
|---|---|
| `DroneManager` | The fleet. Indexes drones, runs controllers, schedules perception, publishes state. |
| `DroneController` | One drone's autopilot: accepts a command, plans, flies, detects being stuck. |
| `DroneCommandExecutor` | The single door commands come in through: parse, validate, queue, optionally await. |
| `DroneCommand` / `CommandType` / `CommandResult` | One order, its verb, and how it ended. |
| `DronePerception` | Scans the world (server thread), interprets it (worker thread). |
| `PerceptionScan` / `PerceptionSnapshot` | Raw class grid, and the structured description built from it. |
| `BlockClass` | Every block state collapsed into eleven semantic categories. |
| `Compass` | `north` ⇄ `-Z`. The only place Minecraft's axis convention is allowed to matter. |
| `DronePathfinder` | Bounded 3-D A* over block states, with line-of-sight smoothing. |
| `DroneActions` | The only code that mutates the world (currently: extinguishing fire). |
| `DroneApiServer` | The HTTP API. |
| `N8nClient` | Asynchronous webhook delivery. |
| `DroneEvents` / `DroneEvent` | Event bus, de-duplication, and the pollable event log. |
| `DroneConfig` | Everything configurable, from `config/firekeep-drones.json`. |

It integrates with the **existing** `DroneEntity` rather than replacing it: the entity still owns
flight dynamics, and the controller drives it through `setTargetPosition` / `setMaxSpeed`. Two small
additions were made to it — a persisted `homePosition`, and `setClimbOnCollision`, which lets a
controller turn off the entity's "rise over the obstruction" reflex while flying a planned route.
The existing `/drone` commands, `WorldFeed`, `DroneAgents` and `AgentSupervisor` are untouched.

### Threading

The rule is: **the server thread writes, everyone else reads.**

- Each server tick, `DroneManager` re-indexes drones, drains the command queue, ticks the
  controllers, and republishes two `ConcurrentHashMap`s of drone state and perception.
- HTTP handlers read those maps. They never touch a Minecraft object.
- Work that must reach the game is queued and drained at the next tick; a caller that asked to
  wait blocks on a `CompletableFuture` on an HTTP pool thread, never on the game loop.
- Block scanning happens on the server thread (it must), but clustering, naming and drawing the
  map happen on a worker.
- Webhook delivery is a daemon thread with a bounded queue that drops its oldest entry when full.
  **An unreachable n8n can never cost a tick.**

### Chunk loading

Every drone holds a loading + simulating chunk ticket over a 5 × 5 chunk region that follows it.
Without it a drone sent to a fire nobody is standing near would leave the loaded world and stop
existing.

---

## Configuration

`config/firekeep-drones.json` is written on first start, with a freshly generated API key.

```json
{
  "api":        { "enabled": true, "host": "127.0.0.1", "port": 8090, "apiKey": "<generated>" },
  "n8n":        { "baseUrl": "http://127.0.0.1:5678",
                  "webhookUrl": "",
                  "authHeader": "X-Firekeep-Key",
                  "authValue": "",
                  "events": true,
                  "pushPerception": false,
                  "perceptionPushIntervalSeconds": 5 },
  "perception": { "radius": 10, "verticalRadius": 5, "intervalTicks": 20,
                  "entityRadius": 24, "maxFeatures": 6, "includeMap": true, "openClearance": 4 },
  "flight":     { "maxSpeedBlocksPerSecond": 8.0, "arrivalRadius": 0.5, "stuckTicks": 60,
                  "maxReplans": 3, "pathNodeBudget": 4000, "pathSearchRadius": 48,
                  "hazardClearance": 2, "cruiseAltitude": 4 },
  "actions":    { "waterRadius": 3, "placeWaterSource": false,
                  "fireEventCooldownSeconds": 60, "disasterFireCells": 12 }
}
```

Environment variables override the file, so one build can be pointed at a different n8n without
editing anything:

| Variable | Overrides |
|---|---|
| `N8N_BASE_URL` | `n8n.baseUrl` |
| `N8N_WEBHOOK_URL` | `n8n.webhookUrl` |
| `N8N_WEBHOOK_KEY` | `n8n.authValue` |
| `DRONE_API_KEY` | `api.apiKey` |
| `DRONE_API_PORT` | `api.port` |
| `PERCEPTION_RADIUS` | `perception.radius` |
| `PERCEPTION_VERTICAL_RADIUS` | `perception.verticalRadius` |

Notable knobs:

- **`perception.intervalTicks`** — how often each drone's cached perception refreshes. `20` is once
  a second. Raise it if you run a large fleet.
- **`flight.hazardClearance`** — set to `0` to let routes pass right beside fire; `2` keeps a buffer.
- **`actions.placeWaterSource`** — off by default. On, `dispense_water` also leaves a real water
  block, which will then flow and reshape terrain.
- **`n8n.pushPerception`** — off by default. On, one drone's perception is pushed to the webhook
  every `perceptionPushIntervalSeconds` in addition to events.

---

## Starting the API

The API starts and stops with the Minecraft server; there is nothing separate to launch.

```
[Server thread/INFO] (firekeep) drone API listening on http://127.0.0.1:8090/api (bearer token required)
[Server thread/INFO] (firekeep) drone bridge ready: perception 10x5 blocks, n8n at http://127.0.0.1:5678/webhook/firekeep
```

Two things to check on a dedicated server:

- **Turn off idle pausing.** Modern dedicated servers stop ticking about a minute after the last
  player leaves, which freezes every drone. Set `pause-when-empty-seconds=0` in `server.properties`.
- **Bind address.** The API listens on `127.0.0.1` by default. If n8n runs on another host, set
  `api.host` to `0.0.0.0` **and** put it behind a firewall or reverse proxy — the API key is the
  only gate.

### Authentication

Every endpoint except `/api/health` requires the key, as either header:

```
Authorization: Bearer <DRONE_API_KEY>
X-API-Key: <DRONE_API_KEY>
```

`/api/health` is deliberately open so a misconfigured token reads as "reachable but rejected"
rather than as a dead port.

---

## API reference

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness, radii, webhook state. No auth. |
| `GET` | `/api/world` | Time, weather, fleet size, every hazard any drone has seen. |
| `GET` | `/api/drones` | The roster. |
| `POST` | `/api/drones` | Spawn a drone. |
| `GET` | `/api/drones/{id}` | One drone's state. |
| `DELETE` | `/api/drones/{id}` | Remove a drone. |
| `GET` | `/api/drones/{id}/perception` | Structured surroundings. `?fresh=true` forces a scan. |
| `POST` | `/api/drones/{id}/command` | Issue an order. `?wait=true` blocks until it finishes. |
| `GET` | `/api/drones/{id}/command` | What it is doing right now. |
| `POST` | `/api/dispatch` | Send the *nearest available* drone somewhere. |
| `GET` | `/api/events` | Recent events, `?limit=50`. Works without a webhook. |

`GET /api/drones`:

```json
{
  "drones": [
    { "id": "drone_01", "status": "available",  "available": true,
      "dimension": "minecraft:overworld",
      "position": { "x": 0.5, "y": 76.48, "z": 0.39 },
      "velocity": { "x": 0, "y": 0, "z": 0 },
      "rotation": { "yaw": 0, "pitch": 0 },
      "home": { "x": 0.5, "y": 76.48, "z": 0.39 },
      "speed_blocks_per_second": 8.0, "game_time": 18926, "entity_id": 1 },
    { "id": "drone_02", "status": "responding", "available": false, "...": "..." }
  ],
  "count": 2
}
```

Statuses: `available`, `moving`, `responding`, `scanning`, `dispensing`, `returning`,
`following`, `stuck`, `offline`. Only `available` and `stuck` are dispatchable.

### Command responses

Asynchronous by default — fire and forget, and watch for the event:

```json
{ "command_id": "a4a751b1", "drone_id": "drone_01", "command": "move",
  "ok": true, "status": "queued", "message": "command accepted" }
```

With `?wait=true` (or `"await": true` in the body) the response is the outcome:

```json
{ "command_id": "a4a751b1", "drone_id": "drone_01", "command": "move",
  "ok": true, "status": "completed", "message": "arrived",
  "data": { "position": { "x": 4.85, "y": 76.42, "z": 0.5 } } }
```

`status` is one of `queued`, `accepted`, `running`, `completed`, `failed`, `superseded`.
A wait that times out returns `running`, not an error — the drone is still flying. Default wait is
30 s, `"timeout_ms"` raises it up to 120 s.

If you did not wait, `GET /api/drones/{id}/command` reports what the drone is doing now and carries
the previous command's outcome as `last_result`, in exactly the shape above.

Errors: `400` malformed command, `401` bad key, `404` unknown drone or endpoint, `405` wrong method.

---

## Commands

`POST /api/drones/{id}/command`. One command is active at a time; a new one supersedes the old and
its caller is told so, which is what makes it safe for an AI to change its mind mid-flight.

| `command` | Fields | Notes |
|---|---|---|
| `move` | `direction`, `distance`, optional `altitude` | Eight compass points plus `up` / `down`. |
| `move_to` | `x`, `y`, `z` | Or a nested `"position": {x,y,z}`. |
| `hover` | — | Brake and hold. |
| `scan` | — | Forces a fresh scan; the result comes back in `data`. |
| `return_home` | — | Flies to its stored home. |
| `follow` | `target`, optional `radius` | Another drone's id, or a player name. Never completes. |
| `dispense_water` | optional `radius` | Extinguishes fire around the ground below the drone. |
| `look` | `yaw` + `pitch`, or `at: {x,y,z}` | With no fields, the camera goes back to following motion. |
| `patrol` | `waypoints: [{x,y,z}, …]`, optional `loop` | |
| `set_speed` | `speed` (blocks/second) | |
| `set_home` | optional `x`, `y`, `z` | Defaults to where it is now. Persists on the entity. |
| `cancel` | — | Stop and hold. |

Every command also accepts `"await": true` and `"timeout_ms"`.

Aliases are accepted so a model's phrasing rarely matters: `goto`/`fly_to`/`navigate` → `move_to`,
`stop`/`hold` → `hover`, `rtb`/`go_home` → `return_home`, `extinguish`/`drop_water` → `dispense_water`,
`observe`/`perceive` → `scan`, `aim`/`face` → `look`. Directions accept `n`, `ne`, `sw`, …

### What the mod handles, not n8n

Flight, collision avoidance, pathfinding and stuck recovery are all server-side. Given
`move east 5`, the controller:

1. Tries a straight line first — open sky is the common case and A* would be pure cost there.
2. Falls back to bounded 3-D A* (`pathNodeBudget` expansions, `pathSearchRadius` blocks) with a
   penalty on cells that have something solid against a face, so a route goes through the middle
   of a gap rather than scraping its edge.
3. Falls back again to climbing to `cruiseAltitude` and searching from there.
4. Smooths the result down to the corners the drone actually has to turn at.
5. Replans if the drone grinds against something for 12 ticks, or makes no progress for
   `stuckTicks`. After `maxReplans` it gives up, reports `drone_stuck`, and fails the command.

---

## Perception payload

`GET /api/drones/{id}/perception` — about 3 KB whatever the world is doing, because every list is
capped and every region is summarised rather than enumerated.

```json
{
  "drone_id": "drone_01",
  "status": "available",
  "dimension": "minecraft:overworld",
  "game_time": 2180,
  "position": { "x": 0.5, "y": 76.97, "z": 0.5 },
  "velocity": { "x": 0, "y": -0.14, "z": 0 },
  "rotation": { "yaw": 0, "pitch": 0, "facing": "south" },
  "home": { "x": 0.5, "y": 76.48, "z": 0.39 },
  "environment": {
    "terrain": "settlement",
    "biome": "minecraft:snowy_taiga",
    "ground": "minecraft:grass_block",
    "altitude_above_ground": 6,
    "weather": "clear",
    "hazard_level": "moderate",
    "open_directions": ["north", "northeast", "east", "southeast", "up", "down"],
    "clearance": { "north": 10, "northeast": 10, "east": 7, "southeast": 4, "south": 3,
                   "southwest": 4, "west": 3, "northwest": 3, "up": 5, "down": 5 },
    "obstacles": [
      { "type": "spruce_tree", "direction": "northeast", "distance": 4.61, "size": 3,
        "position": { "x": 2, "y": 73, "z": -3 } },
      { "type": "building:stone_bricks", "direction": "north", "distance": 5.97, "size": 112,
        "position": { "x": 1, "y": 75, "z": -6 } }
    ],
    "hazards": [
      { "type": "fire", "direction": "east", "distance": 6.39, "size": 9,
        "position": { "x": 4, "y": 71, "z": 0 } }
    ],
    "resources": [
      { "type": "water", "direction": "southwest", "distance": 8.2, "size": 24,
        "position": { "x": -5, "y": 70, "z": 2 } }
    ],
    "block_counts": { "fire": 9, "lava": 0, "water": 0 }
  },
  "entities": [
    { "id": "drone_02", "type": "firekeep:drone", "category": "drone",
      "direction": "northeast", "distance": 13.42, "on_fire": false,
      "position": { "x": 7.5, "y": 77.0, "z": -11.0 } },
    { "id": "…uuid…", "type": "minecraft:cow", "category": "animal",
      "direction": "east", "distance": 17.18, "on_fire": false, "health": 10.0,
      "position": { "x": 6.5, "y": 70.0, "z": 4.5 } }
  ],
  "local_map": { "radius": 10, "vertical_radius": 5, "legend": "…", "grid": "…" }
}
```

Field notes:

- **`terrain`** — `dense_forest`, `forest`, `grassland`, `open_field`, `open_sky`, `open_water`,
  `mountainous`, `underground`, `desert`, `volcanic`, `settlement`, `urban`. `biome` is the
  authoritative climate; `terrain` describes the built and grown structure the biome cannot.
- **`clearance`** — blocks of free flight in each direction at the drone's own altitude.
  `open_directions` is the subset clear for at least `perception.openClearance` blocks.
- **`obstacles` / `hazards` / `resources`** — contiguous blocks are flood-filled into clusters, so
  twelve fire blocks on one roof arrive as one fire of `size: 12`. Named after the block they are
  mostly made of (`oak_tree`, `building:stone_bricks`). Nearest first, capped at `maxFeatures`.
  Terrain below the drone is *not* listed as an obstacle — that is the floor, and `ground` and the
  downward clearance already cover it.
- **`hazard_level`** — `none`, `minor`, `moderate`, `severe`.
- **`entities`** — `category` is `player`, `drone`, `hostile`, `animal` or `object`.
- **`local_map.grid`** — one character per block column, north at the top, east to the right, the
  drone in the middle:

```
####,,,ttt...ttt.....
####,,ttt.BBBBBB....t
####,tttttBBBBBB.....
###,,ttTttBBBBBBttt..
###,,tttttBBBBBBtttt.
TTTTttttt..ttt.ttTtt.
###tttttt.tttttttttt.
###tttttt.ttTtt.ttt..
###ttTttt.ttttt......
###tttttt..tttFFFttt.
###tttttt,D...FFFtttt
####tttt,,,...FFFtTtt
####...,,,,,....ttttt
```

`D` drone · `F` fire · `L` lava · `W` water · `T` tree trunk · `t` leaves · `,` ground cover ·
`B` building · `#` terrain · `o` obstacle · `!` hazard · `?` unloaded · `.` open ·
`P` player · `d` other drone · `x` hostile · `a` animal.

---

## Events

Pushed to `n8n.webhookUrl` as `POST` with `Content-Type: application/json` and, if `authValue` is
set, the `authHeader` header. Also kept in a 256-entry ring buffer readable at `GET /api/events`,
so a flow can be developed before there is a URL for it.

| `event` | When | Extra fields |
|---|---|---|
| `fire_detected` | A drone sees fire or lava it has not reported recently | `hazard`, `size`, `severity`, `direction`, `distance`, `terrain`, `biome`, `location`, `drone_position` |
| `disaster_detected` | Same, but the cluster is at least `disasterFireCells` blocks | as above |
| `drone_arrived` | A movement command completed | `command`, `command_id`, `location` |
| `drone_stuck` | Replanning stopped helping | `reason`, `replans`, `goal`, `location` |
| `drone_damaged` | The drone entered fire, lava or another hazard | `hazard`, `status`, `location` |
| `water_dispensed` | Fire was put out | `extinguished`, `lava_nearby`, `impact`, `location` |
| `command_failed` | Any command failed | `command`, `command_id`, `reason` |
| `drone_spawned` / `drone_removed` / `drone_offline` | Fleet membership changed | `location` |

Every event carries `event`, `drone_id` and `at` (epoch milliseconds).

```json
{ "event": "fire_detected", "drone_id": "drone_01", "at": 1787406891635,
  "hazard": "fire", "size": 9, "severity": "moderate",
  "direction": "east", "distance": 6.34,
  "terrain": "settlement", "biome": "minecraft:snowy_taiga",
  "dimension": "minecraft:overworld",
  "location": { "x": 4, "y": 71, "z": 0 },
  "drone_position": { "x": 0.5, "y": 76.42, "z": 0.5 } }
```

**De-duplication matters here.** A forest fire changes state every tick. Sightings are folded onto
an 8-block grid and rate-limited per cell by `fireEventCooldownSeconds`, so a flow gets one alert
per fire rather than twenty a second.

---

## Connecting it to n8n

### 1. Outbound — Minecraft tells n8n something happened

Add a **Webhook** node:

| Setting | Value |
|---|---|
| HTTP Method | `POST` |
| Path | `firekeep` |
| Authentication | *Header Auth* — name `X-Firekeep-Key`, value your shared secret |
| Respond | *Immediately* |

Copy its **production URL** into the mod config:

```json
"n8n": {
  "webhookUrl": "http://127.0.0.1:5678/webhook/firekeep",
  "authHeader": "X-Firekeep-Key",
  "authValue": "shared-secret-123"
}
```

Route on `{{ $json.event }}` with a **Switch** node: `fire_detected` and `disaster_detected` into
the dispatch branch, `drone_stuck` and `command_failed` into recovery, the rest into logging.

If you would rather poll than receive, skip the webhook and have a **Schedule Trigger** hit
`GET /api/events?limit=50`.

### 2. Inbound — n8n tells a drone what to do

Create one **Header Auth** credential and reuse it on every HTTP Request node:
name `Authorization`, value `Bearer <DRONE_API_KEY>`.

**Read the fleet**

| Setting | Value |
|---|---|
| Method | `GET` |
| URL | `http://127.0.0.1:8090/api/drones` |
| Authentication | Generic → Header Auth → the credential above |

**Read one drone's surroundings** — this is the node whose output you feed the model:

| Setting | Value |
|---|---|
| Method | `GET` |
| URL | `=http://127.0.0.1:8090/api/drones/{{ $json.drone_id }}/perception?fresh=true` |
| Authentication | Header Auth |

**Dispatch the nearest free drone to a fire** — let the mod choose which drone goes:

| Setting | Value |
|---|---|
| Method | `POST` |
| URL | `http://127.0.0.1:8090/api/dispatch` |
| Send Body | on, JSON |
| Body | `={{ JSON.stringify({ x: $json.location.x, y: $json.location.y + 6, z: $json.location.z }) }}` |

**Send the AI's decision**:

| Setting | Value |
|---|---|
| Method | `POST` |
| URL | `=http://127.0.0.1:8090/api/drones/{{ $json.drone_id }}/command?wait=true` |
| Send Body | on, JSON |
| Body | `={{ JSON.stringify($json.command) }}` |
| Timeout | `35000` (a little above the mod's 30 s default wait) |

Use `?wait=true` when the next step needs the outcome; omit it when fanning out to several drones
and let the events tell you how each one ended.

### 3. Shape of the agent loop

```
Webhook (fire_detected)
  └─► HTTP GET /api/drones                     what have we got
  └─► HTTP POST /api/dispatch                  who is closest and free
  └─► HTTP GET  /api/drones/{id}/perception    what does it see now
  └─► AI Agent                                 decide the next high-level move
  └─► HTTP POST /api/drones/{id}/command       do it
  └─► (loop back on drone_arrived)
```

Give the model the perception JSON verbatim and the command table from
[Commands](#commands) as its tool schema. It does not need to know anything about Minecraft
movement — `direction`, `distance` and coordinates are the whole vocabulary.

Ready-made bodies are in [`examples/n8n/`](examples/n8n/):
`command-move.json`, `command-move-to.json`, `command-dispense-water.json`,
`command-follow.json`, `command-patrol.json`, `dispatch.json`, `spawn.json`,
`event-fire-detected.json`, `perception-response.json`, and `curl-examples.sh`.

---

## Testing a drone by hand

```bash
KEY=$(python3 -c "import json;print(json.load(open('run/config/firekeep-drones.json'))['api']['apiKey'])")
API=http://127.0.0.1:8090/api
AUTH="Authorization: Bearer $KEY"
JSON="Content-Type: application/json"

# is it up?
curl -s $API/health

# spawn one and look around
curl -s -X POST -H "$AUTH" -H "$JSON" -d '{"id":"drone_01","x":0.5,"y":80,"z":0.5}' $API/drones
curl -s -H "$AUTH" "$API/drones/drone_01/perception?fresh=true"

# just the map
curl -s -H "$AUTH" "$API/drones/drone_01/perception?fresh=true" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['local_map']['grid'])"

# fly it, and wait for it to arrive
curl -s -X POST -H "$AUTH" -H "$JSON" \
  -d '{"command":"move","direction":"east","distance":10,"await":true}' \
  $API/drones/drone_01/command

curl -s -X POST -H "$AUTH" -H "$JSON" \
  -d '{"command":"move_to","x":120,"y":85,"z":-40,"await":true,"timeout_ms":60000}' \
  $API/drones/drone_01/command

# put a fire out, send the nearest drone somewhere, read the log
curl -s -X POST -H "$AUTH" -H "$JSON" -d '{"command":"dispense_water","await":true}' $API/drones/drone_01/command
curl -s -X POST -H "$AUTH" -H "$JSON" -d '{"x":120,"y":85,"z":-40}' $API/dispatch
curl -s -H "$AUTH" "$API/events?limit=20"
```

In-game, the pre-existing `/drone` commands still work for setup:
`/drone spawn <pos> <id>`, `/drone list`, `/drone goto`, `/drone stop`, `/drone remove`.

To make a fire to fly at:

```
/fill 20 70 0 22 70 2 minecraft:netherrack
/fill 20 71 0 22 71 2 minecraft:fire
```

---

## Limitations and what to build next

Known limits, in rough order of how likely they are to bite:

- **`dispense_water` does not carry water.** It removes fire blocks in a radius and plays the
  effect. There is no tank, no refill, and no reason a drone cannot do it forever. A capacity
  counter and a `refill` command that requires flying to a water source is the obvious next step —
  `DroneActions` is the only place that would change.
- **Lava is reported but never touched.** Turning a flow to stone is a terrain edit an autonomous
  agent should not make unasked; the count is there so a model can request one deliberately.
- **Pathfinding treats the drone as a point.** The tight-cell penalty keeps routes off walls in
  practice, but a genuinely one-block-wide gap may be planned through and then fail, recovering via
  the collision replan. A swept bounding-box check in `DronePathfinder.compute` would fix it
  properly at maybe 8× the block reads.
- **Routes are planned once, not maintained.** A fire that spreads across a planned route is only
  noticed when the drone stops making progress. Re-validating the remaining waypoints against each
  new perception snapshot would close that.
- **Perception is per-drone and momentary.** There is no shared world model; `GET /api/world`
  merely unions each drone's latest snapshot. A persistent hazard map with decay would let the AI
  reason about a fire front rather than about single sightings.
- **One command at a time, no queue.** A new order supersedes the old. `"queue": true` would be
  easy to add in `DroneController.begin`.
- **No per-drone rate limiting or audit log** on the API beyond the shared key. Fine on loopback,
  thin if you expose it.
- **`follow` only tracks drones and players**, not arbitrary mobs.
- **Vertical perception is shallow by default.** With `verticalRadius: 5` a drone flying at 20
  blocks up will not see the ground detail beneath it — `altitude_above_ground` and `ground` come
  from the heightmap and stay correct, but clusters do not. Raise the radius or fly lower.
- **Idle dedicated servers pause.** Set `pause-when-empty-seconds=0`, or drones freeze whenever no
  player is connected.
