# firekeep — minecraft → real

The hub. Everything goes through here: n8n reaches the drones through it, Minecraft reports
back through it, the dashboard reads from it, and it turns a screenshot into a photorealistic
world along the way. It is the only process meant to be exposed — see [The hub](#the-hub).

## Run it

```sh
./server.py                 # 127.0.0.1:8000, waits for POSTs
./server.py --watch         # ...and auto-submits new Minecraft screenshots
./server.py --dry-run       # accepts captures, never calls the API, costs nothing
```

Stdlib only — nothing to install, and no key needed: n8n holds the World Labs
credentials. `.env` is only read by the older `marble` backend and by `main.py`:

```
WORLDLABS_API_KEY=...
```

### Two backends

| backend | who does the work |
|---|---|
| `wildfire` (default) | POSTs the screenshot to the n8n `minecraft-wildfire` workflow, which captions the shot, writes its own prompt, and calls World Labs itself |
| `marble` | this server calling the Marble API directly with the key above, on the model you picked |

Wildfire is the default, so a `/screenshot` in game goes to n8n and this server
never touches the World Labs API. `--model` and `--prompt` are ignored on that
path — n8n picks both — and the prompt it wrote comes back on the job as
`generated_prompt`.

The direct path is still there when you want it: `--backend marble`, or
`POST /capture?backend=marble` for one capture. That one needs the key, spends
credits, and honours `--model`/`--prompt`.

## The hub

This server is the only process anything outside this machine talks to. Minecraft, n8n and the
dashboard all reach each other through it, and none of them holds an address or a key for any
of the others:

```
                       ┌──────────────── server.py ────────────────┐
   n8n ──(tunnel)──────▶  /api/fleet/*   ──────────────────────────▶  Minecraft  127.0.0.1:8090
                       │  /api/mod/events ◀───────────────────────── (it POSTs here)
   n8n ◀───────────────┤  forwards those on, with its own key
                       │  /api/live, /api/world/stream, /api/cameras
   dashboard ─────────▶│  /api/events, /api/drones/*, /capture
                       │
                       └──▶ n8n webhooks · the Marble API · the save on disk · the agents
```

Which means, concretely:

- **n8n never sees Minecraft.** It calls `/api/fleet/...` here, and this server calls the mod's
  control API on loopback with the mod's bearer token. Everything the mod exposes is available
  under that prefix, verb, query and body unchanged — `/api/fleet/drones`,
  `/api/fleet/drones/<id>/perception?fresh=true`, `/api/fleet/dispatch`, and so on. The mod's
  status codes come back as themselves, so a 404 for an unknown drone is still a 404.
- **Minecraft never sees n8n.** The mod POSTs what it noticed to `/api/mod/events`; this server
  keeps it and forwards it to the workflow. `GET /api/mod/events?limit=&event=&drone_id=&since=`
  replays them for a workflow that missed a webhook.
- **Only this port is exposed.** Point the Cloudflare tunnel here, not at 8090. The mod's API
  stays bound to loopback, where the only thing that can reach it is this process.

### Keys

| | |
|---|---|
| `FIREKEEP_API_KEY` | what this server demands of anything not on this machine. Also `--api-key`. Unset means open — fine on a laptop, not behind a tunnel |
| `DRONE_API_KEY` | the mod's key, from `fabric/run/config/firekeep-drones.json`; this server presents it when calling the mod |
| `FIREKEEP_MINECRAFT` | where the mod is (default `http://127.0.0.1:8090`). Also `--minecraft` |
| `FIREKEEP_N8N_BASE` | the n8n webhook base (default `https://smallwoken.app.n8n.cloud/webhook`) |
| `FIREKEEP_N8N_EVENTS` | webhook for forwarded mod events — a full URL, a bare path, or `off` (default `firekeep-events`) |
| `FIREKEEP_N8N_KEY` | sent to n8n as `X-Firekeep-Key`, if set |
| `FIREKEEP_N8N_WILDFIRE` | the world-generation webhook (default `minecraft-wildfire`) |
| `FIREKEEP_AGENTS` | the Fabric server's agent directory (default `http://127.0.0.1:8087`) |
| `FIREKEEP_CAMERAS` | the one agent to use when there is no directory (default `http://127.0.0.1:8088`) |
| `SPURIC_API_KEY` | the analyst that writes incident reports; `QWEN_API_KEY` is accepted as the older name. Unset leaves reports built from the numbers alone |
| `SPURIC_BASE_URL` | OpenAI-compatible base for it (default `https://ai.spuric.com/v1`) |
| `SPURIC_MODEL` | which model writes them (default `spur-qwen3-235b`) |

`FIREKEEP_API_KEY` is only asked for when the caller is not local. A request is local when the
socket is loopback *and* nothing forwarded it: `cloudflared` runs on this machine too, so the
tunnel's traffic also arrives from 127.0.0.1 — what gives it away is the `CF-Connecting-IP` it
sets. `GET /api/health` is always open, so a probe can tell "down" from "rejected".

`/api/health` reports both links, which is usually enough to say which side is broken:

```json
{ "ok": true,
  "minecraft": { "url": "http://127.0.0.1:8090", "keyed": true, "online": true },
  "n8n": { "events_url": "...", "online": true, "sent": 41, "dropped": 0, "queued": 0 },
  "secured": true }
```

Wiring up the mod? Run with `--dry-run` and hammer it as hard as you like.

### Flags

| flag | |
|---|---|
| `--port 8000` | |
| `--host 127.0.0.1` | localhost only by default |
| `--backend wildfire` | who generates: `wildfire` (n8n) or `marble` (direct) |
| `--model marble-1.0-draft` | model for `--backend marble`; wildfire picks its own |
| `--watch` | auto-submit new screenshots from every Minecraft install found |
| `--watch-dir DIR` | watch an extra folder (repeatable) |
| `--workers 1` | concurrent generations |
| `--api-key KEY` | require this bearer token from anything off this machine (default `$FIREKEEP_API_KEY`) |
| `--minecraft URL` | the mod's control API (default `$FIREKEEP_MINECRAFT`, else `http://127.0.0.1:8090`) |
| `--dry-run` | no API calls, no credits |
| `--prompt "..."` | style guidance |
| `--save DIR` | Minecraft save to map (default: newest under `fabric/run/saves`) |

## From inside Minecraft

The Fabric mod adds a client-side command. Point it at a running server and it
grabs the frame, uploads it, and follows the job in chat until the PNG lands.

```
/screenshot                            capture with the server's default model and prompt
/screenshot <prompt...>                capture with your own style guidance
/screenshot model <model> [<prompt>]   capture on a specific Marble model
/screenshot status                     server health, credits, queue depth
/screenshot server [<url>]             show or change where captures are sent
```

The capture waits for the chat screen to close and hides the HUD first, so no
hotbar or chat text ends up reconstructed as floating 3D geometry. Frames are
downscaled to 1920px on the long edge before upload.

By default it talks to `http://127.0.0.1:8000`. Override it without recompiling
with the `FIREKEEP_SERVER` environment variable or the `firekeep.server` system
property, or at runtime with `/screenshot server <url>`.

Wiring the mod up for the first time? Run the server with `--dry-run`: captures
are accepted, the screenshot is echoed straight back out to `out/renders/`, and
nothing is generated or charged.

## API

### `POST /capture`

Raw PNG or JPEG bytes as the body. Returns immediately; generation is async.

```sh
curl -X POST --data-binary @shot.png localhost:8000/capture
```

```json
{ "job_id": "ae8bf450df99", "status": "queued",
  "estimated_credits": 230, "url": "/api/jobs/ae8bf450df99" }
```

Optional query params: `?backend=`, `?model=`, `?prompt=`, `?pano=1`, `?source=`.
Set `X-Source: <name>` to label where a capture came from.

From Java:

```java
var conn = (HttpURLConnection) new URL("http://127.0.0.1:8000/capture").openConnection();
conn.setRequestMethod("POST");
conn.setRequestProperty("X-Source", "firekeep-mod");
conn.setDoOutput(true);
try (var out = conn.getOutputStream()) { out.write(pngBytes); }
```

### `GET /api/jobs`

Every job, newest first. Poll this for a dashboard.

```json
[{ "id": "ae8bf450df99", "status": "done", "progress": 100,
   "backend": "marble", "model": "marble-1.0-draft", "source": "firekeep-mod",
   "created": "2026-08-21T20:48:11+00:00", "took_seconds": 54.4,
   "world_id": "33ce9cb2-...", "marble_url": "https://marble.worldlabs.ai/world/...",
   "assets": { "preview": "preview.jpg", "pano": "pano.png" },
   "estimated_credits": 230, "error": null }]
```

`status` is `queued` → `generating` → `done`, or `failed` with `error` set.

A wildfire job looks the same, with `backend: "wildfire"`, `world_url` instead
of a Marble URL, `generated_prompt` set to whatever n8n wrote, and
`estimated_credits: 0` — the workflow is not spending our credits.

### `GET /api/jobs/<id>`

One job, plus the full Marble `world` payload (mesh, splat and pano URLs).

### `GET /api/health`

`{ ok, credits, queued, busy, model, backend, backends, dry_run, live, watchers, cameras,
minecraft, n8n, secured }`

`credits` is `null` on a wildfire server — the balance being spent is not ours.
On a marble server it is the Marble balance, cached for a minute so a polling
dashboard does not turn into a stream of API calls.

`minecraft` and `n8n` describe the two links this server sits between, and this is the one
route that answers without a key, so a probe through the tunnel can always find out which side
is down.

### `ANY /api/fleet/<the mod's path>`

The mod's control API, re-served. Method, query string and body go through untouched, the
mod's reply and its status code come back untouched, and this server supplies the one thing a
workflow should not have to hold: where Minecraft is and what token it wants.

```sh
curl -H "Authorization: Bearer $FIREKEEP_API_KEY" localhost:8000/api/fleet/drones
curl -H "Authorization: Bearer $FIREKEEP_API_KEY"      "localhost:8000/api/fleet/drones/drone_01/perception?fresh=true"
curl -X POST -H "Authorization: Bearer $FIREKEEP_API_KEY" -H 'Content-Type: application/json'      -d '{"command":"move_to","x":20,"y":85,"z":-10}'      "localhost:8000/api/fleet/drones/drone_01/command?wait=true"
curl -X POST -H "Authorization: Bearer $FIREKEEP_API_KEY" -H 'Content-Type: application/json'      -d '{"x":20,"y":85,"z":-10}' localhost:8000/api/fleet/dispatch
```

`?wait=true` asks the mod to hold its reply until the drone has actually finished, so the
timeout on that call is a flight's worth of patience (two minutes) rather than a request's.
See `fabric/README.md` for every command and what each one does.

If Minecraft is not running, these answer `503` with `"Minecraft is not reachable at ..."` —
never a 200 with an empty roster, because a workflow cannot tell those apart.

### `POST /api/mod/events`

What Minecraft noticed: `fire_detected`, `disaster_detected`, a command's outcome. The mod
posts here rather than at a webhook, so it holds no URL and no secret for anything outside this
machine. Each event is kept and forwarded to `FIREKEEP_N8N_EVENTS`.

```json
{ "event": "fire_detected", "drone_id": "alpha", "at": 1750000000000,
  "payload": { "hazard": "fire", "size": 14, "location": { "x": 120, "y": 70, "z": -44 } } }
```

`GET /api/mod/events?limit=50&event=fire_detected&drone_id=alpha&since=<ms>` replays them,
newest first — which is how a workflow catches up on what it missed while it was down. `event`
takes a comma-separated list.

Forwarding is fire-and-forget: a workflow that is down, slow or not deployed yet cannot stall
the mod, and a full queue sheds its oldest event rather than the newest report of a fire.

### `POST /api/drone-events`

Accepts a workflow's conclusion about an incident seen by a drone. It appears in that drone's
camera-feed event overlay; it does not move the drone or change the Minecraft world. Reusing
`event_id` makes a workflow retry update the same event instead of creating a duplicate.

```json
{
  "event_id": "fire-overworld-120-70--44",
  "drone_id": "alpha",
  "type": "fire_detected",
  "severity": "high",
  "message": "Fire detected near the treeline.",
  "location": { "x": 120, "y": 70, "z": -44, "dimension": "minecraft:overworld" }
}
```

`GET /api/drone-events?drone_id=alpha` returns that overlay's recent event history.

### `POST /api/incidents`

Has one drone photograph what it can see, and writes the result up as an incident report. This
is the pipeline the dashboard's **Incident reports** tab shows:

```
 drone camera ──▶ photographs ──▶ n8n minecraft-wildfire ──▶ caption + generated view
                       │                                              │
 live feed ────────────┴──▶ map of the affected area ─────────────────┴──▶ the analyst ──▶ report
```

```json
{ "drone_id": "alpha", "shots": 3, "note": "smoke reported to the north-east", "radius": 96 }
```

Only `drone_id` is required. `shots` (1-8) is how many frames the drone takes, a second apart;
`radius` (32-512 blocks) is how far around it counts as the incident. Answers `202` with the
record as soon as the photographs are in hand.

The rest arrives in three settlings, because the parts take nothing like the same time:

| | |
|---|---|
| ~1s | the photographs and `map.png` — both made from readings this process already holds |
| ~1min | `status: done`, with the write-up. n8n runs a vision model over the photograph before it acknowledges it, and that caption is what the analyst is given |
| ~5min | `generated` — the world n8n built from the shot, attached to a report that has been readable the whole time |

That last wait is why the report does not sit behind it: nobody reading about a fire should be
kept waiting on a picture of one. `generating` is true while it is still coming, and collecting
happens on its own threads, so a second report is never queued behind the first one's image.

Nothing in that chain can fail the report. n8n unreachable costs the generated image and the
caption; no `SPURIC_API_KEY` costs the prose and leaves a write-up built from the numbers, which
is what `report.source` distinguishes. Without a caption nothing describes the photograph — the
analyst is told to say so rather than to guess at one it has not seen:

```json
{
  "id": "inc-9ee0f835c2",
  "status": "done",
  "drone_id": "alpha",
  "photos": ["photo-1.jpg", "photo-2.jpg", "photo-3.jpg"],
  "generated": "pano.png",
  "generated_prompt": "A wide grassland under heavy smoke ...",
  "map": "map.png",
  "map_meta": { "origin_x": -96, "origin_z": -96, "width": 193, "height": 193, "scale": 3 },
  "scene": { "position": { "x": 0, "y": 74, "z": 0, "yaw": 315 }, "fires_nearby": 1398,
             "nearest_fire": 35.4, "events": [], "observations": [] },
  "report": {
    "source": "ai",
    "severity": "critical",
    "headline": "Fire front 35 blocks north-east of alpha",
    "summary": "...", "spread": "...", "impact": "...", "actions": ["..."]
  }
}
```

A finished report is also pushed to n8n as an `incident_report` event, so a workflow that asked
for one does not have to poll for it.

### `GET /api/incidents`

Every report, newest first, and whether the analyst has a key. The burning columns each report
was drawn from are left out here - there are thousands of them and the map is what they were
for; `GET /api/incidents/<id>` has the whole record.

### `GET /incidents/<id>/<file>`

`photo-1.jpg`, `map.png`, the generated `pano.png`, `world.json`, `incident.json`.

### `GET /jobs/<id>/<file>`

`pano.png`, `preview.jpg`, `source.png`, `world.json`.

### `GET /latest.png`

The most recent finished render, straight as an image.

### `GET /api/world`

Metadata for a top-down map of the live save, read straight off the region
files - no mod and no running game needed.

```json
{ "name": "New World", "dimension": "overworld",
  "origin_x": -288, "origin_z": -240, "width": 480, "height": 432,
  "blocks_per_pixel": 1, "chunks": 788, "spawn": { "x": 0, "y": 77, "z": 0 } }
```

`origin_x`/`origin_z` are the block coordinates of the map's top-left pixel,
which is what turns a pixel back into a position in the world.

Add `?dimension=the_nether` or `the_end` for the other two, and `?refresh=1` to
re-render before Minecraft has written the region files again.

### `POST /api/live`

The mod's live world feed. It pushes every surface column that changed, a few times a
second, so the map can show a fire spreading instead of whatever the last autosave caught.

```json
{ "session": "3f9c1a04", "dimension": "minecraft:overworld", "tick": 84213,
  "columns": [12, -7, 16733726, 13, -7, 4276545],
  "drones": [{ "id": "drone-1", "x": 12.5, "y": 91.0, "z": -7.25, "yaw": 132.0,
               "target": [40, 91, 12] }] }
```

`columns` is flat - x, z, packed - where packed carries flags in its top byte (bit 0 means
the column is on fire or under lava) and the map colour in the low three. A new `session`
means the world restarted and anything held from before is about somewhere else.

The reply carries any drone orders the dashboard has queued, so an order costs no extra
round trip:

```json
{ "ok": true, "columns": 2, "hot": 41, "watchers": 1,
  "commands": [{ "id": "drone-1", "fly": true, "forward": 1, "right": 0, "up": 0, "yaw": 0 }] }
```

### `POST /api/drones/goto`

`{ "id": "drone-1", "x": 40, "y": 91, "z": 12 }` - queues a flight for the mod to collect.

### `POST /api/drones/fly`

`{ "id": "drone-1", "forward": 1, "right": 0, "up": 0, "yaw": 0 }` - Minecraft-style stick
in the camera frame. The drone keeps that velocity until a hover or goto. Zeros hover.

### `POST /api/drones/look`

`{ "id": "drone-1", "pitch": 25 }` - tilts the camera 25 degrees down without changing the
drone's active flight. Pitch ranges from `0` (level) to `90` (straight down).

### `POST /api/drones/hover`

`{ "id": "drone-1" }` - brakes and holds.

### `POST /api/drones/spawn`

`{ "x": 40, "z": 12 }` - puts a new drone into the world there, on the same queue as a flight
order. `y` is optional and normally left out: the world map is top-down, so the mod drops the
drone just above the ground rather than the dashboard guessing an altitude. `id` is optional too;
without one the mod names it. The mod launches a rendering agent for the new drone as soon as it
exists, so it turns up on the camera wall as well as the map - up to `maxAgents` in
`fabric/run/config/firekeep-agents.json`.

### `GET /api/live`

What the feed knows right now: bounds, chunk count, which columns are burning, where the
drones are, and `live` - false once the mod has been quiet for six seconds.

### `GET /api/world/stream`

Server-sent events. One `hello` with the above, a `delta` for every batch the mod pushes,
and a `status` heartbeat every 15s.

```sh
curl -N localhost:8000/api/world/stream
```

The stream sets `Cache-Control: no-transform`, without which the dashboard's dev proxy
gzips it - and a buffered event stream never reaches the browser.

### `GET /api/world/live.png`

Everything the feed has seen, as one RGBA image, transparent where nothing is known. The
dashboard loads this once on connect and patches it from the stream after that.

### `GET /api/cameras`

The drone cameras, merged from every agent. Each drone is filmed by its own Minecraft
client on its own port; the server resolves the agent directory the Fabric server
publishes at `:8087/agents` and asks all of them, so the dashboard sees one roster.

```json
{ "drones": [{ "id": "alpha", "x": 12.5, "y": 91.0, "z": -7.25, "yaw": 132.0,
               "width": 480, "height": 270, "fps": 30, "live": true, "frames": 812 }],
  "clientFps": 58, "agents": 2, "online": true, "watchers": 1, "revision": 41 }
```

Positions are merged from the mod's live feed when it is running, so they are as fresh as
the world feed rather than as fresh as the last time an agent was asked.

### `GET /api/cameras/feed?ids=alpha,bravo`

Every one of those drones' frames, and the roster, down a single connection - the
dashboard's grid, whatever its size, is one socket and no polling at all.

A `multipart/x-mixed-replace` stream. Parts carry `X-Firekeep-Event: roster` (a JSON body,
sent on connect and whenever anything changes) or `X-Firekeep-Event: frame` with
`X-Drone-Id`. `?fps=` caps how often each drone's frames are forwarded, 8 by default.

```sh
curl -N "localhost:8000/api/cameras/feed?ids=alpha&fps=2" --output -
```

One upstream stream is held open per drone *anyone* is watching, not per dashboard: ten
tabs on six drones is six conversations with Minecraft, not sixty. A drone nobody has
subscribed to is not pulled at all, so an idle dashboard costs the game nothing.

### `GET /api/cameras/<id>/stream`

That one drone's MJPEG, passed straight through - for a plain `<img>`.

### `GET /api/cameras/<id>/frame.jpg`

The newest single frame, served from the open stream if there is one and fetched from the
agent if there is not. This is what a dashboard in polling mode asks for.

### `?profile=detail`

Both of the above take it, and it is forwarded to the agent unchanged. It means *somebody is
looking at this one*, and the agent renders that feed at 1280×720, 60fps and high JPEG quality
instead of the 480×270 thumbnail it gives the grid.

```sh
curl -N "localhost:8000/api/cameras/alpha/stream?profile=detail" --output -
```

The request stands for a few seconds on the agent and is renewed by every frame the stream
carries, so a feed drops back to thumbnails on its own once the connection closes. Heavier
requests win while they last, so a grid tile still asking for its thumbnail cannot pull a feed
back down underneath the viewer. `GET /api/cameras` reports what each feed is *actually* being
rendered at, so `width`/`height`/`fps` change while a drone is being watched closely and
`detail` says whether it is.

A detail request is never answered from a thumbnail already in hand - it goes to the agent and
asks properly - while a thumbnail request is happily answered from a detail stream that is
already open.

The dashboard also sends `&width=&height=` for the size it is actually showing the feed at,
snapped to 854x480, 1280x720 or 1600x900 - a 1280-wide frame stretched over a 2000-pixel panel
is soft, and a 1600-wide one in a thumbnail is bytes nobody sees. Anything past 1920x1080 is
clamped here before it reaches the agent.

Tuning is on the agent, as system properties or environment variables:
`firekeep.camera.detail.width` / `.height` / `.fps` / `.quality`, or
`FIREKEEP_CAMERA_DETAIL_WIDTH` and friends. `firekeep.camera.encoders` sets how many frames may
be turned into JPEGs at once, which is the setting that decides whether a fast feed can keep up
at all - see below.

### What actually limits a feed

Measured, on one frame:

| | encode | one thread | four threads |
|---|---|---|---|
| 480x270 q0.70 | 3.1 ms | 323 fps | plenty |
| 1280x720 q0.85 | 27.7 ms | 36 fps | ~144 fps |
| 1600x900 q0.85 | 43.3 ms | 23 fps | ~92 fps |

JPEG encoding, not rendering and not the network, is the narrow part. It was being done on two
threads, so a feed asking for 60 could not have it however fast the game was drawing - and the
agent's own frame-rate cap was derived from the thumbnail rate, pinning the whole client at 35.
Both are fixed; the encoder pool now scales with the machine.

The remaining ceiling is the game itself: captures ride on rendered frames, one drone per frame,
so every feed on an agent shares its frame rate. A wall of twelve thumbnails is inherently a few
frames a second each - which is why the feed being watched is allowed to jump the queue.

### `GET /api/world/map.png`

That map: one pixel per block, painted with vanilla's own map palette and
north-facing relief shading. Ungenerated chunks are transparent. A few hundred
chunks take a couple of seconds the first time, then it is cached until the save
changes on disk.

## Two maps, one picture

The map is drawn from two sources and needs both:

| | knows | freshness |
|---|---|---|
| `worldmap.py`, off disk | the whole explored world | last autosave, so up to ~5 min stale |
| `live.py`, from the mod | only chunks that are loaded | as it happens |

Region files are the only place the *whole* world exists, but Minecraft writes them on
autosave, so nothing read from disk can ever be live. The mod sees every block change the
instant it happens, but only for chunks near a player. The dashboard draws the feed over
the baseline, so you get a complete map that is live where anything is actually happening.

## What you get back

Per finished job, on disk in `out/jobs/<id>/`:

| file | |
|---|---|
| `pano.png` | 2304×1152 equirectangular 360 photo — **the sharpest output** |
| `preview.jpg` | thumbnail render of the 3D world |
| `source.png` | the screenshot that went in |
| `world.json` | full payload: splat URLs (100k/500k/full), collider mesh, caption |
| `job.json` | the job record |

The pano is noticeably sharper than the splats, because the splat world is a
reconstruction *of* the pano. If you only want images, the pano is the one.

The job folder is the archive. For actually looking at results, every finished
job also drops its pano into `out/renders/<timestamp>-<id>.png` and copies it to
`out/latest.png`, so there is always one obvious file to open. That path comes
back on the job as `result_png`, which is what the mod prints in chat.

## Cost

$1.00 per 1,250 credits. A capture is the world plus an 80-credit pano step.

| model | credits/capture | |
|---|---|---|
| `marble-1.0-draft` | 230 (~$0.18) | **server default** — ~50s |
| `marble-1.0` / `marble-1.1` | 1,580 (~$1.26) | ~5 min |
| `marble-1.1-plus` | 1,580–3,080 | best quality |

The server defaults to draft on purpose: captures fire automatically, and 1,580
credits a shot adds up fast. `main.py` defaults to `marble-1.1` since you run it
deliberately.

**Feed it a panorama and the 80-credit pano step drops to 0.** Vanilla Minecraft
takes real 360 panoramas with `Ctrl+F2` (six cubemap faces). Stitch those to
equirect, POST with `?pano=1`, and you get better geometry for less — the back
half of the scene is real instead of invented.

## Getting realism out of it

Marble's default instinct is to stay faithful to the input, which on a Minecraft
frame means smoother, better-lit Minecraft. Two things push it off that:

**The prompt.** `marble.DEFAULT_PROMPT` explicitly asks it to keep the layout but
throw the art style away - no blocks, no voxels, no pixelated textures, real bark
and leaves and rock at human proportions. Asking it to "keep the composition"
without that second half is what gets you Minecraft back. Override per capture
with `--prompt`, `?prompt=`, or `/screenshot <prompt...>` in game.

**The model.** `marble-1.0-draft` is the server default because captures can fire
automatically and 1,580 credits a shot adds up - but draft is also the one that
clings hardest to the input. If a scene comes back too blocky, re-run it on
`marble-1.1`, which has far more room to reinterpret geometry:

```sh
./server.py --model marble-1.1
```

or per capture, without restarting anything: `/screenshot model marble-1.1`.

## Taking a good screenshot

Marble reconstructs whatever it sees, so a debug overlay becomes floating 3D text.

- `/screenshot` hides the HUD for you; `F3` still has to be off
- Taking one by hand: `F1` hides the HUD, `F2` captures
- Wide scenes with real depth work best

## One-shot, without the server

```sh
./main.py                            # newest screenshot, marble-1.1
./main.py --shot foo.png --model marble-1.0-draft
./main.py --list
```

Writes into the same `out/jobs/<id>/` layout.

## Files

| | |
|---|---|
| `marble.py` | World Labs API client |
| `wildfire.py` | client for the n8n `minecraft-wildfire` workflow |
| `minecraft.py` | the only way out of this process and into the game: the mod's loopback API |
| `n8n.py` | everything sent *to* n8n, and the one place its URLs and keys live |
| `server.py` | the hub: queue, workers, JSON API, the fleet proxy, folder watcher |
| `main.py` | one-shot CLI |
| `worldmap.py` | renders a save's region files into a top-down PNG (also a CLI) |
| `live.py` | the live world layer: the mod's feed, and the stream out to dashboards |
| `cameras.py` | the drone cameras: the agent directory, one pull per drone, one stream out |
| `incidents.py` | incident reports: the photographs, the map of the affected area, the pipeline |
| `analyst.py` | the one place a language model is asked for prose |
| `mapcolors.py` | block id -> vanilla map colour |
| `nbt.py` | minimal NBT reader, decode only |
| `viewer.html` | rough built-in viewer, served at `/` |
| `out/jobs/` | one folder per capture |
| `out/renders/` | every finished render as a plain PNG |
| `out/latest.png` | the newest one |
| `out/world/` | cached world maps, one PNG per dimension |
| `out/incidents/` | one folder per report: its photographs, its map, its write-up |

`.env` and `out/` are gitignored, and the server never serves anything outside
`out/jobs/` and `out/incidents/`.
