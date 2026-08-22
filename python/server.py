#!/usr/bin/env python3
"""
Capture server: waits for Minecraft to hand it a screenshot, turns it into a
world, serves the results.

    python3 server.py                  # listen on 127.0.0.1:8000
    python3 server.py --watch          # also auto-submit new screenshots

The mod POSTs raw PNG bytes:

    POST /capture            body: image bytes
                             optional: ?backend=marble|wildfire&model=&prompt=&pano=1
      -> 202 {"job_id": "...", "status": "queued"}

Two backends can turn that screenshot into a world. `wildfire`, the default,
hands the shot to the n8n workflow, which captions it, writes its own prompt
and calls World Labs itself - see wildfire.py. `marble` is the older path: this
server calling the Marble API directly with the key in .env, on the model you
picked. Nothing calls Marble unless a capture, or --backend, asks for it.

    POST /api/events         set off a fire, a storm, an explosion or a dousing
    GET  /api/events         the disaster log, newest first

    POST /api/drones/spawn   put a new drone on the map; the mod gives it an agent

    POST /api/incidents      a drone photographs what it can see; the shots are read here and
                             written up with a map of the affected area
    GET  /api/incidents      those reports, newest first
    GET  /api/incidents/<id> one report in full
    GET  /incidents/<id>/<f> its photographs, its generated view and its map

    ANY  /api/fleet/*        the mod's control API, proxied: /api/fleet/drones,
                             /api/fleet/drones/<id>/perception, /api/fleet/dispatch, ...
    POST /api/mod/events     Minecraft reporting something; forwarded on to n8n
    GET  /api/mod/events     those reports, newest first, for a workflow that missed one

    GET  /api/jobs           every job, newest first
    GET  /api/jobs/<id>      one job, including the full world payload
    GET  /api/health         {ok, credits, queued, busy}
    GET  /jobs/<id>/pano.png source.png, preview.jpg, job.json
    GET  /api/world          top-down map metadata for the live save
    GET  /api/world/map.png  that map, one pixel per block
    GET  /api/world/stream   the mod's live world feed, as server-sent events
    GET  /api/cameras        the drone roster, merged from every agent
    GET  /api/cameras/feed   those drones' frames and the roster, one connection
    GET  /latest.png         the most recent finished render
    GET  /                   the viewer

This is the hub, and the only process anything outside this machine talks to. n8n reaches
Minecraft through /api/fleet/*, Minecraft reports back through /api/mod/events, the dashboard
reads everything else, and the mod's own control API stays on loopback where it belongs.

    n8n  ──▶ (tunnel) ──▶ server.py ──▶ 127.0.0.1:8090   the mod's control API
                              │  ▲
    dashboard ────────────────┘  └───  the mod's world feed and event pushes
                              └──────▶ n8n webhooks, World Labs, the camera agents

Set FIREKEEP_API_KEY to gate it: every /api route except /api/health then wants
`Authorization: Bearer <key>` from anything that did not come from this machine.

Every finished job also drops a plain PNG in out/renders/, and copies it to
out/latest.png, so there is always one obvious file to look at.
"""

import argparse
import ipaddress
import json
import os
import queue
import secrets
import shutil
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

import cameras
import incidents
import live
import marble
import minecraft
import n8n
import wildfire
import worldmap

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
JOBS = OUT / "jobs"
RENDERS = OUT / "renders"        # every finished render, flat and easy to open
LATEST = OUT / "latest.png"      # ...and the newest one, always at the same path
WORLD = OUT / "world"            # cached top-down maps, one PNG per dimension

MAX_UPLOAD = 32 * 1024 * 1024          # 32 MB is far above any screenshot
MAX_BODY = 256 * 1024                  # a JSON command, not an image
JOBS_LOCK = threading.Lock()
JOBS_BY_ID = {}                         # id -> dict
WORK = queue.Queue()
WORLD_LOCK = threading.Lock()
WORLD_BY_DIM = {}               # dimension -> {meta, png, stamp}
# Minecraft touches region files while saving. Rendering the complete disk map for both the
# metadata request and the following PNG request makes the browser cancel the first image and
# leaves the dashboard in a permanent loading loop. The live feed paints changes immediately;
# this base layer only needs a short stability window.
WORLD_CACHE_SECONDS = 30.0
LIVE_LOG_LOCK = threading.Lock()
LIVE_LOG_AT = 0.0
LIVE_LOG_INTERVAL = 30.0


def bridge_log(channel, message):
    """One human-readable audit line for traffic crossing the n8n/Minecraft boundary."""
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{stamp}] [{channel}] {message}", flush=True)


def log_live_heartbeat(columns, commands):
    """The mod posts five times a second; retain proof of life without flooding the console."""
    global LIVE_LOG_AT
    now = time.monotonic()
    with LIVE_LOG_LOCK:
        if now - LIVE_LOG_AT < LIVE_LOG_INTERVAL:
            return
        LIVE_LOG_AT = now
    bridge_log("minecraft", f"live feed active: columns={columns}, queued_commands={commands}")


# auto-triggered generation should be cheap by default; override with --model
DEFAULT_MODEL = "marble-1.0-draft"
BACKENDS = ("marble", "wildfire")

# n8n owns the generation: it captions the shot, writes the prompt and calls
# World Labs with its own key. Nothing here talks to the Marble API unless a
# capture asks for it by name.
DEFAULT_BACKEND = "wildfire"

# /api/health is polled by the dashboard, and only the marble backend has a
# balance to report - so the one API call it needs is kept behind a cache
CREDITS_TTL = 60
CREDITS_CACHE = {"at": 0.0, "value": None}

# --dry-run: captures are accepted and echoed back, nothing is ever generated.
# Not the same as "no API key" - a wildfire job never needs one.
DRY_RUN = False

# The shared secret the outside world - which in practice means n8n - has to present. Empty
# leaves the API open, which is right for a laptop and wrong for anything with a tunnel on it.
API_KEY = ""
#: Reachable without the key, so a probe through the tunnel can tell "down" from "rejected".
OPEN_PATHS = ("/api/health",)
#: Everything under here is handed to the mod's own control API, verb, query and body intact.
FLEET_PREFIX = "/api/fleet"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# jobs

def job_dir(job_id):
    return JOBS / job_id


