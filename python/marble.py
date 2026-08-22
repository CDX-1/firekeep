"""Thin client for the World Labs Marble API.

Shared by the one-shot CLI (main.py) and the capture server (server.py).
Everything here raises MarbleError instead of exiting, so a long-running
server can survive a bad request.
"""

import base64
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.worldlabs.ai/marble/v1"
HERE = Path(__file__).resolve().parent

# python.org builds on macOS ship without wired-up root certs; certifi has them.
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

# credits per world generation, before the pano step (80 for a non-pano image,
# 0 if the input already is an equirectangular panorama)
MODELS = {
    "marble-1.0-draft": 150,
    "marble-1.0": 1500,
    "marble-1.1": 1500,
    "marble-1.1-plus": 1500,
}
PANO_STEP = 80

# The layout has to survive; the art style must not. Saying "keep the
# composition" without saying "drop the voxels" gets you smoother Minecraft.
DEFAULT_PROMPT = (
    "Transform this Minecraft scene into a photorealistic 3D environment. "
    "Preserve the exact terrain layout and the relative positions of trees, roads, "
    "structures, hills, water, fire and other major objects. "
    "Replace Minecraft's block-based geometry, textures and proportions with "
    "realistic natural-world geometry and materials: individual leaves and branches "
    "instead of leaf cubes, real bark, rock, soil and stone instead of tiled block "
    "faces, believable human-scale proportions instead of one-metre cubes. "
    "Make the vegetation, terrain, structures, lighting, smoke and fire physically "
    "realistic, with natural light falloff, soft shadows and atmospheric depth. "
    "Do not preserve the Minecraft visual style - no visible blocks, voxels, "
    "pixelated textures or hard cubic edges anywhere in the scene."
)


class MarbleError(RuntimeError):
    pass


def load_env(path=None):
    """Read KEY=value lines out of a local .env into os.environ."""
    f = Path(path) if path else HERE / ".env"
    if not f.is_file():
        return
    for line in f.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("\"'"))


def api_key():
    load_env()
    key = os.environ.get("WORLDLABS_API_KEY")
    if not key:
        raise MarbleError("WORLDLABS_API_KEY not set (put it in .env)")
    return key


def call(method, path, key, body=None, timeout=60):
    req = urllib.request.Request(
        f"{API}{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"WLT-Api-Key": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise MarbleError(f"{method} {path} -> {e.code}: {e.read().decode()[:300]}")
    except urllib.error.URLError as e:
        raise MarbleError(f"cannot reach {API}: {e.reason}")


def credits(key):
    return call("GET", "/credits", key).get("remaining_credits")


def generate(image_bytes, extension, prompt, model, key, display_name="", is_pano=False):
    """Start a generation from raw image bytes. Returns an operation id."""
    if model not in MODELS:
        raise MarbleError(f"unknown model {model!r} (pick one of {', '.join(MODELS)})")
    payload = {
        "display_name": display_name[:64],
        "model": model,
        # the viewer fetches assets directly, so the world must be readable
        "permission": {"public": True},
        "world_prompt": {
            "type": "image",
            "image_prompt": {
                "source": "data_base64",
                "data_base64": base64.b64encode(image_bytes).decode(),
                "extension": extension.lstrip(".").lower(),
            },
            "text_prompt": prompt,
            "is_pano": True if is_pano else "auto",
        },
    }
    return call("POST", "/worlds:generate", key, payload, timeout=180)["operation_id"]


def wait(op_id, key, on_progress=None, timeout=1800, interval=10):
    """Poll an operation to completion and return the finished world."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        op = call("GET", f"/operations/{op_id}", key)
        if op.get("done"):
            if op.get("error"):
                raise MarbleError(f"generation failed: {op['error']}")
            world = op.get("response") or {}
            # assets attach slightly after the operation resolves - the pano in
            # particular is still null there, so re-read for the full set
            return get_world(world["world_id"], key)
        if on_progress:
            on_progress((op.get("metadata") or {}).get("progress_percent"))
        time.sleep(interval)
    raise MarbleError("timed out waiting for the world")


def get_world(world_id, key):
    return call("GET", f"/worlds/{world_id}", key)


def download(url, dest):
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=300, context=SSL_CTX) as r:
        dest.write_bytes(r.read())
    return dest


def save_assets(world, out_dir):
    """Pull the thumbnail and the 360 pano into out_dir. Returns what landed."""
    out_dir = Path(out_dir)
    assets = world.get("assets") or {}
    saved = {}
    if thumb := assets.get("thumbnail_url"):
        saved["preview"] = download(thumb, out_dir / "preview.jpg").name
    # the pano is the sharpest 2D output the API produces
    if pano := (assets.get("imagery") or {}).get("pano_url"):
        saved["pano"] = download(pano, out_dir / "pano.png").name
    return saved
