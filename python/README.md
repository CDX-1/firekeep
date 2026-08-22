# firekeep — minecraft → real

A server that waits for a Minecraft screenshot, turns it into a photorealistic
world with [World Labs' Marble](https://marble.worldlabs.ai), and serves the
results over a small JSON API.

## Run it

```sh
./server.py                 # 127.0.0.1:8000, waits for POSTs
./server.py --watch         # ...and auto-submits new Minecraft screenshots
./server.py --dry-run       # accepts captures, never calls the API, costs nothing
```

Stdlib only — nothing to install. The key comes from `.env`:

```
WORLDLABS_API_KEY=...
```

Wiring up the mod? Run with `--dry-run` and hammer it as hard as you like.

### Flags

| flag | |
|---|---|
| `--port 8000` | |
| `--host 127.0.0.1` | localhost only by default |
| `--model marble-1.0-draft` | default for incoming captures |
| `--watch` | auto-submit new screenshots from every Minecraft install found |
| `--watch-dir DIR` | watch an extra folder (repeatable) |
| `--workers 1` | concurrent generations |
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

Optional query params: `?model=`, `?prompt=`, `?pano=1`, `?source=`.
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
   "model": "marble-1.0-draft", "source": "firekeep-mod",
   "created": "2026-08-21T20:48:11+00:00", "took_seconds": 54.4,
   "world_id": "33ce9cb2-...", "marble_url": "https://marble.worldlabs.ai/world/...",
   "assets": { "preview": "preview.jpg", "pano": "pano.png" },
   "estimated_credits": 230, "error": null }]
```

`status` is `queued` → `generating` → `done`, or `failed` with `error` set.

### `GET /api/jobs/<id>`

One job, plus the full Marble `world` payload (mesh, splat and pano URLs).

### `GET /api/health`

`{ ok, credits, queued, busy, model, dry_run }`

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

### `GET /api/world/map.png`

That map: one pixel per block, painted with vanilla's own map palette and
north-facing relief shading. Ungenerated chunks are transparent. A few hundred
chunks take a couple of seconds the first time, then it is cached until the save
changes on disk.

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
| `server.py` | capture server: queue, workers, JSON API, folder watcher |
| `main.py` | one-shot CLI |
| `worldmap.py` | renders a save's region files into a top-down PNG (also a CLI) |
| `mapcolors.py` | block id -> vanilla map colour |
| `nbt.py` | minimal NBT reader, decode only |
| `viewer.html` | rough built-in viewer, served at `/` |
| `out/jobs/` | one folder per capture |
| `out/renders/` | every finished render as a plain PNG |
| `out/latest.png` | the newest one |
| `out/world/` | cached world maps, one PNG per dimension |

`.env` and `out/` are gitignored, and the server never serves anything outside
`out/jobs/`.
