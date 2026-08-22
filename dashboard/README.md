# firekeep dashboard

Next.js front end for the Python capture server in `../python`.

## Run

Start the capture server first, then:

```sh
npm run dev        # http://localhost:3000
```

```sh
cd ../python && ./server.py      # http://127.0.0.1:8000
```

Point at a different backend with `MARBLE_SERVER=http://host:port npm run dev`.

## How it talks to Python

`next.config.ts` rewrites `/backend/*` to the Python server, so the browser only
ever sees one origin and there is no CORS to configure. That rewrite is the *only*
way out of this app - the dashboard has no route handlers and talks to nothing else:

| dashboard calls | reaches |
|---|---|
| `/backend/api/health` | `GET /api/health` |
| `/backend/api/jobs` | `GET /api/jobs` |
| `/backend/jobs/<id>/pano.png` | that job's panorama |
| `/backend/capture` | `POST /capture` |
| `/backend/api/world/stream` | the live world feed, as server-sent events |
| `/backend/api/cameras/feed` | every drone camera, down one connection |

Python is the midpoint: it is the piece that reaches the Minecraft server, the agent
directory and the World Labs API. Nothing in the browser knows any of their addresses.

## Files

| | |
|---|---|
| `app/page.tsx` | the whole dashboard — job list, detail pane, upload |
| `lib/api.ts` | typed fetch helpers |
| `lib/cameras.ts` | the camera endpoints, and which quadrant a drone is over |
| `lib/camera-feed.ts` | the multiplexed frame stream: one connection, every tile |
| `lib/use-cameras.ts` | the roster and per-drone frame hooks, in both transports |
| `lib/frames.ts` | the fair queue the polling fallback fetches stills through |
| `lib/types.ts` | `Job` / `Health`, mirroring `job.json` |
| `next.config.ts` | the `/backend` proxy |

## Notes

- Polls `/api/jobs` and `/api/health` every 2s. No websockets yet.
- Images use plain `<img>`, not `next/image` — they come through the proxy and
  don't need the optimizer.
- The list auto-follows the newest job until you click one.

## Drone camera feeds

Every drone in the world shows up on the dashboard by itself, with live video from its own camera.

The Fabric mod's **client** renders each watched drone's point of view into an offscreen
framebuffer and serves the frames over HTTP - one agent per drone, each on its own port. The
dashboard never touches those. The Python server resolves the agent directory, holds the
upstream streams open, and serves the whole fleet through `/backend`:

```
GET /backend/api/cameras                    the merged roster, once
GET /backend/api/cameras/feed?ids=a,b       roster + every frame, one connection
GET /backend/api/cameras/<id>/frame.jpg     newest single frame   (polling fallback)
GET /backend/api/cameras/<id>/stream        MJPEG                 (expanded viewer)
```

### The one you are looking at

A drone somebody has singled out - the expanded viewer, or a feed filling the grid on its own -
is rendered properly rather than as one thumbnail among twelve:

| | grid | selected |
|---|---|---|
| resolution | 480×270 | **854×480 – 1600×900**, matched to the panel |
| frame rate | 30 | **60** |
| JPEG quality | 0.7 | **0.85** |

The dashboard asks by adding `?profile=detail` to that drone's stream, plus the size it is
actually showing it at - measured from the panel and snapped to a few steps, so a window being
dragged does not reopen the stream on every frame. The rest lives on the agent, which is the
only side that can act on it. The request stands for a
few seconds and is renewed by every frame the stream carries, so closing the viewer puts that
drone back on thumbnails by itself - there is no "stop" to forget to send, and a dashboard that
crashes cannot leave a drone rendering at 720p for ever.

It can afford this because it is the moment the grid has *stopped* asking for anything: the tiles
are behind the overlay, so the frame budget that was being shared out goes to the one feed on
screen. The agent also lets that feed jump the queue, since it wants a frame several times as
often as a thumbnail does and would otherwise judder while the wall took its turns.

The viewer shows what it is actually getting - `1280×720 · 60 fps` along the bottom of the frame -
because that comes back on the roster from the agent rather than being what the dashboard asked
for.

### Frames do not go through React

A feed at 60fps is 60 renders a second per tile if each frame is state, and a wall of tiles
multiplies it - work done between the frame arriving and the frame appearing. `useDroneFrame`
holds the `<img>` and sets its `src` directly, so it re-renders exactly once: when the first
frame lands and the placeholder can go.

### The controls are a HUD

Flying is something you do while watching, so the controls sit on the picture rather than under
it: the pad bottom-left, altitude bottom-right, take-control and step size across the top. They
fade back when nobody is reaching for them and stay up while you have control. A grid tile gets
the bar without the pad - there is no room for one on a thumbnail.

Point Python at a different machine's fleet with `FIREKEEP_AGENTS` / `FIREKEEP_CAMERAS`;
see `../python/README.md`.

### Streaming, or polling

The grid does not poll. `lib/camera-feed.ts` reads one multipart response carrying the roster
and every visible drone's frames, so twelve tiles are one connection and each paints as the
agent renders it. Tiles register which drone they are showing; the union of that is what the
feed asks for, so a drone nobody is looking at is never pulled off the game at all.

Polling is still there, and there is a switch for it at the foot of the sidebar:

| | roster | frames |
|---|---|---|
| **Stream** | pushed as it changes, positions ~5×/s | pushed as they are rendered |
| **Poll** | `GET /api/cameras` every 1s (250ms while flying) | `frame.jpg` per tile, through the fair queue in `lib/frames.ts` |

The page starts on the stream and falls back on its own if it cannot open one - three failed
attempts and the tiles go back to asking, with the sidebar saying so. Choosing **Stream** again
retries from scratch. Polling is worth keeping for exactly two reasons: something between the
browser and Python may refuse to pass a streaming response, and being able to turn the clever
transport off is the quickest way to find out whether a blank grid is Minecraft's fault or the
stream's.

Feeds exist only while the Minecraft **client** is running and has the drone loaded - the frames
are rendered by the game client, not the server. A drone nobody is looking at is not rendered at
all, so an idle dashboard costs the game nothing.

Tuning lives on the mod side, as system properties or `FIREKEEP_CAMERA_*` environment variables:
`firekeep.camera.port`, `.width`, `.height`, `.fps`, `.quality`, and the same four under
`.detail.` for the selected-feed profile.
