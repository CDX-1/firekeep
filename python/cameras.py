#!/usr/bin/env python3
"""
The camera half of the midpoint.

Every drone is filmed by its own Minecraft client - its own process, on its own port - so
there is no one address that has the whole fleet. This module is the piece that knows the
whole picture: it resolves the agent directory the Fabric server publishes, holds one
upstream connection per drone anyone is watching, and fans the frames out to every
dashboard from here.

The point of putting it here rather than in the dashboard is arithmetic. Ten tabs watching
six drones used to be sixty conversations with Minecraft; through this it is six, however
many tabs there are, and a tab that goes away costs the game nothing. The agents are also
the one part of the system that cannot be asked to push - they are a game loop with an HTTP
server bolted on - so the polling that is genuinely unavoidable happens once, here, instead
of once per browser.

Outward there is one multiplexed stream: {@code /api/cameras/feed} carries the roster and
every subscribed drone's frames down a single connection, so a wall of tiles is one socket
and nothing in the dashboard has to poll for a picture.
"""

import json
import os
import queue
import threading
import time
import urllib.parse
import urllib.request

import live

#: Where the Fabric server publishes which agent films which drone.
DIRECTORY_URL = os.environ.get("FIREKEEP_AGENTS", "http://127.0.0.1:8087").rstrip("/")
#: Used when the directory is unreachable or empty - the normal case for one agent started by hand.
FALLBACK_BASE = os.environ.get("FIREKEEP_CAMERAS", "http://127.0.0.1:8088").rstrip("/")

#: The directory only changes when an agent starts or stops, so a short cache is plenty.
DIRECTORY_TTL = 2.0
#: How often the agents are asked for their roster. Once for everybody, not once per dashboard.
ROSTER_INTERVAL = 1.0
#: With no dashboard open there is nobody to tell, so the agents are left alone at this rate
#: instead - enough that the first request after a quiet afternoon is not answered with fiction.
IDLE_ROSTER_INTERVAL = 10.0
#: How long after the last request the roster is still considered to be of interest to someone.
INTEREST_TTL = 30.0
#: How often the merged roster is re-checked against the live feed and pushed if it moved.
TICK = 0.2
#: How long an upstream pull is held open after the last watcher leaves, so flipping between
#: filters does not tear down the connection you are about to want again.
IDLE_LINGER = 5.0
#: A drone with no frame this recently is reported as not live.
STALE_AFTER = 3.0
#: Frames per second a watcher gets per drone when it does not ask for a rate.
#:
#: This is a cap on forwarding, not a source of frames: it can only throw away frames the agent
#: has already rendered. At 8 it was throwing away most of them and making the grid stutter for
#: no saving worth having, since the expensive part - rendering and encoding - had already been
#: paid. The wall is still limited by the agent rendering one drone per frame; this just stops
#: being the thing that limits it.
DEFAULT_FPS = 20.0
#: The profiles an agent will render a feed at. "grid" is the thumbnail wall's; "detail" is what
#: one drone gets while somebody has singled it out - bigger, sharper, and as often as the game
#: will render it. The numbers themselves live on the agent, which is the only side that can act
#: on them; this is only the vocabulary for asking.
PROFILES = ("grid", "detail")

#: Boundary of the multiplexed stream this module serves.
BOUNDARY = "firekeepfeed"
#: Written into an idle stream so a proxy - and the browser - can see it is still alive. The
#: parser at the other end is looking for a boundary, so a bare newline costs it nothing.
KEEPALIVE = b"\r\n"

_HTTP_TIMEOUT = 2.0


# --------------------------------------------------------------------------
# the agent directory

_DIR_LOCK = threading.Lock()
_DIRECTORY = {"at": 0.0, "bases": {}, "all": [FALLBACK_BASE], "found": False}


def _get_json(url, timeout=_HTTP_TIMEOUT):
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def directory(refresh=False):
    """(drone id -> agent base, every distinct base). Cached for {@link DIRECTORY_TTL}."""
    with _DIR_LOCK:
        if not refresh and time.monotonic() - _DIRECTORY["at"] < DIRECTORY_TTL:
            return dict(_DIRECTORY["bases"]), list(_DIRECTORY["all"])

    bases = {}
    try:
        body = _get_json(f"{DIRECTORY_URL}/agents")
        host = body.get("host") or "127.0.0.1"
        for agent in body.get("agents") or []:
            # A stopped agent answers nothing useful; skip it so the roster stays honest.
            if agent.get("running"):
                bases[str(agent["droneId"])] = f"http://{host}:{int(agent['port'])}"
    except (OSError, ValueError, KeyError, TypeError):
        pass                                  # the Fabric server may simply not be up

    found = bool(bases)
    every = sorted(set(bases.values())) if found else [FALLBACK_BASE]
    with _DIR_LOCK:
        _DIRECTORY.update(at=time.monotonic(), bases=bases, all=every, found=found)
    return dict(bases), list(every)


