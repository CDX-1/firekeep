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
