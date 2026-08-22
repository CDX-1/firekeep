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

## Taking a good screenshot

Marble reconstructs whatever it sees, so a debug overlay becomes floating 3D text.

- `F1` hides the HUD, `F3` toggles the debug overlay off, `F2` captures
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
| `viewer.html` | rough built-in viewer, served at `/` |
| `out/jobs/` | one folder per capture |

`.env` and `out/` are gitignored, and the server never serves anything outside
`out/jobs/`.