def base_for(drone_id):
    """The agent filming {@code drone_id}, falling back to the single configured camera server."""
    bases, _ = directory()
    return bases.get(drone_id, FALLBACK_BASE)


# --------------------------------------------------------------------------
# watchers

class Watcher:
    """
    One dashboard's subscription: which drones it wants, and how often.

    Frames are dropped rather than queued when a watcher falls behind. A slow tab should see
    an older picture, never delay everyone else's - and a stale frame is worthless anyway.
    """

    def __init__(self, ids, fps):
        self.ids = set(ids)
        self.interval = 1.0 / fps if fps > 0 else 0.0
        self.queue = queue.Queue(maxsize=64)
        self.sent = {}                        # drone id -> monotonic clock of its last frame
        self.dropped = 0

    def offer(self, event, drone_id, payload):
        try:
            self.queue.put_nowait((event, drone_id, payload))
            return True
        except queue.Full:
            self.dropped += 1
            return False


_WATCH_LOCK = threading.Lock()
_WATCHERS = []


def watch(ids, fps=DEFAULT_FPS):
    """Registers a subscription and hands back the watcher to read frames from."""
    watcher = Watcher(ids, fps)
    with _WATCH_LOCK:
        _WATCHERS.append(watcher)
    start()
    _touch()
    _wake()
    return watcher


def unwatch(watcher):
    with _WATCH_LOCK:
        if watcher in _WATCHERS:
            _WATCHERS.remove(watcher)


def watcher_count():
    with _WATCH_LOCK:
        return len(_WATCHERS)


def _wanted():
    """Every drone id at least one watcher is subscribed to."""
    with _WATCH_LOCK:
        wanted = set()
        for watcher in _WATCHERS:
            wanted |= watcher.ids
        return wanted


def _publish_frame(drone_id, jpeg):
    """Hands one frame to every watcher that wants it and is due another."""
    now = time.monotonic()
    with _WATCH_LOCK:
        watchers = list(_WATCHERS)
    for watcher in watchers:
        if drone_id not in watcher.ids:
            continue
        if now - watcher.sent.get(drone_id, 0.0) < watcher.interval:
            continue
        if watcher.offer("frame", drone_id, jpeg):
            watcher.sent[drone_id] = now


def _publish_roster(payload):
    with _WATCH_LOCK:
        watchers = list(_WATCHERS)
    for watcher in watchers:
        watcher.offer("roster", None, payload)


# --------------------------------------------------------------------------
# pulling frames off the agents

class _Puller(threading.Thread):
    """
    Holds one drone's MJPEG stream open and fans every frame out.

    One of these exists per drone anyone is watching, no matter how many dashboards are
    watching it, which is the whole reason this module is between the browser and the game.
    """

    def __init__(self, drone_id, profile="grid"):
        super().__init__(name=f"camera-{drone_id}", daemon=True)
        self.id = drone_id
        #: What the agent is being asked to render this feed at. Changing it reopens the pull,
        #: since the profile is part of the request rather than something said mid-stream.
        self.profile = profile
        self.latest = None                    # newest jpeg, for one-shot frame requests
        self.at = 0.0
        self.frames = 0
        self.error = None
        self.idle_since = None
        self._stop = threading.Event()

    def stop(self):
        self._stop.set()

    def run(self):
        backoff = 0.5
        while not self._stop.is_set():
            try:
                self._pull()
                backoff = 0.5
            except (OSError, ValueError) as e:
                # An agent restarting, or one that has not opened its port yet. Back off and
                # try again rather than giving up on a drone that is about to come back.
                self.error = str(e)
                if self._stop.wait(backoff):
                    return
                backoff = min(5.0, backoff * 2)

    def _pull(self):
        url = agent_url(self.id, "stream", self.profile)
        request = urllib.request.Request(url, headers={"Accept": "multipart/x-mixed-replace"})
        with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT) as response:
            self.error = None
            while not self._stop.is_set():
                jpeg = _read_part(response)
                if jpeg is None:
                    return                    # the agent closed the stream; run() reconnects
                self.latest = jpeg
                self.at = time.monotonic()
                self.frames += 1
                _publish_frame(self.id, jpeg)


def _read_part(response):
    """One JPEG out of an agent's multipart stream, or None at the end of it."""
    length = None
    # skip the boundary line, then read part headers to the blank line
    while True:
        line = response.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            if length is None:
                continue                      # blank line before the boundary; keep going
            break
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":", 1)[1])

    if length is None or length <= 0:
        return None

    jpeg = response.read(length)
    if len(jpeg) < length:
        return None
    response.read(2)                          # the CRLF the agent writes after the body
    return jpeg


