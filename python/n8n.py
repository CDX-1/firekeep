"""
Everything this project sends *to* n8n, and the one place its URLs and keys live.

n8n no longer talks to Minecraft, and Minecraft no longer talks to n8n. The mod pushes its
events to this server, and this module forwards them on - so the webhook URL, the shared
secret and the retry policy are configured once, here, rather than in a Minecraft config
file that ships next to a world save.

    notify(payload)     hand one event to the workflow; returns immediately
    status()            what to show on /api/health

Delivery runs on a background thread with a bounded queue: a workflow that is down, slow, or
simply not deployed yet must never stall the mod's feed. If the queue fills, the oldest
event is dropped, because the newest report of a fire is the one worth having.

    FIREKEEP_N8N_BASE      https://smallwoken.app.n8n.cloud/webhook
    FIREKEEP_N8N_EVENTS    full URL, or a bare path under the base (default firekeep-events)
    FIREKEEP_N8N_KEY       sent as X-Firekeep-Key, if set
    FIREKEEP_N8N_WILDFIRE  the world-generation webhook (default minecraft-wildfire)
"""

import json
import os
import queue
import threading
import time
import urllib.error
import urllib.request

# The python.org builds on macOS have no wired-up root certificates, so an https webhook fails
# on trust before it fails on anything interesting. marble.py owns the one workaround.
from marble import SSL_CTX

DEFAULT_BASE = "https://smallwoken.app.n8n.cloud/webhook"
DEFAULT_EVENTS_PATH = "firekeep-events"
DEFAULT_WILDFIRE_PATH = "minecraft-wildfire"

AUTH_HEADER = "X-Firekeep-Key"
QUEUE_DEPTH = 256
MAX_ATTEMPTS = 3
#: After a failed delivery, stop trying for this long rather than hammering a dead endpoint.
QUIET_SECONDS = 10.0
TIMEOUT = 8.0

_OUTBOX = queue.Queue(maxsize=QUEUE_DEPTH)
_PUMP = None
_LOCK = threading.Lock()
_STATE = {"online": None, "error": None, "sent": 0, "dropped": 0, "quiet_until": 0.0}


def base():
    return (os.environ.get("FIREKEEP_N8N_BASE") or DEFAULT_BASE).rstrip("/")


def _url(env, default_path):
    """A full URL wins; anything else is treated as a path under the base."""
    configured = (os.environ.get(env) or "").strip()
    if configured.startswith(("http://", "https://")):
        return configured
    return f"{base()}/{(configured or default_path).lstrip('/')}"


def events_url():
    """Where mod events go. Blank disables forwarding entirely."""
    if (os.environ.get("FIREKEEP_N8N_EVENTS") or "").strip().lower() in ("off", "none", "-"):
        return ""
    return _url("FIREKEEP_N8N_EVENTS", DEFAULT_EVENTS_PATH)


def wildfire_url():
    """Where a screenshot goes to be turned into a world."""
    return _url("FIREKEEP_N8N_WILDFIRE", DEFAULT_WILDFIRE_PATH)


def key():
    return (os.environ.get("FIREKEEP_N8N_KEY") or "").strip()


def status():
    with _LOCK:
        return {"events_url": events_url(), "wildfire_url": wildfire_url(),
                "keyed": bool(key()), "online": _STATE["online"], "error": _STATE["error"],
                "sent": _STATE["sent"], "dropped": _STATE["dropped"],
                "queued": _OUTBOX.qsize()}


def start():
    """Starts the delivery thread. Safe to call twice; the second call does nothing."""
    global _PUMP
    with _LOCK:
        if _PUMP is not None and _PUMP.is_alive():
            return
        _PUMP = threading.Thread(target=_run, name="n8n-outbox", daemon=True)
        _PUMP.start()


def notify(payload):
    """
    Queues one event for the workflow. Never blocks, never raises.

    :return: True if it was queued, False if forwarding is off or the queue shed it
    """
    if not events_url():
        print("[n8n] event forwarding is disabled", flush=True)
        return False
    start()
    body = json.dumps(payload).encode()
    while True:
        try:
            _OUTBOX.put_nowait(body)
            print("[n8n] queued event "
                  f"id={payload.get('id', '-')} type={payload.get('event') or payload.get('type') or '-'} "
                  f"agent={payload.get('drone_id') or payload.get('agent_id') or '-'}", flush=True)
            return True
        except queue.Full:
            try:
                _OUTBOX.get_nowait()
                with _LOCK:
                    _STATE["dropped"] += 1
            except queue.Empty:
                return False


def _run():
    while True:
        body = _OUTBOX.get()
        if time.monotonic() < _STATE["quiet_until"]:
            continue                          # still backing off; this one is not worth waiting for
        _deliver(body)


def _deliver(body):
    url = events_url()
    if not url:
        return
    headers = {"Content-Type": "application/json", "User-Agent": "firekeep-hub"}
    if key():
        headers[AUTH_HEADER] = key()

    error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            request = urllib.request.Request(url, method="POST", data=body, headers=headers)
            with urllib.request.urlopen(request, timeout=TIMEOUT, context=SSL_CTX) as response:
                response.read()
            with _LOCK:
                if _STATE["online"] is not True:
                    print(f"n8n webhook reachable at {url}")
                _STATE.update(online=True, error=None, quiet_until=0.0)
                _STATE["sent"] += 1
            print(f"[n8n] delivered event ({len(body)} bytes) -> HTTP {response.status}", flush=True)
            return
        except urllib.error.HTTPError as e:
            error = f"HTTP {e.code}"
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            error = str(getattr(e, "reason", e))
        time.sleep(0.25 * attempt)

    with _LOCK:
        if _STATE["online"] is not False:
            print(f"! n8n webhook unreachable ({error}); pausing {QUIET_SECONDS:.0f}s")
        _STATE.update(online=False, error=error, quiet_until=time.monotonic() + QUIET_SECONDS)
