#!/usr/bin/env python3
"""
The live half of the world map.

worldmap.py reads region files and gives you the whole explored world as it was at the
last autosave. This module holds what has happened *since*: the mod POSTs every surface
column that changed - fire spreading, blocks burning away, a drone digging - and this
keeps them in memory and fans them out to every connected dashboard.

The two layers are complementary and neither replaces the other. Disk knows the whole
world but is minutes stale; the feed is instant but only knows chunks that are loaded.
The dashboard draws the feed on top.

This is also where the dashboard's orders wait: drone flights and the simulator's disasters
are parked here and handed to the mod in the reply to its next push, since nothing out here
can call into Minecraft.

Columns are stored per chunk as 256 packed uint32s (flags << 24 | rgb, 0 meaning "never
seen"), which keeps a long session's overlay to about a kilobyte per chunk.
"""

import base64
import json
import queue
import struct
import threading
import time
import uuid
import zlib
from array import array

CHUNK = 16
COLUMNS = CHUNK * CHUNK
HOT = 1 << 0                      # the column is on fire or covered in lava

#: A feed older than this is reported stale - the mod quit, or Minecraft is not running.
STALE_AFTER = 6.0
#: Cap on retained chunks, oldest evicted first. 20k chunks is a 2240-block square.
MAX_CHUNKS = 20_000
#: Dropped into every idle SSE connection so proxies do not time it out.
HEARTBEAT = 15.0

#: How long an order waits for the mod to collect it before it is dropped.
COMMAND_TTL = 30.0

#: The disasters the dashboard may set off. See Disasters.java for what each one does in game.
EVENT_KINDS = ("fire", "lightning", "explosion", "extinguish")
#: How many past events are kept for the dashboard's log.
MAX_EVENTS = 200
#: Bounds on what an event may ask for, matching the caps the mod enforces on its own side.
MAX_EVENT_RADIUS = 128
MAX_EVENT_INTENSITY = 256

_LOCK = threading.Lock()
_WORLDS = {}                      # dimension -> _World
_SUBSCRIBERS = []                 # list of queue.Queue
_COMMANDS = []                    # drone orders waiting for the mod to pick them up
_EVENTS = []                      # the disaster log, oldest first