_PULLERS = {}                                 # drone id -> _Puller (hub thread only)


def _reconcile_pullers(wanted):
    """Starts a pull for anything newly watched and retires one nobody has wanted for a while."""
    now = time.monotonic()

    for drone_id in wanted:
        puller = _PULLERS.get(drone_id)
        if puller is None:
            puller = _Puller(drone_id)
            _PULLERS[drone_id] = puller
            puller.start()
        puller.idle_since = None

    for drone_id, puller in list(_PULLERS.items()):
        if drone_id in wanted:
            continue
        if puller.idle_since is None:
            puller.idle_since = now
        elif now - puller.idle_since > IDLE_LINGER:
            puller.stop()
            _PULLERS.pop(drone_id, None)


#: The largest frame a client may ask for. Past this the encoder, not the renderer, is the limit.
MAX_SIZE = (1920, 1080)


def agent_url(drone_id, action, profile=None, size=None):
    """Where to ask this drone's agent for something, at the profile the caller wants."""
    url = f"{base_for(drone_id)}/drones/{urllib.parse.quote(drone_id)}/{action}"
    if profile not in PROFILES:
        return url
    url = f"{url}?profile={profile}"
    if size:
        width = max(64, min(MAX_SIZE[0], int(size[0])))
        height = max(64, min(MAX_SIZE[1], int(size[1])))
        url = f"{url}&width={width}&height={height}"
    return url


def frame(drone_id, profile=None, size=None, timeout=1.5):
    """
    The newest frame for one drone.

    Served from the open pull when there is one, which is free - but only when that pull is
    already at the profile being asked for. A tile wanting a thumbnail is happy with a frame
    from the viewer's 720p stream; somebody who has just opened the viewer is not happy with a
    thumbnail, so that one goes to the agent and asks properly.

    Otherwise this asks the agent directly - the path a dashboard in polling mode takes, and
    the one that answers a tile while its stream is still opening.
    """
    puller = _PULLERS.get(drone_id)
    if (puller is not None and puller.latest is not None
            and time.monotonic() - puller.at < STALE_AFTER
            and (profile != "detail" or puller.profile == "detail")):
        return puller.latest

    with urllib.request.urlopen(agent_url(drone_id, "frame.jpg", profile, size),
                                timeout=timeout) as response:
        return response.read()


def open_stream(drone_id, profile=None, size=None, timeout=_HTTP_TIMEOUT):
    """The raw upstream MJPEG response, for the single-drone passthrough."""
    return urllib.request.urlopen(agent_url(drone_id, "stream", profile, size), timeout=timeout)


# --------------------------------------------------------------------------
# the roster

_ROSTER_LOCK = threading.Lock()
_ROSTER = {"drones": [], "clientFps": 0, "agents": 0, "online": False,
           "watchers": 0, "revision": 0, "at": 0.0}


def roster():
    """The merged roster. Asking marks it as wanted, which is what keeps the hub polling."""
    start()
    _touch()
    with _ROSTER_LOCK:
        return dict(_ROSTER, watchers=watcher_count())


def _poll_agents():
    """Asks every agent for its roster, in parallel, and merges the answers."""
    _, bases = directory()
    answers = [None] * len(bases)

    def ask(index, base):
        try:
            answers[index] = _get_json(f"{base}/drones")
        except (OSError, ValueError):
            answers[index] = None             # an agent restarting should not blank the rest

    threads = [threading.Thread(target=ask, args=(i, base), daemon=True)
               for i, base in enumerate(bases)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=_HTTP_TIMEOUT + 0.5)

    drones = []
    seen = set()
    client_fps = 0
    reached = 0
    for answer in answers:
        if not answer:
            continue
        reached += 1
        fps = answer.get("clientFps") or 0
        # Each agent reports its own frame rate; the slowest is the one worth worrying about.
        client_fps = fps if client_fps == 0 else min(client_fps, fps)
        for drone in answer.get("drones") or []:
            # Agents standing near each other both film the same drone. First one wins; the
            # directory decides who actually serves it.
            if drone.get("id") in seen:
                continue
            seen.add(drone["id"])
            drones.append(drone)

    drones.sort(key=lambda d: str(d.get("id")))
    return {"drones": drones, "clientFps": client_fps, "agents": len(bases), "online": reached > 0}