def save_job(job):
    d = job_dir(job["id"])
    d.mkdir(parents=True, exist_ok=True)
    (d / "job.json").write_text(json.dumps(job, indent=2))


def update(job_id, **fields):
    with JOBS_LOCK:
        job = JOBS_BY_ID.get(job_id)
        if not job:
            return None
        job.update(fields, updated=now())
        save_job(job)
        return dict(job)


def load_jobs():
    """Rebuild the registry from disk so restarts keep history."""
    if not JOBS.is_dir():
        return
    for f in sorted(JOBS.glob("*/job.json")):
        try:
            job = json.loads(f.read_text())
        except json.JSONDecodeError:
            continue
        # anything mid-flight when we died is not coming back
        if job.get("status") in ("queued", "generating"):
            job["status"] = "failed"
            job["error"] = "server restarted while this job was running"
        JOBS_BY_ID[job["id"]] = job
    print(f"loaded {len(JOBS_BY_ID)} previous job(s)")


def submit(image_bytes, extension, *, model, prompt, is_pano, source, backend=DEFAULT_BACKEND):
    job_id = uuid.uuid4().hex[:12]
    d = job_dir(job_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / f"source{extension}").write_bytes(image_bytes)

    if backend == "wildfire":
        # the workflow picks the model and captions the screenshot itself, so
        # neither of ours would be honoured; recording them would be a lie
        model, prompt = "n8n:minecraft-wildfire", None
        credits = wildfire.CREDITS
    else:
        credits = marble.MODELS[model] + (0 if is_pano else marble.PANO_STEP)

    job = {
        "id": job_id,
        "status": "queued",
        "backend": backend,
        "created": now(),
        "updated": now(),
        "model": model,
        "prompt": prompt,
        "is_pano": is_pano,
        "source": source,
        "source_file": f"source{extension}",
        "bytes": len(image_bytes),
        "estimated_credits": credits,
        "progress": None,
        "world_id": None,
        "marble_url": None,
        "world_url": None,
        "generated_prompt": None,
        "assets": {},
        "result_png": None,
        "error": None,
    }
    with JOBS_LOCK:
        JOBS_BY_ID[job_id] = job
    save_job(job)
    WORK.put(job_id)
    print(f"[{job_id}] queued  <- {source} ({len(image_bytes)/1e6:.1f} MB, {backend}/{model})")
    return job


def publish_result(job, saved):
    """Copy the finished render out to out/renders/ and out/latest.png.

    The job folder is the archive; this is the one file you can just open. The
    pano is the sharpest 2D output Marble produces, so prefer it and fall back
    to the thumbnail. Returns the path, or None if the job produced no image.
    """
    d = job_dir(job["id"])
    source = None
    for key_name in ("pano", "preview"):
        candidate = d / saved.get(key_name, "")
        if saved.get(key_name) and candidate.is_file():
            source = candidate
            break
    if source is None:
        return None

    RENDERS.mkdir(parents=True, exist_ok=True)
    stamp = job["created"].replace("-", "").replace(":", "").replace("+0000", "")
    dest = RENDERS / f"{stamp}-{job['id']}{source.suffix}"
    shutil.copyfile(source, dest)
    if source.suffix == ".png":
        shutil.copyfile(source, LATEST)
    return str(dest)


def credit_balance(server):
    """The Marble balance, at most once a minute however often health is polled."""
    if server.key is None:
        return 0
    if time.time() - CREDITS_CACHE["at"] < CREDITS_TTL:
        return CREDITS_CACHE["value"]
    try:
        CREDITS_CACHE["value"] = marble.credits(server.key)
    except marble.MarbleError as e:
        CREDITS_CACHE["value"] = f"unavailable: {e}"
    CREDITS_CACHE["at"] = time.time()
    return CREDITS_CACHE["value"]


def worker(key):
    while True:
        job_id = WORK.get()
        try:
            run_job(job_id, key)
        except Exception as e:                       # never let the worker die
            print(f"[{job_id}] failed: {e}")
            update(job_id, status="failed", error=str(e))
        finally:
            WORK.task_done()


def run_job(job_id, key):
    with JOBS_LOCK:
        job = dict(JOBS_BY_ID[job_id])
    d = job_dir(job_id)
    img = (d / job["source_file"]).read_bytes()

    update(job_id, status="generating")
    if DRY_RUN:
        print(f"[{job_id}] dry run, no API call")
        for pct in (25, 60, 100):
            time.sleep(0.6)
            update(job_id, progress=pct)
        # echo the screenshot straight back out so the mod round trip is still
        # end-to-end testable without spending a credit
        echoed = {"pano": job["source_file"]} if job["source_file"].endswith(".png") else {}
        result = publish_result(job, echoed)
        update(job_id, status="done", world_id="dry-run", estimated_credits=0,
               assets={}, result_png=result, took_seconds=1.8,
               caption="(dry run - the screenshot was echoed back, nothing was generated)")
        return

    if job.get("backend") == "wildfire":
        return run_wildfire(job_id, job, d, img)

    if key is None:
        raise marble.MarbleError("no WORLDLABS_API_KEY - this job needed one "
                                 "(POST /capture?backend=wildfire does not)")

    print(f"[{job_id}] generating ({job['model']})")
    t0 = time.time()

    op = marble.generate(
        img, Path(job["source_file"]).suffix, job["prompt"], job["model"], key,
        display_name=f"minecraft {job['created'][:16]}", is_pano=job["is_pano"],
    )
    update(job_id, operation_id=op)

    world = marble.wait(op, key, on_progress=lambda p: update(job_id, progress=p))
    saved = marble.save_assets(world, d)
    (d / "world.json").write_text(json.dumps(world, indent=2))

    result = publish_result(job, saved)

    update(job_id, status="done", progress=100, world_id=world.get("world_id"),
           marble_url=world.get("world_marble_url"), assets=saved,
           result_png=result,
           caption=(world.get("assets") or {}).get("caption"),
           took_seconds=round(time.time() - t0, 1))
    print(f"[{job_id}] done in {time.time()-t0:.0f}s -> {result or world.get('world_marble_url')}")


