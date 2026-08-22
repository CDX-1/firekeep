"""
The one way out of this process and into Minecraft.

The mod keeps an HTTP control API on loopback (`DroneApiServer`, :8090 by default). It is
not exposed to anything: it has no idea who n8n is, it holds no credentials for the outside
world, and it is bound to 127.0.0.1. This module is the only caller.

    health()                     is the mod up, and how many drones does it have
    world()                      time of day, weather, the loaded dimensions
    roster() / drone(id)         who is flying
    spawn(...) / remove(id)      add or retire one
    perception(id, fresh=True)   what that drone can see right now
    command(id, body, wait=)     order it about; wait=True blocks for the outcome
    command_status(id)           what it is doing and how the last order ended
    dispatch(body)               let the mod pick the nearest free drone
    events(limit)                the mod's own event ring, as a fallback

Everything raises MinecraftError, carrying the status the caller should pass on, so a
handler in server.py can forward a 404 as a 404 rather than turning it into a 500.

Where the mod is, and the key it wants:

    FIREKEEP_MINECRAFT   http://127.0.0.1:8090
    DRONE_API_KEY        the bearer token from config/firekeep-drones.json
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_URL = "http://127.0.0.1:8090"
DEFAULT_TIMEOUT = 10.0
#: `?wait=true` blocks until the drone finishes, which is a flight, not a request.
LONG_TIMEOUT = 120.0


class MinecraftError(RuntimeError):
    """A call into the mod that did not work. `status` is what to tell our own caller."""

    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def base_url():
    """Where the mod's control API is. Read every call so a restart can move it."""
    return (os.environ.get("FIREKEEP_MINECRAFT") or DEFAULT_URL).rstrip("/")


def api_key():
    return (os.environ.get("DRONE_API_KEY") or "").strip()


def configured():
    """Cheap description of the link, for /api/health."""
    return {"url": base_url(), "keyed": bool(api_key())}


def request(method, path, body=None, *, query=None, timeout=DEFAULT_TIMEOUT):
    """
    One call into the mod. `path` is relative to /api, `body` is a dict or None.

    :raises MinecraftError: if the mod is unreachable, refuses, or answers with something
        that is not JSON
    """
    url = f"{base_url()}/api{path}"
    if query:
        clean = {k: v for k, v in query.items() if v is not None}
        if clean:
            url += "?" + urllib.parse.urlencode(clean)

    headers = {"Accept": "application/json"}
    key = api_key()
    if key:
        headers["Authorization"] = f"Bearer {key}"

    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as e:
        raw = e.read()
        # The mod's errors are already JSON and already say something useful; pass the
        # message and the status straight through rather than inventing our own.
        try:
            payload = json.loads(raw)
            message = payload.get("error") or payload.get("message") or f"HTTP {e.code}"
        except (json.JSONDecodeError, AttributeError):
            message = raw.decode(errors="replace")[:300] or f"HTTP {e.code}"
        raise MinecraftError(message, e.code)
    except urllib.error.URLError as e:
        raise MinecraftError(f"Minecraft is not reachable at {base_url()} ({e.reason})", 503)
    except TimeoutError:
        raise MinecraftError(f"Minecraft did not answer within {timeout:.0f}s", 504)

    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise MinecraftError(f"{method} {path} did not return JSON", 502)


# -------------------------------------------------------------------------- reads

def health(timeout=3.0):
    return request("GET", "/health", timeout=timeout)


def online(timeout=2.0):
    """True if the mod answers at all. Never raises - this is for a status panel."""
    try:
        return bool(health(timeout=timeout).get("ok"))
    except MinecraftError:
        return False


def world():
    return request("GET", "/world")


def roster():
    return request("GET", "/drones")


def drone(drone_id):
    return request("GET", f"/drones/{urllib.parse.quote(str(drone_id))}")


def perception(drone_id, fresh=True):
    return request("GET", f"/drones/{urllib.parse.quote(str(drone_id))}/perception",
                   query={"fresh": "true" if fresh else None})


def command_status(drone_id):
    return request("GET", f"/drones/{urllib.parse.quote(str(drone_id))}/command")


def events(limit=50):
    return request("GET", "/events", query={"limit": limit})


# -------------------------------------------------------------------------- writes

def spawn(body):
    return request("POST", "/drones", body)


def remove(drone_id):
    return request("DELETE", f"/drones/{urllib.parse.quote(str(drone_id))}")


def command(drone_id, body, wait=False):
    """
    Sends one high-level order.

    `wait` turns this into a blocking call that returns the outcome - which is what a
    workflow that wants to reason about the result needs, and why the timeout is a flight's
    worth of time rather than a request's.
    """
    return request("POST", f"/drones/{urllib.parse.quote(str(drone_id))}/command", body,
                   query={"wait": "true" if wait else None},
                   timeout=LONG_TIMEOUT if wait else DEFAULT_TIMEOUT)


def dispatch(body):
    return request("POST", "/dispatch", body)
