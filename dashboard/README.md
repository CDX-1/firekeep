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
ever sees one origin and there is no CORS to configure. Everything in `lib/api.ts`
goes through that prefix:

| dashboard calls | reaches |
|---|---|
| `/backend/api/health` | `GET /api/health` |
| `/backend/api/jobs` | `GET /api/jobs` |
| `/backend/jobs/<id>/pano.png` | that job's panorama |
| `/backend/capture` | `POST /capture` |

## Files

| | |
|---|---|
| `app/page.tsx` | the whole dashboard — job list, detail pane, upload |
| `lib/api.ts` | typed fetch helpers |
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
framebuffer and serves the frames over HTTP on port 8088. Next proxies that at `/camera`, the same
way `/backend` proxies Python, so the browser only ever talks to this origin:

```
GET /camera/drones                  live roster, polled once a second
GET /camera/drones/<id>/frame.jpg   newest single frame  (grid tiles)
GET /camera/drones/<id>/stream      MJPEG               (expanded viewer)
```

Point at a different machine with `FIREKEEP_CAMERAS=http://host:8088 npm run dev`.

Feeds exist only while the Minecraft **client** is running and has the drone loaded - the frames
are rendered by the game client, not the server. A drone nobody is looking at is not rendered at
all, so an idle dashboard costs the game nothing.

Tuning lives on the mod side, as system properties or `FIREKEEP_CAMERA_*` environment variables:
`firekeep.camera.port`, `.width`, `.height`, `.fps`, `.quality`.