def run_wildfire(job_id, job, d, img):
    """Hand the screenshot to the n8n workflow and wait for it to come back.

    No key and no prompt on this side: n8n captions the screenshot, writes the
    prompt and pays World Labs itself. What we keep is the prompt it wrote, so
    the dashboard can show what the picture was actually asked for.
    """
    print(f"[{job_id}] generating (n8n wildfire)")
    t0 = time.time()

    started = wildfire.start(img, Path(job["source_file"]).suffix)
    update(job_id, operation_id=started["operation_id"], status_url=started["status_url"],
           prompt=started["prompt"], generated_prompt=started["prompt"], progress=5)
    if started["prompt"]:
        print(f"[{job_id}] prompt: {started['prompt'][:120]}")

    payload = wildfire.wait(started["status_url"],
                            on_progress=lambda p: update(job_id, progress=p))
    saved = wildfire.save_assets(payload, d)
    (d / "world.json").write_text(json.dumps(payload, indent=2))

    result = publish_result(job, saved)
    assets = payload.get("assets") if isinstance(payload.get("assets"), dict) else {}
    world_url = payload.get("world_url")

    update(job_id, status="done", progress=100, world_id=payload.get("world_id"),
           world_url=world_url, marble_url=world_url, assets=saved, result_png=result,
           caption=assets.get("caption") or payload.get("caption"),
           took_seconds=round(time.time() - t0, 1))
    print(f"[{job_id}] done in {time.time()-t0:.0f}s -> {result or world_url}")


# --------------------------------------------------------------------------
# screenshot folder watcher

def watch_dirs(dirs, model, prompt, backend=DEFAULT_BACKEND, interval=2.0):
    seen = {p for d in dirs for p in d.glob("*.png")}
    print(f"watching {len(dirs)} folder(s), {len(seen)} existing shot(s) ignored")
    while True:
        time.sleep(interval)
        for d in dirs:
            for p in sorted(d.glob("*.png")):
                if p in seen:
                    continue
                seen.add(p)
                time.sleep(0.4)                      # let the write finish
                try:
                    submit(p.read_bytes(), ".png", model=model, prompt=prompt,
                           backend=backend, is_pano=False, source=f"watch:{p.name}")
                except Exception as e:
                    print(f"! could not submit {p.name}: {e}")


def screenshot_dirs():
    home = Path.home()
    roots = [
        home / "Library/Application Support/minecraft/screenshots",
        HERE.parent / "fabric/run/screenshots",
    ]
    for parent in [home / "Library/Application Support/ModrinthApp/profiles",
                   home / "Library/Application Support/PrismLauncher/instances"]:
        if parent.is_dir():
            roots += parent.glob("*/screenshots")
    return [d for d in roots if d.is_dir()]


# --------------------------------------------------------------------------
# world map

def world_stamp(save, dimension):
    """Cheap fingerprint of the region files, so we only re-render after a save."""
    try:
        return sorted((f.name, f.stat().st_mtime_ns, f.stat().st_size)
                      for f in worldmap.region_dir(save, dimension).glob("r.*.mca"))
    except worldmap.WorldError:
        return None


def world_map(dimension, save=None, refresh=False):
    """
    Renders (or serves from cache) the top-down map of one dimension.

    Rendering a few hundred chunks takes a couple of seconds, so it is cached
    both in memory and on disk and only redone once Minecraft writes the region
    files again.
    """
    save = save or worldmap.find_save()
    if save is None:
        raise worldmap.WorldError("no Minecraft save found - point --save at one")

    with WORLD_LOCK:
        stamp = world_stamp(save, dimension)
        cached = WORLD_BY_DIM.get(dimension)
        if cached and not refresh and (
                cached["stamp"] == stamp
                or time.monotonic() - cached["rendered_at"] < WORLD_CACHE_SECONDS):
            return cached["png"], cached["meta"]

        png, meta = worldmap.render(save, dimension)
        meta.update(worldmap.level_info(save), save=str(save))

        WORLD.mkdir(parents=True, exist_ok=True)
        (WORLD / f"{dimension}.png").write_bytes(png)
        (WORLD / f"{dimension}.json").write_text(json.dumps(meta, indent=2))

        WORLD_BY_DIM[dimension] = {"png": png, "meta": meta, "stamp": stamp,
                                   "rendered_at": time.monotonic()}
        print(f"world map: {dimension} {meta['width']}x{meta['height']} "
              f"from {meta['chunks']} chunks in {meta['took_seconds']}s")
        return png, meta


# --------------------------------------------------------------------------
# http