def _merge_live(drones):
    """
    Overlays wherever the mod says the drones actually are.

    The agents report a position too, but only as often as they are asked; the mod pushes one
    several times a second for free. Flying by hand aims a step ahead of the drone, so this is
    the difference between smooth flight and a lurch - without asking the game anything extra.
    """
    feed = live.snapshot()
    if not feed.get("live"):
        return drones
    positions = {str(d.get("id")): d for d in feed.get("drones") or []}
    merged = []
    for drone in drones:
        position = positions.get(str(drone.get("id")))
        if position is None:
            merged.append(drone)
            continue
        merged.append(dict(drone, x=position.get("x", drone.get("x")),
                           y=position.get("y", drone.get("y")),
                           z=position.get("z", drone.get("z")),
                           yaw=position.get("yaw", drone.get("yaw")),
                           target=position.get("target")))
    return merged


#: The fields a change to which is worth pushing a new roster for. Positions are in, so a moving
#: drone moves on screen; the profile is in, so a feed being singled out shows up as one; the frame
#: counter is out, or every roster would differ from the last and none of them would mean anything.
_WATCHED_FIELDS = ("id", "x", "y", "z", "yaw", "live", "viewers", "target",
                   "width", "height", "fps", "detail")


def _signature(payload):
    """What counts as a change worth pushing."""
    return json.dumps([[d.get(field) for field in _WATCHED_FIELDS] for d in payload["drones"]]
                      + [payload["online"], payload["agents"]],
                      separators=(",", ":"))


# --------------------------------------------------------------------------
# the hub

_HUB = None
_HUB_LOCK = threading.Lock()
_WAKE = threading.Event()
_INTEREST = 0.0


def _touch():
    """Notes that somebody wants this, so the hub keeps the roster fresh."""
    global _INTEREST
    _INTEREST = time.monotonic()


def _wanted_by_anyone():
    return watcher_count() > 0 or time.monotonic() - _INTEREST < INTEREST_TTL


def _wake():
    _WAKE.set()


def start():
    """Starts the background hub. Idempotent; safe to call from any request."""
    global _HUB
    with _HUB_LOCK:
        if _HUB is None or not _HUB.is_alive():
            _HUB = threading.Thread(target=_hub, name="camera-hub", daemon=True)
            _HUB.start()


def _hub():
    """
    The one loop that talks to the agents.

    Rosters are re-read from the agents once a second; positions are re-merged from the mod's
    feed every tick, which is what keeps a moving drone moving on screen without asking
    Minecraft anything more often. Anything that changed goes out to the watchers.
    """
    agents = {"drones": [], "clientFps": 0, "agents": 0, "online": False}
    last_poll = 0.0
    last_signature = None

    while True:
        now = time.monotonic()
        interval = ROSTER_INTERVAL if _wanted_by_anyone() else IDLE_ROSTER_INTERVAL
        if now - last_poll >= interval:
            last_poll = now
            agents = _poll_agents()

        payload = dict(agents, drones=_merge_live(agents["drones"]))
        signature = _signature(payload)
        if signature != last_signature:
            last_signature = signature
            with _ROSTER_LOCK:
                _ROSTER.update(payload, revision=_ROSTER["revision"] + 1, at=time.time())
            _publish_roster(roster())

        _reconcile_pullers(_wanted())

        # A new subscription should not wait out the tick before its pull starts.
        _WAKE.wait(TICK)
        _WAKE.clear()


# --------------------------------------------------------------------------
# the multiplexed stream

def part(event, body, content_type, drone_id=None):
    """One part of the outgoing multipart stream, already encoded."""
    headers = [f"--{BOUNDARY}",
               f"Content-Type: {content_type}",
               f"Content-Length: {len(body)}",
               f"X-Firekeep-Event: {event}"]
    if drone_id is not None:
        headers.append(f"X-Drone-Id: {drone_id}")
    return "\r\n".join(headers).encode("utf-8") + b"\r\n\r\n" + body + b"\r\n"


def roster_part(payload=None):
    body = json.dumps(payload if payload is not None else roster(),
                      separators=(",", ":")).encode("utf-8")
    return part("roster", body, "application/json")


def frame_part(drone_id, jpeg):
    return part("frame", jpeg, "image/jpeg", drone_id)


def parts(watcher, timeout=1.0):
    """
    Everything a watcher should be sent, as encoded multipart chunks.

    Yields None when nothing has happened for {@code timeout}, so the caller can decide
    whether to send a keepalive rather than block forever on a quiet fleet.
    """
    yield roster_part()
    while True:
        try:
            event, drone_id, payload = watcher.queue.get(timeout=timeout)
        except queue.Empty:
            yield None
            continue
        if event == "frame":
            yield frame_part(drone_id, payload)
        else:
            yield roster_part(payload)


def status():
    """What the hub is doing, for /api/health."""
    return {"agents": _ROSTER["agents"], "online": _ROSTER["online"],
            "drones": len(_ROSTER["drones"]), "watchers": watcher_count(),
            "pulling": sorted(_PULLERS)}