class _World:
    """Everything the feed has told us about one dimension."""

    def __init__(self, dimension, session):
        self.dimension = dimension
        self.session = session
        self.chunks = {}          # (cx, cz) -> array('I', 256 entries)
        self.order = []           # chunk keys, oldest first, for eviction
        self.hot = set()          # (x, z) of burning columns
        self.drones = {}          # id -> dict
        self.tick = 0
        self.updated = 0.0
        self.png = None           # cached overlay, invalidated on every write
        self.png_meta = None

    # -- writing ----------------------------------------------------------

    def put(self, x, z, packed):
        key = (x >> 4, z >> 4)
        chunk = self.chunks.get(key)
        if chunk is None:
            if len(self.order) >= MAX_CHUNKS:
                self._evict()
            chunk = array("I", bytes(COLUMNS * 4))
            self.chunks[key] = chunk
            self.order.append(key)
        chunk[(z & 15) * CHUNK + (x & 15)] = packed

        if packed >> 24 & HOT:
            self.hot.add((x, z))
        else:
            self.hot.discard((x, z))

    def _evict(self):
        while self.order and len(self.order) >= MAX_CHUNKS:
            key = self.order.pop(0)
            chunk = self.chunks.pop(key, None)
            if chunk is None:
                continue
            base_x, base_z = key[0] * CHUNK, key[1] * CHUNK
            for i in range(COLUMNS):
                if chunk[i] >> 24 & HOT:
                    self.hot.discard((base_x + i % CHUNK, base_z + i // CHUNK))

    # -- reading ----------------------------------------------------------

    def bounds(self):
        """(origin_x, origin_z, width, height) covering every known chunk."""
        if not self.chunks:
            return None
        xs = [key[0] for key in self.chunks]
        zs = [key[1] for key in self.chunks]
        return (min(xs) * CHUNK, min(zs) * CHUNK,
                (max(xs) - min(xs) + 1) * CHUNK, (max(zs) - min(zs) + 1) * CHUNK)

    def overlay(self):
        """The whole live layer as an RGBA PNG, transparent where nothing is known."""
        if self.png is not None:
            return self.png, self.png_meta

        box = self.bounds()
        if box is None:
            return None, None
        origin_x, origin_z, width, height = box

        pixels = bytearray(width * height * 4)
        for (cx, cz), chunk in self.chunks.items():
            base_x = cx * CHUNK - origin_x
            base_z = cz * CHUNK - origin_z
            for i in range(COLUMNS):
                packed = chunk[i]
                if not packed:
                    continue
                x = base_x + i % CHUNK
                z = base_z + i // CHUNK
                o = (z * width + x) * 4
                pixels[o] = packed >> 16 & 0xFF
                pixels[o + 1] = packed >> 8 & 0xFF
                pixels[o + 2] = packed & 0xFF
                pixels[o + 3] = 255

        self.png = _png(width, height, pixels)
        self.png_meta = {"origin_x": origin_x, "origin_z": origin_z,
                         "width": width, "height": height}
        return self.png, self.png_meta

    def meta(self):
        box = self.bounds() or (0, 0, 0, 0)
        age = time.time() - self.updated if self.updated else None
        return {
            "dimension": self.dimension,
            "session": self.session,
            "origin_x": box[0], "origin_z": box[1], "width": box[2], "height": box[3],
            "chunks": len(self.chunks),
            "hot": len(self.hot),
            # enough to restore the glow on a reload without bloating the snapshot
            "fires": sorted(self.hot)[:8000],
            "drones": list(self.drones.values()),
            "tick": self.tick,
            "age": None if age is None else round(age, 2),
            "live": age is not None and age < STALE_AFTER,
        }


# --------------------------------------------------------------------------
# ingest

def ingest(payload):
    """
    Takes one batch from the mod and fans it out.

    The batch carries flat triples of x, z and the packed colour, plus wherever the
    drones are right now, and what became of any disaster events the mod just carried out.
    Returns the delta that went to the subscribers.
    """
    dimension = str(payload.get("dimension") or "minecraft:overworld")
    session = str(payload.get("session") or "")
    columns = payload.get("columns") or []
    if len(columns) % 3:
        raise ValueError("columns must be flat triples of x, z, packed")

    with _LOCK:
        world = _WORLDS.get(dimension)
        if world is None or world.session != session:
            # a different run of the world: whatever we had is about a different place
            world = _World(dimension, session)
            _WORLDS[dimension] = world

        for i in range(0, len(columns), 3):
            world.put(int(columns[i]), int(columns[i + 1]), int(columns[i + 2]) & 0xFFFFFFFF)

        world.drones = {str(d.get("id")): d for d in payload.get("drones") or []}
        world.tick = int(payload.get("tick") or 0)
        world.updated = time.time()
        if columns:
            world.png = None                     # the overlay changed underneath us

        touched = _absorb_reports_locked(payload.get("events") or [])
        pending, sent = _take_commands_locked()
        touched.extend(e for e in sent if e not in touched)

        delta = {
            "dimension": dimension,
            "session": session,
            "columns": columns,
            "drones": list(world.drones.values()),
            "hot": len(world.hot),
            "tick": world.tick,
        }
        # Grouped by the event's own dimension, not this batch's: the stream filters on that
        # field, and the mod flushes one batch per level.
        moved = {}
        for record in touched:
            moved.setdefault(record["dimension"], []).append(dict(record))
        subscribers = list(_SUBSCRIBERS)

    for sink in subscribers:
        try:
            sink.put_nowait(("delta", delta))
            for where, records in moved.items():
                sink.put_nowait(("events", {"dimension": where, "events": records}))
        except queue.Full:
            pass                                  # a slow dashboard misses a frame, no more
    return delta, pending


def order(drone_id, x, y, z):
    """
    Queues "fly there" for one drone.

    The mod collects these in the reply to its next feed POST, so an order costs no extra
    round trip and lands within a flush - about a fifth of a second.
    """
    return _enqueue({"id": str(drone_id), "x": float(x), "y": float(y), "z": float(z)})


def fly(drone_id, forward=0, right=0, up=0, yaw=0):
    """
    Queues a Minecraft-style stick: hold to keep flying, zeros (or hover()) to stop.

    Directions are in the drone's camera frame. The mod rebuilds world velocity each
    tick, so turning while a key is down keeps "forward" as forward.
    """
    if not (forward or right or up or yaw):
        return hover(drone_id)
    return _enqueue({
        "id": str(drone_id),
        "fly": True,
        "forward": float(forward),
        "right": float(right),
        "up": float(up),
        "yaw": float(yaw),
    })


def hover(drone_id):
    """Queues a brake-and-hold for one drone."""
    return _enqueue({"id": str(drone_id), "hover": True})


def look(drone_id, pitch):
    """Queues a camera-only downward pitch adjustment; it does not alter flight input."""
    value = _finite(pitch, "pitch")
    if value < 0 or value > 90:
        raise ValueError("pitch must be between 0 and 90 degrees")
    return _enqueue({"id": str(drone_id), "look": True, "pitch": value})


def spawn(x, z, *, y=None, drone_id=None, dimension="minecraft:overworld"):
    """
    Queues "put a new drone here", travelling the same way an order does.

    The map is top-down and has no altitude to give, so y is optional: the mod drops the drone
    just above the ground when it is left out. The new drone's id is the mod's to choose, and it
    shows up in the feed a flush later like any other - there is nothing to return but the depth
    of the queue it went into.
    """
    command = {
        "type": "spawn",
        "x": _finite(x, "x"),
        "z": _finite(z, "z"),
        "dimension": str(dimension or "minecraft:overworld"),
    }
    if y is not None:
        command["y"] = _finite(y, "y")
    if drone_id:
        command["id"] = str(drone_id)
    return _enqueue(command)


def _enqueue(command):
    with _LOCK:
        command["at"] = time.time()
        _COMMANDS.append(command)
        return len(_COMMANDS)


def _take_commands_locked():
    """
    Hands over every fresh order and clears the queue. Caller must hold the lock.

    Returns the commands the mod should carry out, and the event records that just went from
    waiting to on their way - an order that timed out here never reached Minecraft, and saying
    so is more use to an operator than leaving it queued forever.
    """
    now = time.time()
    out = []
    moved = []
    for command in _COMMANDS:
        fresh = now - command["at"] < COMMAND_TTL
        if fresh:
            out.append({k: v for k, v in command.items() if k != "at"})
        record = _EVENTS_BY_ID.get(command.get("event_id"))
        if record is not None:
            record["status"] = "sent" if fresh else "dropped"
            if not fresh:
                record["error"] = "the mod never collected it"
            moved.append(record)
    _COMMANDS.clear()
    return out, moved


# --------------------------------------------------------------------------
# disaster events
#
# The dashboard cannot reach Minecraft; the mod cannot be called. So an event is parked here
# and handed to the mod in the reply to its next feed push, exactly like a drone order, and the
# outcome comes back the same way on the push after that. That round trip is why an event has a
# status at all: "queued" is a wish, "done" is a fire that actually caught.

_EVENTS_BY_ID = {}                # id -> the same dict that is in _EVENTS


def simulate(kind, x, z, *, y=None, radius=6, intensity=3, dimension="minecraft:overworld",
             label="", source="dashboard"):
    """
    Queues one disaster for the mod to carry out, and returns the record that tracks it.

    :raises ValueError: if the event asks for something the mod would refuse anyway
    """
    kind = str(kind)
    if kind not in EVENT_KINDS:
        raise ValueError(f"unknown kind {kind!r}; expected one of {', '.join(EVENT_KINDS)}")

    x, z = _finite(x, "x"), _finite(z, "z")
    y = None if y is None else _finite(y, "y")
    radius = max(0, min(MAX_EVENT_RADIUS, int(radius)))
    intensity = max(1, min(MAX_EVENT_INTENSITY, int(intensity)))

    record = {
        "id": f"ev-{uuid.uuid4().hex[:8]}",
        "kind": kind,
        "dimension": str(dimension),
        "x": x, "y": y, "z": z,
        "radius": radius,
        "intensity": intensity,
        "label": str(label or "")[:80],
        "source": str(source)[:40],
        "created": time.time(),
        "status": "queued",
        "affected": None,
        "error": None,
    }

    with _LOCK:
        _COMMANDS.append({
            "type": "event", "event_id": record["id"], "kind": kind,
            "dimension": record["dimension"],
            "x": x, "y": y, "z": z, "radius": radius, "intensity": intensity,
            "at": time.time(),
        })
        _EVENTS.append(record)
        _EVENTS_BY_ID[record["id"]] = record
        while len(_EVENTS) > MAX_EVENTS:
            _EVENTS_BY_ID.pop(_EVENTS.pop(0)["id"], None)
        queued = len(_COMMANDS)
        subscribers = list(_SUBSCRIBERS)
        published = {"dimension": record["dimension"], "events": [dict(record)]}

    for sink in subscribers:
        try:
            sink.put_nowait(("events", published))
        except queue.Full:
            pass
    return dict(record), queued


def events(dimension=None, limit=MAX_EVENTS):
    """The disaster log, newest first."""
    with _LOCK:
        chosen = [e for e in reversed(_EVENTS) if dimension is None or e["dimension"] == dimension]
        return [dict(e) for e in chosen[:max(0, int(limit))]]


def _absorb_reports_locked(reports):
    """
    Takes the mod's word for what each event did. Caller must hold the lock.

    Returns the records that changed, so the dashboard can be told without polling.
    """
    moved = []
    for report in reports:
        if not isinstance(report, dict):
            continue
        record = _EVENTS_BY_ID.get(str(report.get("id") or ""))
        if record is None:
            continue                              # an event from before a restart; nothing to update
        record["status"] = "done" if report.get("ok") else "failed"
        record["affected"] = report.get("affected")
        record["error"] = report.get("error")
        record["finished"] = time.time()
        moved.append(record)
    return moved


def _finite(value, name):
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        raise ValueError(f"{name} must be a finite number")
    return number


def world(dimension="minecraft:overworld"):
    with _LOCK:
        return _WORLDS.get(dimension)


def snapshot(dimension="minecraft:overworld"):
    w = world(dimension)
    return w.meta() if w else {
        "dimension": dimension, "session": "", "origin_x": 0, "origin_z": 0,
        "width": 0, "height": 0, "chunks": 0, "hot": 0, "fires": [], "drones": [],
        "tick": 0, "age": None, "live": False,
    }


# --------------------------------------------------------------------------
# subscribers

def subscribe(depth=64):
    sink = queue.Queue(maxsize=depth)
    with _LOCK:
        _SUBSCRIBERS.append(sink)
    return sink


def unsubscribe(sink):
    with _LOCK:
        if sink in _SUBSCRIBERS:
            _SUBSCRIBERS.remove(sink)


def subscriber_count():
    with _LOCK:
        return len(_SUBSCRIBERS)


def sse(event, data):
    """One server-sent event, already encoded."""
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n".encode()


# --------------------------------------------------------------------------

def _png(width, height, pixels):
    """Minimal RGBA PNG - same encoder shape as worldmap, kept local to avoid a cycle."""
    stride = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        raw += pixels[y * stride:(y + 1) * stride]

    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + chunk(b"IEND", b""))