class Handler(BaseHTTPRequestHandler):
    server_version = "firekeep"
    protocol_version = "HTTP/1.1"
    # Nagle holds a small write back for up to 40ms hoping to coalesce it with the next one.
    # Every stream here is small writes that are wanted immediately - a JPEG frame, an SSE
    # event - so that delay is pure added latency on the thing being watched.
    disable_nagle_algorithm = True

    def log_message(self, fmt, *a):
        pass

    def send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, indent=2).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self._write(body)

    def send_bytes(self, body, ctype, status=HTTPStatus.OK):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self._write(body)

    def _write(self, body):
        """A browser cancelling an image fetch is normal, not a hub failure."""
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    # -- who is asking -------------------------------------------------------
    def is_local(self):
        """
        True for a caller on this machine that did not arrive through a proxy.

        The socket being loopback proves nothing on its own: cloudflared runs here too, so a
        request from the other side of the world also arrives from 127.0.0.1. What separates
        them is that a proxy says who it is forwarding for, and this one does not trust a
        forwarded chain that starts outside the LAN.
        """
        peer = (self.client_address[0] or "").split("%")[0]
        try:
            if not ipaddress.ip_address(peer).is_loopback:
                return False
        except ValueError:
            return False

        forwarded = (self.headers.get("CF-Connecting-IP")
                     or self.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
        if not forwarded:
            return True
        try:
            origin = ipaddress.ip_address(forwarded)
        except ValueError:
            return False
        return origin.is_loopback or origin.is_private

    def authorised(self, path):
        if not API_KEY or path in OPEN_PATHS or not path.startswith("/api"):
            return True
        header = (self.headers.get("Authorization") or "").strip()
        presented = header[7:].strip() if header[:7].lower() == "bearer " else ""
        presented = presented or (self.headers.get("X-API-Key") or "").strip()
        if presented and secrets.compare_digest(presented, API_KEY):
            return True
        return self.is_local()

    def gate(self):
        """Answers 401 and returns False if this caller may not be here."""
        if self.authorised(urlparse(self.path).path):
            return True
        self.send_json({"ok": False, "error": "missing or invalid API key; send "
                                              "Authorization: Bearer <FIREKEEP_API_KEY>"},
                       HTTPStatus.UNAUTHORIZED)
        return False

    # -- /api/fleet/* --------------------------------------------------------
    def fleet(self, method):
        """
        Hands one call straight through to the mod, and its answer straight back.

        Deliberately a pass-through rather than a curated set of endpoints: the mod's control
        API is the contract a workflow already knows, and re-declaring every route here would
        mean two places to change every time a drone learns a new trick. What this adds is the
        parts a workflow should not have to hold - where Minecraft is, and its bearer token.
        """
        url = urlparse(self.path)
        path = url.path[len(FLEET_PREFIX):] or "/"
        query = {k: v[0] for k, v in parse_qs(url.query).items()}

        body = None
        if method == "POST":
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self.send_json({"error": f"body over {MAX_BODY} bytes"},
                                      HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            raw = self.rfile.read(length) if length > 0 else b""
            try:
                body = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                return self.send_json({"error": "body must be JSON"}, HTTPStatus.BAD_REQUEST)

        # ?wait=true asks the mod to hold the reply until the drone has finished, which is a
        # flight rather than a request - so the timeout has to be a flight's worth of patience.
        waiting = str(query.get("wait", "")).lower() in ("1", "true", "yes")
        started = time.monotonic()
        try:
            payload = minecraft.request(method, path, body, query=query,
                                        timeout=minecraft.LONG_TIMEOUT if waiting
                                        else minecraft.DEFAULT_TIMEOUT)
        except minecraft.MinecraftError as e:
            bridge_log("minecraft", f"{method} /api{path} -> {e.status} in "
                       f"{(time.monotonic() - started) * 1000:.0f}ms: {e}")
            return self.send_json({"ok": False, "error": str(e)}, e.status)
        bridge_log("minecraft", f"{method} /api{path} -> 200 in "
                   f"{(time.monotonic() - started) * 1000:.0f}ms")
        return self.send_json(payload)

    # -- POST /capture ------------------------------------------------------
    def do_POST(self):
        url = urlparse(self.path)
        if not self.gate():
            return

        # n8n reaching Minecraft. This is the whole inbound control surface: everything the
        # mod's own API offers, behind this server's key rather than the mod's.
        if url.path == FLEET_PREFIX or url.path.startswith(FLEET_PREFIX + "/"):
            return self.fleet("POST")

        # Minecraft reporting something - a fire spotted, an order finished. It used to POST
        # these at n8n directly, which meant the mod had to hold somebody else's webhook URL
        # and secret; now it tells us, and we forward.
        if url.path == "/api/mod/events":
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                return self.send_json({"error": "bad body length"}, HTTPStatus.BAD_REQUEST)
            try:
                event = live.record_mod_event(json.loads(self.rfile.read(length)))
            except (json.JSONDecodeError, ValueError, TypeError) as e:
                bridge_log("minecraft", f"rejected mod event: {e}")
                return self.send_json({"error": f"bad mod event: {e}"}, HTTPStatus.BAD_REQUEST)
            forwarded = n8n.notify(event)
            bridge_log("minecraft", "event received: "
                       f"id={event['id']} type={event['event']} agent={event.get('drone_id') or '-'} "
                       f"forwarded_to_n8n={forwarded}")
            return self.send_json({"ok": True, "event": event, "forwarded": forwarded},
                                  HTTPStatus.ACCEPTED)

        # the mod's live world feed: every surface column that just changed
        if url.path == "/api/live":
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_UPLOAD:
                return self.send_json({"error": "bad body length"}, HTTPStatus.BAD_REQUEST)
            try:
                payload = json.loads(self.rfile.read(length))
                delta, commands = live.ingest(payload)
            except (json.JSONDecodeError, ValueError, TypeError) as e:
                bridge_log("minecraft", f"rejected live feed: {e}")
                return self.send_json({"error": f"bad live batch: {e}"}, HTTPStatus.BAD_REQUEST)
            log_live_heartbeat(len(delta["columns"]) // 3, len(commands))
            return self.send_json({"ok": True, "columns": len(delta["columns"]) // 3,
                                   "hot": delta["hot"], "watchers": live.subscriber_count(),
                                   "commands": commands})

        # A workflow's conclusion about what a drone saw. This never controls Minecraft; it is
        # retained for, and displayed on, that drone's video feed.
        if url.path == "/api/drone-events":
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_UPLOAD:
                return self.send_json({"error": "bad body length"}, HTTPStatus.BAD_REQUEST)
            try:
                event = live.record_drone_event(json.loads(self.rfile.read(length)))
            except (json.JSONDecodeError, ValueError, TypeError) as e:
                bridge_log("n8n", f"rejected feed event: {e}")
                return self.send_json({"error": f"bad drone event: {e}"}, HTTPStatus.BAD_REQUEST)
            bridge_log("n8n", "feed event received: "
                       f"id={event['id']} type={event['type']} drone={event['drone_id']} "
                       f"severity={event['severity']}")
            return self.send_json({"ok": True, "event": event}, HTTPStatus.ACCEPTED)

        # set off a disaster; same channel as a drone order, and the outcome comes back
        # on the push after the one that collected it
        if url.path == "/api/events":
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_UPLOAD:
                return self.send_json({"error": "bad body length"}, HTTPStatus.BAD_REQUEST)
            try:
                body = json.loads(self.rfile.read(length))
                event, queued = live.simulate(
                    body.get("kind", "fire"), body["x"], body["z"],
                    y=body.get("y"),
                    radius=body.get("radius", 6),
                    intensity=body.get("intensity", 3),
                    dimension=body.get("dimension") or "minecraft:overworld",
                    label=body.get("label", ""),
                    source=body.get("source") or self.headers.get("X-Source", "dashboard"),
                )
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
                return self.send_json({"error": f"bad event: {e}"}, HTTPStatus.BAD_REQUEST)
            return self.send_json({"ok": True, "event": event, "queued": queued,
                                   "live": live.snapshot(event["dimension"])["live"]},
                                  HTTPStatus.ACCEPTED)

        # send a drone somewhere; the mod picks this up on its next feed POST
        if url.path == "/api/drones/goto":
            length = int(self.headers.get("Content-Length") or 0)
            try:
                order = json.loads(self.rfile.read(max(0, length)))
                queued = live.order(order["id"], order["x"], order["y"], order["z"])
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
                return self.send_json({"error": f"bad order: {e}"}, HTTPStatus.BAD_REQUEST)
            return self.send_json({"ok": True, "queued": queued}, HTTPStatus.ACCEPTED)

        # WASD stick: the drone keeps this velocity until a later hover or goto
        if url.path == "/api/drones/fly":
            length = int(self.headers.get("Content-Length") or 0)
            try:
                order = json.loads(self.rfile.read(max(0, length)))
                queued = live.fly(order["id"], order.get("forward", 0), order.get("right", 0),
                                  order.get("up", 0), order.get("yaw", 0))
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
                return self.send_json({"error": f"bad order: {e}"}, HTTPStatus.BAD_REQUEST)
            return self.send_json({"ok": True, "queued": queued}, HTTPStatus.ACCEPTED)

        # Camera gimbal: positive pitch looks down. This is deliberately separate from the
        # movement stick so an operator can inspect the ground without cancelling a flight.
        if url.path == "/api/drones/look":
            length = int(self.headers.get("Content-Length") or 0)
            try:
                order = json.loads(self.rfile.read(max(0, length)))
                queued = live.look(order["id"], order["pitch"])
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
                return self.send_json({"error": f"bad camera angle: {e}"}, HTTPStatus.BAD_REQUEST)
            return self.send_json({"ok": True, "queued": queued}, HTTPStatus.ACCEPTED)

        # plop a new drone down where the dashboard clicked; the mod builds it and starts an
        # agent to render it, and it appears in the feed a flush later like any other drone
        if url.path == "/api/drones/spawn":
            length = int(self.headers.get("Content-Length") or 0)
            try:
                order = json.loads(self.rfile.read(max(0, length)))
                queued = live.spawn(order["x"], order["z"], y=order.get("y"),
                                    drone_id=order.get("id"),
                                    dimension=order.get("dimension") or "minecraft:overworld")
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
                return self.send_json({"error": f"bad placement: {e}"}, HTTPStatus.BAD_REQUEST)
            return self.send_json({"ok": True, "queued": queued}, HTTPStatus.ACCEPTED)

        if url.path == "/api/drones/hover":
            length = int(self.headers.get("Content-Length") or 0)
            try:
                order = json.loads(self.rfile.read(max(0, length)))
                queued = live.hover(order["id"])
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
                return self.send_json({"error": f"bad order: {e}"}, HTTPStatus.BAD_REQUEST)
            return self.send_json({"ok": True, "queued": queued}, HTTPStatus.ACCEPTED)

        # A drone is asked to photograph what it can see, and the pictures become a report:
        # incidents.py captions them off the live feed, which also says what is burning around
        # the drone, and the two are written up together. Long enough to matter, so this only
        # starts it.
        if url.path == "/api/incidents":
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self.send_json({"error": f"body over {MAX_BODY} bytes"},
                                      HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            try:
                body = json.loads(self.rfile.read(length)) if length > 0 else {}
                record = incidents.open_report(
                    body.get("drone_id") or body.get("id"),
                    shots=body.get("shots", incidents.DEFAULT_SHOTS),
                    note=body.get("note", ""),
                    radius=body.get("radius", incidents.DEFAULT_RADIUS),
                    dimension=body.get("dimension") or incidents.DIMENSION,
                    kind=body.get("kind", "patrol"),
                    source=body.get("source") or self.headers.get("X-Source", "dashboard"),
                )
            except (json.JSONDecodeError, TypeError, ValueError) as e:
                return self.send_json({"error": f"bad incident request: {e}"},
                                      HTTPStatus.BAD_REQUEST)
            except incidents.IncidentError as e:
                # No photograph is not a bad request - the drone is there, its camera is not.
                return self.send_json({"error": str(e)}, HTTPStatus.SERVICE_UNAVAILABLE)
            return self.send_json({"ok": True, "incident": record}, HTTPStatus.ACCEPTED)

        if url.path != "/capture":
            return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return self.send_json({"error": "empty body"}, HTTPStatus.BAD_REQUEST)
        if length > MAX_UPLOAD:
            return self.send_json({"error": f"body over {MAX_UPLOAD} bytes"},
                                  HTTPStatus.REQUEST_ENTITY_TOO_LARGE)

        data = self.rfile.read(length)
        if not data.startswith(b"\x89PNG") and not data.startswith(b"\xff\xd8"):
            return self.send_json({"error": "body must be raw PNG or JPEG bytes"},
                                  HTTPStatus.UNSUPPORTED_MEDIA_TYPE)

        q = parse_qs(url.query)
        one = lambda k, d=None: (q.get(k) or [d])[0]
        backend = one("backend", self.server.backend)
        if backend not in BACKENDS:
            return self.send_json({"error": f"unknown backend {backend}",
                                   "backends": list(BACKENDS)}, HTTPStatus.BAD_REQUEST)

        # wildfire ignores the model - n8n picks its own - so only marble's is checked
        model = one("model", self.server.model)
        if backend == "marble" and model not in marble.MODELS:
            return self.send_json({"error": f"unknown model {model}",
                                   "models": list(marble.MODELS)}, HTTPStatus.BAD_REQUEST)

        job = submit(
            data, ".png" if data.startswith(b"\x89PNG") else ".jpg",
            backend=backend,
            model=model,
            prompt=one("prompt", self.server.prompt),
            is_pano=one("pano", "") in ("1", "true", "yes"),
            source=one("source", self.headers.get("X-Source", "post")),
        )
        self.send_json({"job_id": job["id"], "status": job["status"],
                        "backend": job["backend"],
                        "estimated_credits": job["estimated_credits"],
                        "url": f"/api/jobs/{job['id']}"}, HTTPStatus.ACCEPTED)

    # -- GET /api/world/stream ----------------------------------------------
    def stream(self, dimension):
        """
        Server-sent events: one `hello` with where things stand, then a `delta` for every
        batch the mod pushes and an `events` whenever a simulated disaster moves on - queued
        to sent, sent to whatever it did. No Content-Length, so the connection is
        close-delimited.
        """
        sink = live.subscribe()
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            # no-transform stops the Next dev proxy gzipping the stream: compression
            # buffers it, and a buffered event stream never reaches the browser
            self.send_header("Cache-Control", "no-store, no-transform")
            self.send_header("Content-Encoding", "identity")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()

            self.wfile.write(live.sse("hello", live.snapshot(dimension)))
            self.wfile.flush()

            idle = time.monotonic()
            while True:
                try:
                    event, data = sink.get(timeout=1.0)
                except queue.Empty:
                    if time.monotonic() - idle > live.HEARTBEAT:
                        idle = time.monotonic()
                        # a comment keeps proxies from closing an idle stream
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.write(live.sse("status", live.snapshot(dimension)))
                        self.wfile.flush()
                    continue

                # a mod event does not necessarily name a dimension; only filter what does
                if data.get("dimension") not in (None, dimension):
                    continue
                idle = time.monotonic()
                self.wfile.write(live.sse(event, data))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass                                    # the dashboard went away
        finally:
            live.unsubscribe(sink)

    # -- GET /api/cameras/feed ----------------------------------------------
    def camera_feed(self, ids, fps):
        """
        Every subscribed drone's frames, and the roster, down one connection.

        A multipart stream rather than anything cleverer because the browser can read it with
        plain `fetch` and split it itself - no socket upgrade to get through the dev proxy, and
        no base64 inflating every frame by a third. Parts are labelled with X-Firekeep-Event,
        and frames additionally with X-Drone-Id.
        """
        watcher = cameras.watch(ids, fps)
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type",
                             f"multipart/x-mixed-replace; boundary={cameras.BOUNDARY}")
            # no-transform for the same reason the world stream sets it: the dev proxy gzips
            # anything it is allowed to, and a buffered stream never reaches the browser.
            self.send_header("Cache-Control", "no-store, no-transform")
            self.send_header("Content-Encoding", "identity")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()

            for chunk in cameras.parts(watcher):
                # A quiet fleet still has to prove the connection is alive; a comment line is
                # ignored by the parser at the other end.
                self.wfile.write(chunk if chunk is not None else cameras.KEEPALIVE)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass                                    # the dashboard went away
        finally:
            cameras.unwatch(watcher)

    def camera_frame(self, drone_id, profile=None, size=None):
        """One still, for a tile in polling mode or a first paint while a stream opens."""
        try:
            jpeg = cameras.frame(drone_id, profile, size)
        except OSError as e:
            return self.send_json({"error": f"agent unreachable: {e}"}, HTTPStatus.BAD_GATEWAY)
        if not jpeg:
            return self.send_json({"error": "no frame yet"}, HTTPStatus.SERVICE_UNAVAILABLE)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(jpeg)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(jpeg)

    def camera_stream(self, drone_id, profile=None, size=None):
        """
        One drone's MJPEG, passed straight through for a plain <img>.

        `profile=detail` is how the dashboard says this is the drone somebody is actually
        looking at. It reaches the agent unchanged, and the agent renders that one feed bigger,
        sharper and more often for as long as this connection is open.
        """
        try:
            upstream = cameras.open_stream(drone_id, profile, size)
        except OSError as e:
            return self.send_json({"error": f"agent unreachable: {e}"}, HTTPStatus.BAD_GATEWAY)

        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", upstream.headers.get(
                "Content-Type", "multipart/x-mixed-replace; boundary=firekeepframe"))
            self.send_header("Cache-Control", "no-store, no-transform")
            self.send_header("Content-Encoding", "identity")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            while True:
                # read1, not read: read(n) blocks until it has all n bytes, so a 4KB frame sat
                # in the buffer until three more arrived behind it - measured at 452ms of pure
                # latency on a 480p feed. read1 hands over whatever has turned up.
                block = upstream.read1(65536)
                if not block:
                    return
                self.wfile.write(block)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass                                    # whichever end went away first
        finally:
            upstream.close()

    # -- DELETE --------------------------------------------------------------
    def do_DELETE(self):
        """Only the fleet has anything to retire; nothing else here deletes."""
        path = urlparse(self.path).path
        if not self.gate():
            return
        if path.startswith(FLEET_PREFIX + "/"):
            return self.fleet("DELETE")
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    # -- OPTIONS -------------------------------------------------------------
    def do_OPTIONS(self):
        """CORS preflight, so a browser-side workflow node can call this directly."""
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -- GET ----------------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        if not self.gate():
            return

        if path == FLEET_PREFIX or path.startswith(FLEET_PREFIX + "/"):
            return self.fleet("GET")

        if path == "/api/mod/events":
            q = parse_qs(urlparse(self.path).query)
            one = lambda k, d=None: (q.get(k) or [d])[0]
            try:
                return self.send_json({"events": live.mod_events(
                    limit=int(one("limit", 50)), kind=one("event"),
                    drone_id=one("drone_id"),
                    since=None if one("since") is None else float(one("since")))})
            except ValueError:
                return self.send_json({"error": "limit and since must be numbers"},
                                      HTTPStatus.BAD_REQUEST)

        if path == "/api/health":
            bal = credit_balance(self.server) if self.server.backend == "marble" else None
            with JOBS_LOCK:
                busy = sum(1 for j in JOBS_BY_ID.values() if j["status"] == "generating")
            feed = live.snapshot()
            return self.send_json({"ok": True, "credits": bal,
                                   "queued": WORK.qsize(), "busy": busy,
                                   "model": self.server.model,
                                   "backend": self.server.backend,
                                   "backends": list(BACKENDS),
                                   "dry_run": DRY_RUN,
                                   "live": feed["live"], "watchers": live.subscriber_count(),
                                   "cameras": cameras.status(),
                                   "incidents": incidents.status(),
                                   # the two links this process is the middle of
                                   "minecraft": dict(minecraft.configured(),
                                                     online=minecraft.online()),
                                   "n8n": n8n.status(),
                                   "secured": bool(API_KEY)})

        if path == "/api/incidents":
            q = parse_qs(urlparse(self.path).query)
            try:
                limit = int((q.get("limit") or [incidents.MAX_REPORTS])[0])
            except ValueError:
                return self.send_json({"error": "limit must be an integer"},
                                      HTTPStatus.BAD_REQUEST)
            return self.send_json({"incidents": incidents.recent(limit),
                                   "analyst": incidents.status()["analyst"]})

        if path.startswith("/api/incidents/"):
            record = incidents.get(path.split("/")[3])
            if not record:
                return self.send_json({"error": "no such report"}, HTTPStatus.NOT_FOUND)
            return self.send_json(record)

        if path == "/api/jobs":
            with JOBS_LOCK:
                jobs = sorted(JOBS_BY_ID.values(), key=lambda j: j["created"], reverse=True)
            return self.send_json(jobs)

        if path.startswith("/api/jobs/"):
            job_id = path.split("/")[3]
            with JOBS_LOCK:
                job = JOBS_BY_ID.get(job_id)
            if not job:
                return self.send_json({"error": "no such job"}, HTTPStatus.NOT_FOUND)
            job = dict(job)
            wf = job_dir(job_id) / "world.json"
            if wf.is_file():
                job["world"] = json.loads(wf.read_text())
            return self.send_json(job)

        # -- the live feed from the mod ----------------------------------------
        if path == "/api/live":
            q = parse_qs(urlparse(self.path).query)
            return self.send_json(live.snapshot((q.get("dimension") or ["minecraft:overworld"])[0]))

        if path == "/api/world/live.png":
            q = parse_qs(urlparse(self.path).query)
            world = live.world((q.get("dimension") or ["minecraft:overworld"])[0])
            png, meta = world.overlay() if world else (None, None)
            if png is None:
                return self.send_json({"error": "nothing live yet"}, HTTPStatus.NOT_FOUND)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(png)))
            self.send_header("Cache-Control", "no-store")
            for k, v in meta.items():
                self.send_header(f"X-Live-{k.replace('_', '-')}", str(v))
            self.end_headers()
            return self._write(png)

        if path == "/api/events":
            q = parse_qs(urlparse(self.path).query)
            where = (q.get("dimension") or ["minecraft:overworld"])[0]
            feed = live.snapshot(where)
            return self.send_json({"events": live.events(where), "live": feed["live"],
                                   "kinds": list(live.EVENT_KINDS)})

        if path == "/api/drone-events":
            q = parse_qs(urlparse(self.path).query)
            drone_id = (q.get("drone_id") or [""])[0]
            if not drone_id:
                return self.send_json({"error": "drone_id is required"}, HTTPStatus.BAD_REQUEST)
            try:
                limit = int((q.get("limit") or [8])[0])
                return self.send_json({"events": live.drone_events(drone_id, limit)})
            except ValueError:
                return self.send_json({"error": "limit must be an integer"}, HTTPStatus.BAD_REQUEST)

        if path == "/api/world/stream":
            q = parse_qs(urlparse(self.path).query)
            return self.stream(( q.get("dimension") or ["minecraft:overworld"])[0])

        # -- the drone cameras, pulled from the agents on the dashboard's behalf
        if path == "/api/cameras":
            return self.send_json(cameras.roster())

        if path == "/api/cameras/feed":
            q = parse_qs(urlparse(self.path).query)
            raw = (q.get("ids") or [""])[0]
            ids = [i for i in raw.split(",") if i]
            try:
                fps = float((q.get("fps") or [cameras.DEFAULT_FPS])[0])
            except ValueError:
                fps = cameras.DEFAULT_FPS
            return self.camera_feed(ids, fps)

        if path.startswith("/api/cameras/"):
            parts = path[len("/api/cameras/"):].rsplit("/", 1)
            if len(parts) == 2 and parts[0]:
                q = parse_qs(urlparse(self.path).query)
                profile = (q.get("profile") or [None])[0]
                if profile not in cameras.PROFILES:
                    profile = None
                size = None
                try:
                    if q.get("width") and q.get("height"):
                        size = (int(q["width"][0]), int(q["height"][0]))
                except ValueError:
                    size = None                 # a nonsense size is no size, not an error
                drone_id = unquote(parts[0])
                if parts[1] == "frame.jpg":
                    return self.camera_frame(drone_id, profile, size)
                if parts[1] == "stream":
                    return self.camera_stream(drone_id, profile, size)
            return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

        # -- the real Minecraft world, read straight off the save --------------
        if path == "/api/world" or path == "/api/world/map.png":
            q = parse_qs(urlparse(self.path).query)
            dimension = (q.get("dimension") or ["overworld"])[0]
            if dimension not in ("overworld", "the_nether", "the_end"):
                return self.send_json({"error": f"unknown dimension {dimension}"},
                                      HTTPStatus.BAD_REQUEST)
            try:
                png, meta = world_map(dimension, self.server.save,
                                      refresh=(q.get("refresh") or [""])[0] in ("1", "true"))
            except worldmap.WorldError as e:
                return self.send_json({"error": str(e)}, HTTPStatus.NOT_FOUND)
            except (OSError, ValueError) as e:
                return self.send_json({"error": f"could not read the world: {e}"},
                                      HTTPStatus.INTERNAL_SERVER_ERROR)

            if path == "/api/world/map.png":
                return self.send_bytes(png, "image/png")
            return self.send_json(dict(meta, map_url=f"/api/world/map.png?dimension={dimension}"))

        if path == "/latest.png":
            if not LATEST.is_file():
                return self.send_json({"error": "nothing rendered yet"}, HTTPStatus.NOT_FOUND)
            return self.send_bytes(LATEST.read_bytes(), "image/png")

        if path in ("/", "/index.html"):
            viewer = HERE / "viewer.html"
            if not viewer.is_file():
                return self.send_json({"error": "viewer.html missing"}, HTTPStatus.NOT_FOUND)
            return self.send_bytes(viewer.read_bytes(), "text/html; charset=utf-8")

        # /incidents/<id>/<file> - the photographs, the map and the generated view
        if path.startswith("/incidents/"):
            parts = [p for p in path.split("/")[2:] if p not in ("", ".", "..")]
            f = incidents.asset(parts[0], parts[1]) if len(parts) == 2 else None
            if f is None:
                return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            ctype = {".png": "image/png", ".jpg": "image/jpeg",
                     ".json": "application/json"}.get(f.suffix, "application/octet-stream")
            return self.send_bytes(f.read_bytes(), ctype)

        # /jobs/<id>/<file> - only ever from inside that job's directory
        if path.startswith("/jobs/"):
            parts = [p for p in path.split("/")[2:] if p not in ("", ".", "..")]
            if len(parts) == 2:
                f = (job_dir(parts[0]) / parts[1]).resolve()
                if f.is_file() and JOBS.resolve() in f.parents:
                    ctype = {".png": "image/png", ".jpg": "image/jpeg",
                             ".json": "application/json"}.get(f.suffix, "application/octet-stream")
                    return self.send_bytes(f.read_bytes(), ctype)
            return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default: localhost only)")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--model", default=DEFAULT_MODEL, choices=list(marble.MODELS),
                    help=f"model for --backend marble captures; wildfire picks its own "
                         f"(default: {DEFAULT_MODEL})")
    ap.add_argument("--backend", default=DEFAULT_BACKEND, choices=list(BACKENDS),
                    help="who generates the world: wildfire posts to the n8n workflow, "
                         "marble calls World Labs from here with the key in .env "
                         f"(default: {DEFAULT_BACKEND})")
    ap.add_argument("--prompt", default=marble.DEFAULT_PROMPT)
    ap.add_argument("--watch", action="store_true",
                    help="also auto-submit new Minecraft screenshots as they appear")
    ap.add_argument("--watch-dir", type=Path, action="append", default=[],
                    metavar="DIR", help="extra folder to watch (repeatable)")
    ap.add_argument("--save", type=Path, default=None, metavar="DIR",
                    help="Minecraft world to map (default: $FIREKEEP_SAVE, else the server's "
                         "world under fabric/run, else the newest fabric/run/saves world)")
    ap.add_argument("--dry-run", action="store_true",
                    help="accept captures but never call the API - for wiring up the mod")
    ap.add_argument("--workers", type=int, default=1, help="concurrent generations")
    ap.add_argument("--api-key", default=None, metavar="KEY",
                    help="require this bearer token on /api from anything off this machine "
                         "(default: $FIREKEEP_API_KEY; unset leaves the API open)")
    ap.add_argument("--minecraft", default=None, metavar="URL",
                    help=f"the mod's control API (default: $FIREKEEP_MINECRAFT, else "
                         f"{minecraft.DEFAULT_URL})")
    args = ap.parse_args()

    # keep logs live when stdout is a file or a pipe
    sys.stdout.reconfigure(line_buffering=True)

    global DRY_RUN, API_KEY
    DRY_RUN = args.dry_run

    # .env is where the keys for both sides live: WORLDLABS_API_KEY for the marble backend,
    # DRONE_API_KEY for the mod, FIREKEEP_N8N_* for the workflows, FIREKEEP_API_KEY for us.
    marble.load_env()
    if args.minecraft:
        os.environ["FIREKEEP_MINECRAFT"] = args.minecraft
    API_KEY = (args.api_key if args.api_key is not None
               else os.environ.get("FIREKEEP_API_KEY", "")).strip()

    # Start the outbox up front, so the first event the mod pushes is delivered rather than
    # being the one that pays for the thread.
    n8n.start()

    # only the marble backend needs a key, so a wildfire-only server may start without one
    key = None
    if not args.dry_run:
        try:
            key = marble.api_key()
        except marble.MarbleError:
            if args.backend != "wildfire":
                raise
            print("! no WORLDLABS_API_KEY - fine for wildfire, but ?backend=marble will fail")

    JOBS.mkdir(parents=True, exist_ok=True)
    load_jobs()

    # Reports are written on their own thread: one takes a while, and an operator asking for a
    # second must not queue behind it or behind a world capture.
    incidents.DRY_RUN = DRY_RUN
    incidents.load()
    incidents.start()

    for _ in range(max(1, args.workers)):
        threading.Thread(target=worker, args=(key,), daemon=True).start()

    # The one conversation with the agents, started up front so the first dashboard to ask
    # gets a roster rather than an empty one it has to poll again for.
    cameras.start()

    if args.watch or args.watch_dir:
        dirs = ([d for d in args.watch_dir if d.is_dir()]
                + (screenshot_dirs() if args.watch else []))
        if not dirs:
            print("! --watch: no screenshot folders found")
        else:
            threading.Thread(target=watch_dirs, args=(dirs, args.model, args.prompt, args.backend),
                             daemon=True).start()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.key, httpd.model, httpd.prompt = key, args.model, args.prompt
    httpd.backend = args.backend
    httpd.save = worldmap.find_save(args.save)

    print(f"\nfirekeep hub  http://{args.host}:{args.port}")
    print(f"  minecraft {minecraft.base_url()}"
          f"{'' if minecraft.api_key() else '  (no DRONE_API_KEY set)'}  ->  /api/fleet/*")
    print(f"  n8n       {n8n.events_url() or '<forwarding off>'}  <-  /api/mod/events")
    if API_KEY:
        print("  api key   required off this machine (Authorization: Bearer ...)")
    else:
        print("  api key   NONE - fine on a laptop, not behind a tunnel; set FIREKEEP_API_KEY")
    if DRY_RUN:
        print("  DRY RUN - captures are accepted but nothing is generated")
    elif args.backend == "wildfire":
        print(f"  backend wildfire -> {wildfire.BASE}")
        print("          n8n writes the prompt and calls World Labs itself;")
        print("          nothing here touches the Marble API unless a capture asks for it")
    else:
        print(f"  model   {args.model} (~{marble.MODELS[args.model] + marble.PANO_STEP} credits/capture)")
        print(f"  credits {marble.credits(key):.0f}")
    print(f"  POST    http://{args.host}:{args.port}/capture  (raw PNG body)")
    narrator = incidents.status()["analyst"]
    print(f"  reports POST /api/incidents  ->  the photo is captioned here, "
          f"{narrator['model'] if narrator['available'] else 'nobody'} writes it up")
    print(f"  renders {RENDERS}  (newest also at {LATEST})")
    if httpd.save is None:
        print("  world   no world found - GET /api/world will 404 and the map falls back "
              "to a stand-in; pass --save or set FIREKEEP_SAVE")
    else:
        print(f"  world   {httpd.save}  ->  GET /api/world, /api/world/map.png")
    if args.watch or args.watch_dir:
        for d in dirs:
            print(f"  watch   {d}")
    print("ctrl-c to stop\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
