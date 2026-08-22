"""Client for the n8n `minecraft-wildfire` webhook.

Same job as marble.py - screenshot in, generated world out - but the work
happens in somebody else's workflow: n8n captions the screenshot, writes the
prompt itself, and calls World Labs with its own credentials. So there is no
API key on this side, no prompt to pass, and nothing billed to the key in
.env.

    POST <BASE>                     multipart, field `data` = the image
      -> {success, operation_id, status_url, generated_prompt}

    GET  <status_url>               (already carries ?operation_id=)
      -> {status, succeeded, failed, error, world_url, assets}

Everything raises WildfireError, so a long-running server survives a bad
request the same way it does with Marble.
"""

import json
import mimetypes
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from time import monotonic, sleep

import n8n
from marble import SSL_CTX, download

#: Kept as a module attribute so callers can print it, but n8n.py owns the value - every
#: URL this project has for n8n is configured in one place.
BASE = n8n.wildfire_url()

# n8n holds the World Labs key, so a wildfire job costs this project nothing
CREDITS = 0

# the terminal states the workflow reports, upper-cased before comparison
DONE = {"SUCCEEDED", "SUCCESS", "COMPLETED", "DONE"}
FAILED = {"FAILED", "ERROR", "CANCELLED", "CANCELED"}

# rough progress for each state, so the dashboard bar moves before the pano lands
PROGRESS = {"QUEUED": 5, "PENDING": 5, "STARTING": 10, "RUNNING": 40,
            "PROCESSING": 40, "GENERATING": 60, "UPLOADING": 90}


class WildfireError(RuntimeError):
    pass


def multipart(field, filename, data, content_type=None):
    """Encode one file as multipart/form-data. Returns (body, content_type)."""
    boundary = uuid.uuid4().hex
    ctype = content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    body = b"".join([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'.encode(),
        f"Content-Type: {ctype}\r\n\r\n".encode(),
        data,
        f"\r\n--{boundary}--\r\n".encode(),
    ])
    return body, f"multipart/form-data; boundary={boundary}"


def request(method, url, *, body=None, content_type=None, timeout=60):
    req = urllib.request.Request(url, method=method, data=body,
                                 headers={"Content-Type": content_type} if content_type else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        raise WildfireError(f"{method} {url} -> {e.code}: {e.read().decode(errors='replace')[:300]}")
    except urllib.error.URLError as e:
        raise WildfireError(f"cannot reach {url}: {e.reason}")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise WildfireError(f"{method} {url} did not return JSON: {raw.decode(errors='replace')[:200]}")


def message(payload):
    """n8n reports errors as either a string or {stage, message}; flatten both."""
    error = payload.get("error") or payload.get("message")
    if isinstance(error, dict):
        stage = error.get("stage")
        text = error.get("message") or json.dumps(error)
        return f"{stage}: {text}" if stage else text
    return str(error) if error else "no reason given"


def start(image_bytes, extension=".png", *, base=None, timeout=180):
    """Hand the workflow a screenshot. Returns {operation_id, status_url, prompt}."""
    base = base or n8n.wildfire_url()
    body, ctype = multipart("data", f"source{extension}", image_bytes)
    payload = request("POST", base, body=body, content_type=ctype, timeout=timeout)

    if not payload.get("success") or not payload.get("operation_id"):
        raise WildfireError(f"start failed: {message(payload)}")

    # the workflow returns an absolute status_url, but keep working if it ever
    # hands back a bare path
    status_url = urllib.parse.urljoin(base, payload.get("status_url") or "")
    if not status_url:
        raise WildfireError("start returned no status_url")

    return {"operation_id": payload["operation_id"],
            "status_url": status_url,
            "prompt": payload.get("generated_prompt") or ""}


def status(status_url, timeout=60):
    payload = request("GET", status_url, timeout=timeout)
    # a stage failure comes back as success:false rather than as a status
    if payload.get("success") is False and not payload.get("failed"):
        raise WildfireError(message(payload))
    return payload


def state(payload):
    return str(payload.get("status") or "").upper()


def wait(status_url, on_progress=None, timeout=1800, interval=15):
    """Poll to completion and return the finished payload (world_url + assets)."""
    deadline = monotonic() + timeout
    while monotonic() < deadline:
        payload = status(status_url)
        now = state(payload)

        if payload.get("succeeded") or now in DONE:
            return payload
        if payload.get("failed") or now in FAILED:
            raise WildfireError(f"generation failed: {message(payload)}")

        if on_progress:
            on_progress(payload.get("progress_percent") or PROGRESS.get(now))
        sleep(interval)
    raise WildfireError("timed out waiting for the world")


def image_urls(payload):
    """Every image the workflow handed back, as {name: url}, best first.

    The workflow is a wrapper around World Labs, so `assets` usually arrives in
    Marble's shape - but it is somebody else's JSON, so anything that merely
    looks like an image URL is picked up too rather than silently dropped.
    """
    assets = payload.get("assets")
    assets = assets if isinstance(assets, dict) else {}
    imagery = assets.get("imagery") if isinstance(assets.get("imagery"), dict) else {}
    found = {}

    if pano := imagery.get("pano_url"):
        found["pano"] = pano
    if thumb := assets.get("thumbnail_url"):
        found["preview"] = thumb
    if found:
        return found

    # some other shape - go looking, and make sure the first image found is one
    # publish_result knows to reach for
    for key, value in flatten(assets):
        if isinstance(value, str) and value.startswith(("http://", "https://")):
            name = "pano" if "pano" in key else key if found else "preview"
            found.setdefault(name, value)
    return found


def flatten(obj, prefix=""):
    """Depth-first (key, value) pairs, with nested keys joined by `_`."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from flatten(v, f"{prefix}_{k}".strip("_").lower())
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from flatten(v, f"{prefix}_{i}".strip("_").lower())
    else:
        yield prefix, obj


def save_assets(payload, out_dir):
    """Pull the returned images into out_dir. Returns what landed, by name."""
    out_dir = Path(out_dir)
    saved = {}
    for name, url in image_urls(payload).items():
        suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
        if suffix not in (".png", ".jpg", ".jpeg", ".webp"):
            suffix = ".png" if name == "pano" else ".jpg"
        try:
            saved[name] = download(url, out_dir / f"{name}{suffix}").name
        except (urllib.error.URLError, OSError) as e:
            print(f"! could not download {name}: {e}")
    return saved
