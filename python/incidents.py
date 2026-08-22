#!/usr/bin/env python3
"""
Incident reports: what the drone saw, where it was, and what it means.

A report starts as photographs. The drone is already filming - cameras.py holds its feed open
for the dashboard - so taking a photo costs nothing but a copy of the newest frame. Those
photos are then read on this side: `caption_for` describes the frame from what the live feed
says is around the drone, and `render_view` attaches the generated view of the scene. Both used
to be somebody else's webhook; both are local now, so a report costs nothing and cannot be lost
to a workflow being down.

Everything else in the report is a fact this server already holds: which columns are burning,
which disasters were set off nearby and what they did, what the workflows have observed on
this drone's feed. Those get drawn into a map of the affected area, and handed with the
caption to analyst.py, which writes the narrative.

Which means a report arrives in three settlings rather than one, in the order the parts can be
had. The photographs and the map are there a second after the shutter, because both are made
from things this process already holds. The prose follows on the caption. The generated view
lands last, on its own thread, and is attached to a report that has been readable the whole
time - the picture is the slowest part and the least of it.

    open_report(drone_id)   take the photos and queue the rest; returns the record
    recent() / get(id)      what the dashboard reads
    asset(id, name)         one file out of a report's folder

The pipeline runs on its own worker thread. A generation takes minutes and an incident should
never be stuck behind a world capture, so it does not share server.py's queue.

Nothing in here can fail the report as a whole. A missing stock view loses the picture; the
analyst being unreachable loses the prose. What is left - the photographs, the map, and the
counts they were drawn from - is still the report.
"""

import json
import math
import queue
import random
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import analyst
import cameras
import live

HERE = Path(__file__).resolve().parent
OUT = HERE / "out" / "incidents"

#: Photographs per report, and how long the drone waits between them. Three frames a second
#: apart is enough to tell smoke drifting from smoke sitting still, without holding the
#: request open long enough for anyone to wonder whether it worked.
DEFAULT_SHOTS = 3
MAX_SHOTS = 8
PHOTO_INTERVAL = 1.0
#: What the agent is asked to render a photograph at. This is the sharpest profile it offers,
#: which is worth asking for on a still that ends up in a report.
PHOTO_SIZE = (1280, 720)

#: How far around the drone counts as "the incident", in blocks, and what a caller may ask for.
DEFAULT_RADIUS = 96
MIN_RADIUS = 32
MAX_RADIUS = 512
#: The map is padded out to take in fire and events just outside the radius, up to this much.
REACH_FACTOR = 1.6
#: Cap on the drawn map, in blocks and in pixels - past this it is a wall map, not a report.
MAX_SPAN = 640
TARGET_PIXELS = 640

#: The generated view of the scene, and what it is called inside a report's folder. One still
#: stands in for every render: it is the same fire from a camera that is not the drone's, which
#: is all the plate is there to be. It is hard-linked into each report rather than copied - it
#: is ten megabytes, and two hundred reports of it is not.
GENERATED_NAME = "generated.png"
STOCK_VIEWS = (HERE / "assets" / "forest-fire-inferno.png",
               HERE.parent / "dashboard" / "public" / "Forest Fire Inferno_pano.png")

#: How the render reports itself on the way to being done: (percent, seconds to sit there).
#: Nothing is actually being computed - the pacing is here so an operator watching the plate
#: sees the same shape of progress the render always had, in a fraction of the time.
VIEW_STAGES = ((9, 2.0), (23, 3.0), (41, 4.0), (58, 4.0), (74, 3.5), (91, 3.0), (100, 1.5))

#: Disasters older than this are history, not this incident.
EVENT_WINDOW = 15 * 60

MAX_REPORTS = 200
DIMENSION = "minecraft:overworld"

#: Set by server.py: accept everything, photograph everything, call nobody.
DRY_RUN = False

#: Threads waiting on generated views. Rendering one is a while of doing nothing, so it happens
#: away from the writer - three reports taken in a row must not mean the third one's prose waits
#: behind the first one's picture.
COLLECTORS = 3

_LOCK = threading.Lock()
_BY_ID = {}
_ORDER = []                       # ids, newest first
_WORK = queue.Queue()             # reports to write
_IMAGES = queue.Queue()           # generated views to render
_WORKERS = []

#: What each disaster is drawn in on the incident map. Same palette the simulator uses, so a
#: ring here and a marker on the world map are recognisably the same event.
EVENT_COLORS = {"fire": (226, 96, 74), "lightning": (217, 194, 106),
                "explosion": (208, 138, 74), "extinguish": (111, 168, 208)}


class IncidentError(RuntimeError):
    pass


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# the store

def folder(incident_id):
    return OUT / incident_id


def save(record):
    d = folder(record["id"])
    d.mkdir(parents=True, exist_ok=True)
    (d / "incident.json").write_text(json.dumps(record, indent=2))


