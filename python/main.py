#!/usr/bin/env python3
"""
One-shot: turn a Minecraft screenshot into a world, without running the server.

    python3 main.py                        # newest screenshot found
    python3 main.py --shot foo.png --model marble-1.1
    python3 main.py --list                 # what screenshots it can see

Writes into out/jobs/<id>/, the same place server.py does, so the viewer
picks it up either way. For a server that waits on Minecraft, see server.py.
"""

import argparse
import json
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import marble
import server

OUT = marble.HERE / "out"


def find_screenshots():
    """Every Minecraft screenshot we can find, newest first."""
    shots = []
    for d in server.screenshot_dirs():
        shots += [p for p in d.iterdir() if p.suffix.lower() in (".png", ".jpg")]
    return sorted(shots, key=lambda p: p.stat().st_mtime, reverse=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--shot", type=Path, help="screenshot to use (default: newest)")
    ap.add_argument("--prompt", default=marble.DEFAULT_PROMPT)
    ap.add_argument("--model", default="marble-1.1", choices=list(marble.MODELS))
    ap.add_argument("--pano", action="store_true",
                    help="the input is already an equirectangular panorama (skips the 80-credit pano step)")
    ap.add_argument("--list", action="store_true", help="list screenshots and exit")
    args = ap.parse_args()

    if args.list:
        for p in find_screenshots()[:20]:
            print(p)
        return

    shot = args.shot
    if shot is None:
        found = find_screenshots()
        if not found:
            sys.exit("! no Minecraft screenshots found - pass one with --shot")
        shot = found[0]
    if not shot.is_file():
        sys.exit(f"! no such file: {shot}")

    try:
        key = marble.api_key()
        cost = marble.MODELS[args.model] + (0 if args.pano else marble.PANO_STEP)
        print(f"screenshot : {shot.name} ({shot.stat().st_size/1e6:.1f} MB)")
        print(f"model      : {args.model}  (~{cost} credits, {marble.credits(key):.0f} left)")

        job_id = uuid.uuid4().hex[:12]
        d = OUT / "jobs" / job_id
        d.mkdir(parents=True, exist_ok=True)
        ext = shot.suffix.lower()
        (d / f"source{ext}").write_bytes(shot.read_bytes())

        t0 = time.time()
        op = marble.generate(shot.read_bytes(), ext, args.prompt, args.model, key,
                             display_name=f"minecraft {shot.stem}", is_pano=args.pano)
        print(f"operation  : {op}\ngenerating...")

        world = marble.wait(op, key, on_progress=lambda p: print(f"  ... {p or '?'}%", flush=True))
        saved = marble.save_assets(world, d)
        (d / "world.json").write_text(json.dumps(world, indent=2))

        job = {
            "id": job_id, "status": "done", "model": args.model, "prompt": args.prompt,
            "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "is_pano": args.pano, "source": f"cli:{shot.name}", "source_file": f"source{ext}",
            "bytes": shot.stat().st_size, "estimated_credits": cost, "progress": 100,
            "world_id": world.get("world_id"), "marble_url": world.get("world_marble_url"),
            "assets": saved, "caption": (world.get("assets") or {}).get("caption"),
            "error": None, "took_seconds": round(time.time() - t0, 1),
        }
        (d / "job.json").write_text(json.dumps(job, indent=2))

        print(f"\ndone in {time.time()-t0:.0f}s -> {world.get('world_marble_url')}")
        for k, v in saved.items():
            print(f"{k:8} -> {d / v}")
        print("\nview it:  python3 server.py")
    except marble.MarbleError as e:
        sys.exit(f"! {e}")


if __name__ == "__main__":
    main()
