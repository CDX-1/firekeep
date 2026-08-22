# Firekeep

Autonomous wildfire response. Drones watch, an agent decides, the fleet flies and fights.

Wildfires move faster than people can see, decide, and send crews. Firekeep is the incident-command loop that closes that gap: structured perception in, high-level orders out, no human in the middle of every move. **Minecraft is only the sandbox** — a world you can light on fire in a room, not a forest.

```
ops dashboard ─┐
n8n agent    ─┼─► python hub ─► Minecraft drones
world gen    ─┘         ▲
                        └── events, cameras, map
```

The hub (`python/server.py`) is the only process anything outside this machine talks to. Minecraft never sees n8n. n8n never sees Minecraft. The dashboard talks to neither.

## What it does

1. **See** — live per-drone cameras and a map that updates as fire spreads
2. **Predict** — a risk layer over that map (where it is, then where it goes next)
3. **Decide** — an n8n agent that issues `move_to`, `scan`, `dispense_water`, `return_home`
4. **Act** — drones pathfind, avoid collisions, and put fire out themselves
5. **Show** — the same scene reconstructed as a photoreal world (World Labs / Marble)

Perception is structured JSON from the game’s own block APIs. No screenshots and no computer vision in the decision loop.

## Layout

| | |
|---|---|
| [`fabric/`](fabric/README.md) | Minecraft 26.2 Fabric mod — drones, perception, flight, disasters |
| [`python/`](python/README.md) | The hub — fleet proxy, events, cameras, captures, world map |
| [`dashboard/`](dashboard/README.md) | Next.js ops center — feeds, map, sim, predictions, generated worlds |
| [`n8n/workflows/`](n8n/workflows/) | Patrol + autonomous fire-response agent |

## Run

Minecraft client with the Fabric mod loaded, then:

```sh
cd python && ./server.py          # http://127.0.0.1:8000
cd dashboard && npm run dev       # http://localhost:3000
```

Point the dashboard at a different hub with `MARBLE_SERVER=http://host:port`.

n8n workflows call the hub at `/api/fleet/*` and receive mod events from `/api/mod/events`. Details, keys, and the command table live in the piece READMEs above.