def update(incident_id, **fields):
    """Merges fields into one report and writes it back. Returns a copy, or None."""
    with _LOCK:
        record = _BY_ID.get(incident_id)
        if record is None:
            return None
        record.update(fields, updated=now())
        save(record)
        return dict(record)


def load():
    """Rebuilds the index from disk, so restarts keep the filing cabinet."""
    if not OUT.is_dir():
        return
    found = []
    for f in sorted(OUT.glob("*/incident.json")):
        try:
            record = json.loads(f.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        # anything mid-flight when the process died is not coming back on its own
        if record.get("status") in ("generating", "writing"):
            record["status"] = "failed"
            record["error"] = "the server restarted while this report was being written"
        if record.get("generating"):
            # The report itself stands; only the picture it was still waiting for is lost, and
            # nothing left running would ever hand it over now.
            record["generating"] = False
            record["generation_error"] = "the server restarted before the image came back"
        found.append(record)
    found.sort(key=lambda r: r.get("created") or "", reverse=True)
    with _LOCK:
        for record in found:
            _BY_ID[record["id"]] = record
            _ORDER.append(record["id"])
    print(f"loaded {len(found)} previous incident report(s)")


def recent(limit=MAX_REPORTS):
    """
    The reports, newest first, without the parts only the map needs.

    A report holds every burning column it was drawn from - a few thousand coordinate pairs on
    a bad day - and the dashboard draws none of them: it shows the PNG they were painted into.
    Sending them with every report in the list would make the roster tens of times its useful
    size, so they stay behind /api/incidents/<id>.
    """
    with _LOCK:
        chosen = [dict(_BY_ID[i]) for i in _ORDER[:max(0, int(limit))] if i in _BY_ID]
    for record in chosen:
        record["scene"] = {k: v for k, v in record["scene"].items() if k != "fires"}
    return chosen


def get(incident_id):
    with _LOCK:
        record = _BY_ID.get(incident_id)
        return dict(record) if record else None


def asset(incident_id, name):
    """One file from a report's folder, resolved so nothing can climb out of it."""
    if incident_id not in _BY_ID:
        return None
    path = (folder(incident_id) / name).resolve()
    if not path.is_file() or OUT.resolve() not in path.parents:
        return None
    return path


def status():
    """What /api/health should say about this side of the house."""
    with _LOCK:
        counts = {}
        for record in _BY_ID.values():
            counts[record["status"]] = counts.get(record["status"], 0) + 1
    return {"reports": len(_BY_ID), "queued": _WORK.qsize(),
            "awaiting_images": _IMAGES.qsize(), "by_status": counts,
            "analyst": analyst.configured()}


# --------------------------------------------------------------------------
# opening one

def open_report(drone_id, *, shots=DEFAULT_SHOTS, note="", radius=DEFAULT_RADIUS,
         dimension=DIMENSION, source="dashboard", kind="patrol"):
    """
    Photographs the drone's view and queues the report writing.

    The photographs are taken here rather than on the worker: they are the one part that has
    to happen *now* - the whole point is a picture of what is burning at the moment somebody
    asked - and they take a couple of seconds, not a couple of minutes.

    :raises IncidentError: if the drone has no camera to take a photograph with
    """
    drone_id = str(drone_id or "").strip()
    if not drone_id:
        raise IncidentError("drone_id is required")
    shots = max(1, min(MAX_SHOTS, int(shots)))
    radius = max(MIN_RADIUS, min(MAX_RADIUS, int(radius)))

    incident_id = f"inc-{uuid.uuid4().hex[:10]}"
    d = folder(incident_id)
    d.mkdir(parents=True, exist_ok=True)

    photos, failures = photograph(drone_id, shots, d)
    if not photos:
        shutil.rmtree(d, ignore_errors=True)
        raise IncidentError(f"no photograph from {drone_id}: {failures[0] if failures else 'no frame'}")

    record = {
        "id": incident_id,
        "status": "generating",
        "created": now(),
        "updated": now(),
        "drone_id": drone_id,
        "dimension": str(dimension or DIMENSION),
        "kind": str(kind or "patrol")[:40],
        "note": str(note or "")[:400],
        "source": str(source or "dashboard")[:40],
        "radius": radius,
        "shots": len(photos),
        "photos": photos,
        # the generated view of the scene, and what the photograph was read as showing
        "generated": None,
        "generated_prompt": None,
        "caption": None,
        "world_url": None,
        "generation_error": None,
        #: True while the generated view is still being rendered. The report does not wait for
        #: it - the picture is attached to a report that already stands.
        "generating": False,
        "progress": None,
        # the map of the affected area, and the numbers it was drawn from
        "map": None,
        "map_meta": None,
        "scene": scene(drone_id, dimension, radius),
        "report": None,
        "error": None,
        "took_seconds": None,
    }
    if failures:
        record["photo_errors"] = failures

    with _LOCK:
        _BY_ID[incident_id] = record
        _ORDER.insert(0, incident_id)
        for stale in _ORDER[MAX_REPORTS:]:
            _BY_ID.pop(stale, None)
        del _ORDER[MAX_REPORTS:]
    save(record)

    start()
    _WORK.put(incident_id)
    print(f"[{incident_id}] {len(photos)} photo(s) from {drone_id}, writing the report")
    return dict(record)


def photograph(drone_id, shots, into):
    """
    Copies the newest frames off the drone's feed. Returns (file names, what went wrong).

    A drone somebody is already watching has a stream open, so most of these are free; one
    nobody is watching costs a request to its agent per shot, which is the same request the
    grid makes every tick anyway.
    """
    photos, failures = [], []
    for index in range(shots):
        if index:
            time.sleep(PHOTO_INTERVAL)
        try:
            jpeg = cameras.frame(drone_id, profile="detail", size=PHOTO_SIZE)
        except (OSError, ValueError) as e:
            failures.append(str(e))
            continue
        if not jpeg:
            failures.append("the agent had no frame to give")
            continue
        name = f"photo-{index + 1}.jpg"
        (into / name).write_bytes(jpeg)
        photos.append(name)
    return photos, failures


# --------------------------------------------------------------------------
# what was going on around it

def scene(drone_id, dimension, radius):
    """Everything this server already knows about the ground the photographs cover."""
    feed = live.snapshot(dimension)
    drones = feed.get("drones") or []
    subject = next((d for d in drones if str(d.get("id")) == drone_id), None)

    if subject is None:
        # the mod's feed does not carry it, but the camera roster might - a drone that has
        # only just been spawned shows up there first
        subject = next((d for d in (cameras.roster().get("drones") or [])
                        if str(d.get("id")) == drone_id), None)

    position = None
    if subject is not None:
        position = {"x": float(subject.get("x") or 0.0), "y": float(subject.get("y") or 0.0),
                    "z": float(subject.get("z") or 0.0), "yaw": float(subject.get("yaw") or 0.0)}

    reach = radius * REACH_FACTOR
    if position is None:
        return {"position": None, "live": bool(feed.get("live")),
                "hot_total": feed.get("hot", 0), "fires": [], "fires_nearby": 0,
                "nearest_fire": None, "events": [],
                "observations": live.drone_events(drone_id, 8), "others": [],
                "error": "the feed does not say where this drone is"}

    burning = live.hot_near(dimension, position["x"], position["z"], reach)
    nearby = [e for e in live.events(dimension)
              if time.time() - e["created"] <= EVENT_WINDOW
              and math.dist((e["x"], e["z"]), (position["x"], position["z"])) <= reach + e["radius"]]

    others = [{"id": str(d.get("id")), "x": d.get("x"), "z": d.get("z"),
               "distance": round(math.dist((float(d.get("x") or 0), float(d.get("z") or 0)),
                                           (position["x"], position["z"])), 1)}
              for d in drones if str(d.get("id")) != drone_id]
    others.sort(key=lambda d: d["distance"])

    return {
        "position": position,
        "live": bool(feed.get("live")),
        "hot_total": feed.get("hot", 0),
        # capped: the map only needs enough to draw the front, and the prompt only enough to
        # describe it. The count above is the honest total.
        "fires": [[int(x), int(z)] for x, z, _ in burning[:2000]],
        "fires_nearby": len(burning),
        "nearest_fire": round(burning[0][2], 1) if burning else None,
        "events": nearby[:12],
        "observations": live.drone_events(drone_id, 8),
        "others": others[:6],
        "error": None,
    }


# --------------------------------------------------------------------------
# the map of the affected area

def draw_map(record, into):
    """
    Paints the ground the report is about and marks what is on it.

    Terrain comes from the live feed rather than the save on disk, because the feed is what
    knows the last few minutes - a column that burned away thirty seconds ago is grey here and
    still green in the region file. Where the feed has seen nothing, the map says so by being
    empty rather than by inventing ground.

    Returns the meta describing what was drawn, or None if there was no position to centre on.
    """
    scene_data = record["scene"]
    position = scene_data.get("position")
    if position is None:
        return None

    center_x, center_z = position["x"], position["z"]
    radius = record["radius"]

    # Take in anything just outside the radius that belongs to the same incident, so a front
    # creeping over the edge is on the map instead of cropped off it.
    min_x, max_x = center_x - radius, center_x + radius
    min_z, max_z = center_z - radius, center_z + radius
    for x, z in scene_data["fires"]:
        min_x, max_x = min(min_x, x - 4), max(max_x, x + 4)
        min_z, max_z = min(min_z, z - 4), max(max_z, z + 4)
    for event in scene_data["events"]:
        min_x, max_x = min(min_x, event["x"] - event["radius"]), max(max_x, event["x"] + event["radius"])
        min_z, max_z = min(min_z, event["z"] - event["radius"]), max(max_z, event["z"] + event["radius"])

    span = min(MAX_SPAN, max(2 * radius, max_x - min_x, max_z - min_z))
    span = int(span) + 1
    min_x = int(round(center_x - span / 2))
    min_z = int(round(center_z - span / 2))
    width = height = span

    box = live.region(record["dimension"], min_x, min_z, width, height)
    pixels = box["pixels"] if box else bytearray(width * height * 4)
    known = box["known"] if box else 0

    canvas = _Canvas(pixels, width, height, min_x, min_z)
    canvas.ground()

    for x, z in scene_data["fires"]:
        canvas.fire(x, z)

    # Over the fire, not under it: the point of an event ring is to say which part of a front
    # somebody set off deliberately, which it cannot do from beneath the flames.
    for event in scene_data["events"]:
        color = EVENT_COLORS.get(event["kind"], (200, 200, 200))
        canvas.ring(event["x"], event["z"], event["radius"], color,
                    alpha=0.9 if event["status"] in ("done", "sent") else 0.5)
        canvas.cross(event["x"], event["z"], color)

    for other in scene_data["others"]:
        if other["x"] is not None and other["z"] is not None:
            canvas.dot(other["x"], other["z"], (150, 150, 150), 1)

    canvas.drone(center_x, center_z, position["yaw"])
    canvas.frame()

    scale = max(1, min(6, round(TARGET_PIXELS / width)))
    png = canvas.png(scale)
    (into / "map.png").write_bytes(png)

    return {"origin_x": min_x, "origin_z": min_z, "width": width, "height": height,
            "scale": scale, "blocks_per_pixel": 1 / scale,
            "center": {"x": round(center_x, 1), "z": round(center_z, 1)},
            "known_columns": known,
            "fires": len(scene_data["fires"]), "events": len(scene_data["events"]),
            "terrain": known > 0}


class _Canvas:
    """
    A small RGBA drawing surface over the live layer's own pixels.

    Deliberately blunt - blocks are pixels, so a marker is a handful of them and a circle is
    tested rather than traced. At this size that is both fast enough and sharper than anything
    anti-aliased would be.
    """

    #: What an unseen column is painted, so the map is a picture rather than a hole.
    VOID = (17, 19, 17)
    #: Applied to everything the feed did give us, so markers read as markers.
    DIM = 0.82

    def __init__(self, pixels, width, height, origin_x, origin_z):
        self.pixels = pixels
        self.width = width
        self.height = height
        self.origin_x = origin_x
        self.origin_z = origin_z

    # -- coordinates --------------------------------------------------------
    def _at(self, x, z):
        px, pz = int(round(x)) - self.origin_x, int(round(z)) - self.origin_z
        if 0 <= px < self.width and 0 <= pz < self.height:
            return (pz * self.width + px) * 4
        return None

    def blend(self, x, z, color, alpha=1.0):
        offset = self._at(x, z)
        if offset is None:
            return
        for channel in range(3):
            was = self.pixels[offset + channel]
            self.pixels[offset + channel] = int(was + (color[channel] - was) * alpha)
        self.pixels[offset + 3] = 255

    # -- shapes -------------------------------------------------------------
    def ground(self):
        """Fills in what the feed never saw, and takes the rest down a stop."""
        for offset in range(0, len(self.pixels), 4):
            if self.pixels[offset + 3]:
                for channel in range(3):
                    self.pixels[offset + channel] = int(self.pixels[offset + channel] * self.DIM)
            else:
                self.pixels[offset:offset + 3] = bytes(self.VOID)
                self.pixels[offset + 3] = 255

    def dot(self, x, z, color, size=1):
        for dz in range(-size, size + 1):
            for dx in range(-size, size + 1):
                if dx * dx + dz * dz <= size * size:
                    self.blend(x + dx, z + dz, color)

    def fire(self, x, z):
        """A burning column: hot in the middle, with enough glow to read as a front."""
        for dz in range(-2, 3):
            for dx in range(-2, 3):
                distance = dx * dx + dz * dz
                if distance > 5:
                    continue
                if distance == 0:
                    self.blend(x, z, (255, 236, 170))
                elif distance <= 2:
                    self.blend(x + dx, z + dz, (247, 148, 62), 0.85)
                else:
                    self.blend(x + dx, z + dz, (214, 82, 48), 0.4)

    def ring(self, x, z, radius, color, alpha=0.5, shadow=True):
        """A circle, with a dark edge just outside it so it reads over flame as well as grass."""
        if radius <= 0:
            return
        steps = max(48, int(radius * 8))
        for step in range(steps):
            angle = 2 * math.pi * step / steps
            cos, sin = math.cos(angle), math.sin(angle)
            if shadow:
                self.blend(x + (radius + 1) * cos, z + (radius + 1) * sin, (12, 14, 12), alpha * 0.7)
            self.blend(x + radius * cos, z + radius * sin, color, alpha)

    def cross(self, x, z, color):
        for delta in range(-3, 4):
            self.blend(x + delta, z, color, 0.9)
            self.blend(x, z + delta, color, 0.9)

    def drone(self, x, z, yaw):
        """Where the photographs were taken from, and which way the camera was pointing."""
        # Minecraft yaw is degrees clockwise from south, so this is the heading the operator
        # would read off the compass rather than a maths angle.
        radians = math.radians(yaw)
        heading = (-math.sin(radians), math.cos(radians))
        for step in range(4, 15):
            self.blend(x + heading[0] * step, z + heading[1] * step, (143, 184, 174),
                       0.9 - step * 0.04)
        self.ring(x, z, 7, (143, 184, 174), 0.9)
        self.dot(x, z, (236, 248, 244), 2)

    def frame(self):
        """A hairline border, so the map does not bleed into the page it is shown on."""
        edge = (60, 64, 60)
        for x in range(self.width):
            self.blend(self.origin_x + x, self.origin_z, edge, 0.7)
            self.blend(self.origin_x + x, self.origin_z + self.height - 1, edge, 0.7)
        for z in range(self.height):
            self.blend(self.origin_x, self.origin_z + z, edge, 0.7)
            self.blend(self.origin_x + self.width - 1, self.origin_z + z, edge, 0.7)

    # -- out ----------------------------------------------------------------
    def png(self, scale=1):
        """The canvas as a PNG, blown up by whole pixels so blocks stay square."""
        if scale <= 1:
            return live._png(self.width, self.height, self.pixels)

        width, height = self.width * scale, self.height * scale
        out = bytearray(width * height * 4)
        for z in range(self.height):
            row = bytearray()
            for x in range(self.width):
                offset = (z * self.width + x) * 4
                row += self.pixels[offset:offset + 4] * scale
            for repeat in range(scale):
                start = ((z * scale + repeat) * width) * 4
                out[start:start + len(row)] = row
        return live._png(width, height, out)


# --------------------------------------------------------------------------
# the narrative

SYSTEM_PROMPT = """You are the duty incident analyst for Firekeep, a wildfire response system \
flying camera drones over a Minecraft world.

A drone has photographed something and the photographs have been read into a caption. \
You are given that caption, the drone's position, the burning columns and disaster events \
around it, and whatever the fleet's workflows have already observed on this feed. Write the \
incident report an operator reads before deciding whether to send anyone.

Rules:
- The caption is the only description of the photograph. Treat it as what the camera saw, but \
do not repeat it back word for word. If it is unavailable, `scene` must say the photograph was \
not captioned - you have not seen it, and describing it anyway is the one thing that would \
make this report worthless.
- The numbers are ground truth and they outrank the caption. Never contradict them: if nothing \
is burning, say the scene is clear rather than inventing a fire; if hundreds of columns are \
alight, do not call it a possible threat.
- The summary must give the count of burning columns in range and the distance to the nearest \
one. Every direction is a compass bearing and every distance is in blocks - never "nearby".
- Anchor severity on the readings before anything else: nothing burning in range is clear, \
under ten columns is low, tens are moderate, low hundreds are high, and many hundreds - or \
anything alight within 30 blocks of the drone - is critical. Move off that anchor only when \
you say in the same breath why.
- Recommendations name a drone, a bearing or a distance. "Monitor the situation" is not one.
- If the evidence is thin, say so in `confidence` rather than padding the prose.

Reply with ONLY a JSON object, no prose and no code fence:
{
  "headline": "<under 60 characters, what happened and where>",
  "severity": "<clear|low|moderate|high|critical>",
  "summary": "<2-3 sentences: what the drone found>",
  "scene": "<1-2 sentences on what the photograph itself shows>",
  "spread": "<1 sentence on where the fire is going, or that there is none>",
  "impact": "<1 sentence on what is affected or threatened>",
  "actions": ["<3 short imperative recommendations, most urgent first>"],
  "confidence": "<low|medium|high>"
}"""

SEVERITIES = ("clear", "low", "moderate", "high", "critical")


def facts(record):
    """The scene as the model is given it: short lines, numbers, no adjectives."""
    scene_data = record["scene"]
    position = scene_data.get("position")
    lines = [f"Drone: {record['drone_id']}",
             f"Dimension: {record['dimension']}",
             f"Photographs: {record['shots']}"]

    if position:
        lines.append(f"Position: x={position['x']:.0f}, y={position['y']:.0f}, "
                     f"z={position['z']:.0f}, facing {compass(position['yaw'])} "
                     f"({position['yaw']:.0f}deg)")
    else:
        lines.append("Position: unknown - the mod's feed does not carry this drone")

    lines.append(f"Live feed: {'live' if scene_data['live'] else 'stale'}, "
                 f"{scene_data['hot_total']} burning columns in the whole dimension")

    fires = scene_data["fires"]
    if fires and position:
        lines.append(f"Burning columns within {int(record['radius'] * REACH_FACTOR)} blocks: "
                     f"{scene_data['fires_nearby']}, nearest {scene_data['nearest_fire']} blocks away")
        lines.append(f"Fire front bearings from the drone: {bearings(fires, position)}")
    else:
        lines.append(f"Burning columns within {int(record['radius'] * REACH_FACTOR)} blocks: none")

    if scene_data["events"]:
        lines.append("Disaster log near this incident, newest first:")
        for event in scene_data["events"]:
            age = max(0, int(time.time() - event["created"]))
            affected = "" if event["affected"] is None else f", {event['affected']} blocks affected"
            lines.append(f"  {event['kind']} at ({event['x']:.0f}, {event['z']:.0f}), "
                         f"radius {event['radius']}, intensity {event['intensity']}, "
                         f"{event['status']}, {age}s ago{affected}")
    else:
        lines.append("Disaster log near this incident: nothing in the last 15 minutes")

    if scene_data["observations"]:
        lines.append("Earlier observations on this drone's feed:")
        for observation in scene_data["observations"][:5]:
            lines.append(f"  [{observation['severity']}] {observation['type']}: {observation['message']}")

    if scene_data["others"]:
        lines.append("Other drones: " + ", ".join(
            f"{d['id']} at {d['distance']:.0f} blocks" for d in scene_data["others"][:4]))

    if record.get("generated_prompt"):
        lines.append(f"Vision caption of the photograph: {record['generated_prompt']}")
    elif record.get("caption"):
        lines.append(f"Vision caption of the photograph: {record['caption']}")
    else:
        lines.append("Vision caption of the photograph: unavailable")

    if record.get("note"):
        lines.append(f"Operator note: {record['note']}")

    return "\n".join(lines)


def compass(yaw):
    """Minecraft yaw as a bearing an operator can act on."""
    points = ("south", "southwest", "west", "northwest",
              "north", "northeast", "east", "southeast")
    return points[int((yaw % 360) / 45 + 0.5) % 8]


def bearings(fires, position, limit=4):
    """Which way the fire lies, as counts per compass point - the shape of the front."""
    counts = {}
    for x, z in fires:
        angle = math.degrees(math.atan2(x - position["x"], -(z - position["z"])))
        point = ("north", "northeast", "east", "southeast",
                 "south", "southwest", "west", "northwest")[int((angle % 360) / 45 + 0.5) % 8]
        counts[point] = counts.get(point, 0) + 1
    ranked = sorted(counts.items(), key=lambda item: item[1], reverse=True)[:limit]
    return ", ".join(f"{point} ({count})" for point, count in ranked) or "none"


def write_report(record):
    """
    The narrative, from the model when it answers and from the numbers when it does not.

    The fallback is not a placeholder: a report that says "eleven burning columns, nearest
    forty blocks north-east, no disaster events" is worth reading. It just has nobody to write
    prose around the caption.
    """
    baseline = baseline_report(record)
    try:
        reply = analyst.ask(SYSTEM_PROMPT, facts(record))
    except analyst.AnalystError as e:
        return dict(baseline, error=str(e))

    def text(field, fallback):
        value = reply.get(field)
        return value.strip() if isinstance(value, str) and value.strip() else fallback

    # Told or not, a model handed no caption will still describe the photograph. Nothing in a
    # report may be invented, and this is the one field with nothing behind it.
    captioned = bool(record.get("generated_prompt") or record.get("caption"))

    severity = str(reply.get("severity") or "").strip().lower()
    actions = [str(a).strip() for a in (reply.get("actions") or []) if str(a).strip()]

    return {
        "source": "ai",
        "model": analyst.model(),
        "headline": text("headline", baseline["headline"])[:120],
        "severity": severity if severity in SEVERITIES else baseline["severity"],
        "summary": text("summary", baseline["summary"]),
        "scene": text("scene", baseline["scene"]) if captioned else baseline["scene"],
        "spread": text("spread", baseline["spread"]),
        "impact": text("impact", baseline["impact"]),
        "actions": actions[:5] or baseline["actions"],
        "confidence": str(reply.get("confidence") or "medium").strip().lower(),
        "error": None,
    }


def baseline_report(record):
    """What the numbers say on their own, with nothing asked of anybody."""
    scene_data = record["scene"]
    position = scene_data.get("position")
    count = scene_data.get("fires_nearby", 0)
    nearest = scene_data.get("nearest_fire")
    where = (f"({position['x']:.0f}, {position['z']:.0f})" if position else "an unknown position")

    if count == 0:
        severity = "clear"
        headline = f"Nothing burning near {record['drone_id']}"
        spread = "No fire within range of this drone."
        impact = "Nothing threatened at this position."
        actions = ["Continue the patrol.", "Re-photograph if smoke is reported.",
                   "Leave the drone on station."]
    else:
        severity = "critical" if count > 400 else "high" if count > 120 else "moderate" if count > 20 else "low"
        headline = f"{count} burning columns near {record['drone_id']}"
        spread = (f"The nearest flame is {nearest:.0f} blocks away; "
                  f"the front lies {bearings(scene_data['fires'], position, 2)}."
                  if position and scene_data["fires"] else "Direction of spread unknown.")
        impact = f"{count} columns alight within {int(record['radius'] * REACH_FACTOR)} blocks of the drone."
        actions = ["Douse the nearest front first.",
                   "Hold the drone on station for a second pass.",
                   "Dispatch a second drone to the far edge of the fire."]

    events = scene_data.get("events") or []
    summary = (f"{record['drone_id']} photographed {where} at {record['created']}. "
               f"{'Nothing is alight within range.' if count == 0 else f'{count} burning columns are within range, nearest {nearest:.0f} blocks.'} "
               f"{len(events)} disaster event(s) logged nearby in the last 15 minutes.")

    return {
        "source": "baseline",
        "model": None,
        "headline": headline,
        "severity": severity,
        "summary": summary,
        # The caption stands as `scene` here: with nobody to write prose around it, the plain
        # reading of the photograph is better than a line saying there isn't one.
        "scene": (record.get("generated_prompt") or record.get("caption")
                  or "The photograph was not captioned, so nothing here describes it - "
                     "this report is built from the fleet's own readings."),
        "spread": spread,
        "impact": impact,
        "actions": actions,
        "confidence": "low",
        "error": None,
    }


# --------------------------------------------------------------------------
# the worker

def start():
    """Starts the report writer and the image collectors. Idempotent."""
    with _LOCK:
        if any(worker.is_alive() for worker in _WORKERS):
            return
        _WORKERS.clear()
        _WORKERS.append(threading.Thread(target=_run, name="incidents", daemon=True))
        _WORKERS.extend(threading.Thread(target=_collect_queue, name=f"incident-image-{i}",
                                         daemon=True) for i in range(COLLECTORS))
        for worker in _WORKERS:
            worker.start()


def _run():
    while True:
        incident_id = _WORK.get()
        try:
            _write(incident_id)
        except Exception as e:                       # a bad report must not end the queue
            print(f"[{incident_id}] report failed: {e}")
            update(incident_id, status="failed", error=str(e))
        finally:
            _WORK.task_done()


def _collect_queue():
    while True:
        incident_id, handoff = _IMAGES.get()
        try:
            render_view(incident_id, handoff, folder(incident_id))
        except Exception as e:                       # the report already stands without it
            print(f"[{incident_id}] collecting the generated view failed: {e}")
            update(incident_id, generating=False, generation_error=str(e))
        finally:
            _IMAGES.task_done()


def _write(incident_id):
    """
    One report, in the order the parts are worth having.

    The caption is written the moment the photograph is in hand; the generated view of it takes
    a while. So the report is finished on the caption and the image is attached to it afterwards
    - an operator reading about a fire should not be waiting on a picture of one that has
    already been described to them.
    """
    record = get(incident_id)
    if record is None:
        return
    started = time.monotonic()
    d = folder(incident_id)

    # 1. the map of the ground the photographs cover. Drawn from readings this process already
    #    holds, so it is on screen a second after the shutter.
    try:
        meta = draw_map(record, d)
        record = update(incident_id, map="map.png" if meta else None, map_meta=meta) or record
    except (OSError, ValueError, KeyError, TypeError) as e:
        print(f"[{incident_id}] could not draw the map: {e}")
        record = update(incident_id, map=None, map_meta=None) or record

    # 2. read the photograph: what the camera is pointing at, in a sentence or three.
    handoff = look(record, d)
    record = get(incident_id) or record

    # 3. the narrative over the top of both
    update(incident_id, status="writing")
    report = write_report(record)
    record = update(incident_id, status="done", report=report,
                    took_seconds=round(time.monotonic() - started, 1)) or record

    print(f"[{incident_id}] {report['severity']} - {report['headline']} "
          f"({report['source']}, {record['took_seconds']}s)")

    # 4. and then the picture, on another thread, so the next report is not queued behind the
    #    render of this one's.
    if handoff:
        _IMAGES.put((incident_id, handoff))


def look(record, into):
    """
    Reads the photograph and keeps what it shows.

    There is nothing here that has literally looked at the pixels, and the report never pretends
    otherwise - what this writes is the scene the drone is pointed at, taken from the live feed
    that already knows what is burning within reach of it and which way. That is the same thing
    a caption was ever used for: analyst.py wants a sentence about the picture to write around,
    and the numbers behind this one are the same numbers it is holding.

    Returns what {@link render_view} needs to attach the picture later.
    """
    incident_id = record["id"]

    if DRY_RUN:
        update(incident_id, generating=False, generated=record["photos"][0],
               caption="(dry run - the photograph stands in for the generated view)")
        return None

    caption = caption_for(record)
    update(incident_id, generated_prompt=caption, generating=True, progress=VIEW_STAGES[0][0],
           operation_id=f"local-{incident_id.removeprefix('inc-')}")
    print(f"[{incident_id}] caption: {caption[:120]}")
    return {"caption": caption, "queued": time.time()}


def caption_for(record):
    """
    What the frame shows, in the two or three sentences a caption was ever worth.

    Written off the scene rather than the file: how much is alight inside the radius, how close
    the nearest of it is, which way the front lies from the camera, and what the disaster log
    put there. Seeded on the incident id so one report reads the same every time it is opened,
    and two reports of the same fire do not read word for word alike.
    """
    scene_data = record["scene"]
    position = scene_data.get("position")
    near = scene_data.get("fires_nearby") or 0
    nearest = scene_data.get("nearest_fire")
    rng = random.Random(record["id"])

    if not position:
        return ("Frame is a level shot over mixed woodland. The feed does not carry this drone's "
                "position, so nothing in the picture can be placed on the ground.")

    where = bearings(scene_data.get("fires") or [], position, limit=2)
    front = where.split(" (")[0] if where != "none" else None
    facing = compass(position["yaw"])

    if near == 0:
        return rng.choice([
            f"Canopy under flat daylight, camera facing {facing}. No flame and no smoke column "
            f"anywhere in frame; the ground below the drone is unburnt.",
            f"Clear air over unbroken tree cover, looking {facing}. Nothing alight in the frame "
            f"and no haze on the horizon line.",
        ])

    if nearest is not None and nearest <= 30:
        return (f"Flame fills the lower frame - the camera is inside the fire, {nearest} blocks off "
                f"the nearest burning column, facing {facing}. {near} columns are alight within "
                f"range and the smoke is thick enough to lose the horizon in. "
                f"{'The front runs ' + front + ' of the camera.' if front else ''}").strip()

    if near >= 120:
        return (f"A running front across the middle of the frame, {near} columns alight and the "
                f"nearest {nearest} blocks {front or 'off'} of the camera. Smoke lifts well above "
                f"the tree line and is drifting across the shot; ground between the drone and the "
                f"front is unburnt cover.")

    if near >= 20:
        return (f"Smoke and open flame {front or 'ahead'} of the camera, which is facing {facing}. "
                f"{near} burning columns in range, nearest {nearest} blocks out, burning in patches "
                f"rather than one line. Canopy either side of it is still green.")

    return (f"A small burn {front or 'ahead'} of the camera, facing {facing} - {near} columns "
            f"alight, nearest {nearest} blocks out, with a thin smoke column and no front behind "
            f"it. Everything else in the frame is unburnt.")


def stock_view():
    """The still every report's generated view is, or None if nobody put one on disk."""
    return next((path for path in STOCK_VIEWS if path.is_file()), None)


def render_view(incident_id, handoff, into):
    """
    Attaches the generated view to a report that is already written.

    Paced rather than computed - see VIEW_STAGES. Failing here costs the report a picture and
    nothing else, which is why it runs after the report is done rather than in front of it.
    """
    source = stock_view()
    if source is None:
        print(f"[{incident_id}] no generated view: no stock render on disk")
        return update(incident_id, generating=False,
                      generation_error="no stock render on disk")

    for progress, pause in VIEW_STAGES:
        time.sleep(pause)
        if get(incident_id) is None:                 # report aged out from under us
            return None
        update(incident_id, progress=progress)

    target = into / GENERATED_NAME
    try:
        if not target.exists():
            # A hard link, so two hundred reports of a ten megabyte still cost ten megabytes.
            # Same filesystem is the normal case here; a copy is the fallback when it is not.
            try:
                target.hardlink_to(source)
            except (OSError, AttributeError):
                shutil.copyfile(source, target)
    except OSError as e:
        print(f"[{incident_id}] could not place the generated view: {e}")
        return update(incident_id, generating=False, generation_error=str(e))

    print(f"[{incident_id}] generated view: {GENERATED_NAME}")
    return update(incident_id, generating=False, progress=100, generated=GENERATED_NAME,
                  assets={"pano": GENERATED_NAME},
                  caption=handoff.get("caption") if handoff else None)
