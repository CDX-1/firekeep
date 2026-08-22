#!/usr/bin/env python3
"""
Capture server: waits for Minecraft to hand it a screenshot, turns it into a
world, serves the results.

    python3 server.py                  # listen on 127.0.0.1:8000
    python3 server.py --watch          # also auto-submit new screenshots

The mod POSTs raw PNG bytes:

    POST /capture            body: image bytes
                             optional: ?model=&prompt=&pano=1
      -> 202 {"job_id": "...", "status": "queued"}

    GET  /api/jobs           every job, newest first
    GET  /api/jobs/<id>      one job, including the full world payload
    GET  /api/health         {ok, credits, queued, busy}
    GET  /jobs/<id>/pano.png source.png, preview.jpg, job.json
    GET  /latest.png         the most recent finished render
    GET  /                   the viewer

Every finished job also drops a plain PNG in out/renders/, and copies it to
out/latest.png, so there is always one obvious file to look at.
"""

import argparse
import json
import queue
import shutil
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import marble

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
JOBS = OUT / "jobs"
RENDERS = OUT / "renders"        # every finished render, flat and easy to open
LATEST = OUT / "latest.png"      # ...and the newest one, always at the same path

MAX_UPLOAD = 32 * 1024 * 1024          # 32 MB is far above any screenshot
JOBS_LOCK = threading.Lock()
JOBS_BY_ID = {}                         # id -> dict
WORK = queue.Queue()

# auto-triggered generation should be cheap by default; override with --model
DEFAULT_MODEL = "marble-1.0-draft"


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


def submit(image_bytes, extension, *, model, prompt, is_pano, source):
    job_id = uuid.uuid4().hex[:12]
    d = job_dir(job_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / f"source{extension}").write_bytes(image_bytes)

    job = {
        "id": job_id,
        "status": "queued",
        "created": now(),
        "updated": now(),
        "model": model,
        "prompt": prompt,
        "is_pano": is_pano,
        "source": source,
        "source_file": f"source{extension}",
        "bytes": len(image_bytes),
        "estimated_credits": marble.MODELS[model] + (0 if is_pano else marble.PANO_STEP),
        "progress": None,
        "world_id": None,
        "marble_url": None,
        "assets": {},
        "result_png": None,
        "error": None,
    }
    with JOBS_LOCK:
        JOBS_BY_ID[job_id] = job
    save_job(job)
    WORK.put(job_id)
    print(f"[{job_id}] queued  <- {source} ({len(image_bytes)/1e6:.1f} MB, {model})")
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
    if key is None:                                  # --dry-run
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


# --------------------------------------------------------------------------
# screenshot folder watcher

def watch_dirs(dirs, model, prompt, interval=2.0):
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
                           is_pano=False, source=f"watch:{p.name}")
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
# http

class Handler(BaseHTTPRequestHandler):
    server_version = "firekeep"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        pass

    def send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, indent=2).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, body, ctype, status=HTTPStatus.OK):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -- POST /capture ------------------------------------------------------
    def do_POST(self):
        url = urlparse(self.path)
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
        model = one("model", self.server.model)
        if model not in marble.MODELS:
            return self.send_json({"error": f"unknown model {model}",
                                   "models": list(marble.MODELS)}, HTTPStatus.BAD_REQUEST)

        job = submit(
            data, ".png" if data.startswith(b"\x89PNG") else ".jpg",
            model=model,
            prompt=one("prompt", self.server.prompt),
            is_pano=one("pano", "") in ("1", "true", "yes"),
            source=one("source", self.headers.get("X-Source", "post")),
        )
        self.send_json({"job_id": job["id"], "status": job["status"],
                        "estimated_credits": job["estimated_credits"],
                        "url": f"/api/jobs/{job['id']}"}, HTTPStatus.ACCEPTED)

    # -- GET ----------------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/api/health":
            try:
                bal = 0 if self.server.key is None else marble.credits(self.server.key)
            except marble.MarbleError as e:
                bal = f"unavailable: {e}"
            with JOBS_LOCK:
                busy = sum(1 for j in JOBS_BY_ID.values() if j["status"] == "generating")
            return self.send_json({"ok": True, "credits": bal,
                                   "queued": WORK.qsize(), "busy": busy,
                                   "model": self.server.model,
                                   "dry_run": self.server.key is None})

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

        if path == "/latest.png":
            if not LATEST.is_file():
                return self.send_json({"error": "nothing rendered yet"}, HTTPStatus.NOT_FOUND)
            return self.send_bytes(LATEST.read_bytes(), "image/png")

        if path in ("/", "/index.html"):
            viewer = HERE / "viewer.html"
            if not viewer.is_file():
                return self.send_json({"error": "viewer.html missing"}, HTTPStatus.NOT_FOUND)
            return self.send_bytes(viewer.read_bytes(), "text/html; charset=utf-8")

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
                    help=f"default model for incoming captures (default: {DEFAULT_MODEL})")
    ap.add_argument("--prompt", default=marble.DEFAULT_PROMPT)
    ap.add_argument("--watch", action="store_true",
                    help="also auto-submit new Minecraft screenshots as they appear")
    ap.add_argument("--watch-dir", type=Path, action="append", default=[],
                    metavar="DIR", help="extra folder to watch (repeatable)")
    ap.add_argument("--dry-run", action="store_true",
                    help="accept captures but never call the API - for wiring up the mod")
    ap.add_argument("--workers", type=int, default=1, help="concurrent generations")
    args = ap.parse_args()

    # keep logs live when stdout is a file or a pipe
    sys.stdout.reconfigure(line_buffering=True)

    key = None if args.dry_run else marble.api_key()
    JOBS.mkdir(parents=True, exist_ok=True)
    load_jobs()

    for _ in range(max(1, args.workers)):
        threading.Thread(target=worker, args=(key,), daemon=True).start()

    if args.watch or args.watch_dir:
        dirs = ([d for d in args.watch_dir if d.is_dir()]
                + (screenshot_dirs() if args.watch else []))
        if not dirs:
            print("! --watch: no screenshot folders found")
        else:
            threading.Thread(target=watch_dirs, args=(dirs, args.model, args.prompt),
                             daemon=True).start()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.key, httpd.model, httpd.prompt = key, args.model, args.prompt

    print(f"\nfirekeep capture server  http://{args.host}:{args.port}")
    if key is None:
        print("  DRY RUN - captures are accepted but nothing is generated")
    else:
        print(f"  model   {args.model} (~{marble.MODELS[args.model] + marble.PANO_STEP} credits/capture)")
        print(f"  credits {marble.credits(key):.0f}")
    print(f"  POST    http://{args.host}:{args.port}/capture  (raw PNG body)")
    print(f"  renders {RENDERS}  (newest also at {LATEST})")
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
