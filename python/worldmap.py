#!/usr/bin/env python3
"""
Renders a real Minecraft world as a top-down map, straight off the save on disk.

No mod and no running game are involved: this reads the Anvil region files the
same way the game does, takes the surface block of every column, and paints it
with vanilla's own map palette and north-facing relief shading. Ungenerated
chunks stay transparent so the dashboard can tell "nothing there" from "black
block there".

    python3 worldmap.py ../fabric/run/world -o map.png        # a dedicated server
    python3 worldmap.py ../fabric/run/saves/"New World" -o map.png
"""

import argparse
import os
import struct
import time
import zlib
from pathlib import Path

import mapcolors
import nbt

SECTION = 16
CHUNK = 16
REGION_CHUNKS = 32
REGION = REGION_CHUNKS * CHUNK           # 512 blocks square
SECTOR = 4096

# vanilla MapColor.Brightness, as multipliers
LOWEST, LOW, NORMAL, HIGH = 135, 180, 220, 255

# heightmaps we need: the surface (what you see) and the floor under any water
SURFACE = "WORLD_SURFACE"
OCEAN_FLOOR = "OCEAN_FLOOR"

WATER = {"minecraft:water", "minecraft:flowing_water", "minecraft:bubble_column"}


class WorldError(Exception):
    pass


# --------------------------------------------------------------------------
# save layout

SAVE_ENV = "FIREKEEP_SAVE"


def server_world(run):
    """
    The world a dedicated server in `run` writes, taken from its level-name.

    A server keeps its one world at run/<level-name>, not under run/saves - so looking
    only in the singleplayer place finds nothing when the drones are on a server.
    """
    name = "world"
    try:
        for line in (run / "server.properties").read_text(encoding="utf-8",
                                                          errors="replace").splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and key.strip() == "level-name" and value.strip():
                name = value.strip()
                break
    except OSError:
        pass
    return run / name


def default_saves():
    """Every world this checkout might be serving, the server's own first."""
    run = Path(__file__).resolve().parent.parent / "fabric" / "run"
    found = []

    world = server_world(run)
    if (world / "level.dat").is_file():
        found.append(world)

    saves = run / "saves"
    if saves.is_dir():
        found.extend(sorted((d for d in saves.iterdir() if (d / "level.dat").is_file()),
                            key=lambda d: d.stat().st_mtime, reverse=True))
    return found


def find_save(*hints):
    """
    First readable save among the hints, $FIREKEEP_SAVE, or this checkout's run dir.

    Both layouts turn up in development: a dedicated server's run/<level-name>, and a
    singleplayer client's run/saves/<name>.
    """
    candidates = [Path(h) for h in hints if h]
    if not candidates:
        env = os.environ.get(SAVE_ENV)
        candidates = [Path(env)] if env else default_saves()
    for c in candidates:
        if (c / "level.dat").is_file():
            return c
    return None


def region_dir(save, dimension="overworld"):
    """Both save layouts: dimensions/<ns>/<dim>/region, and the flat overworld one."""
    for candidate in (save / "dimensions" / "minecraft" / dimension / "region",
                      save / "region" if dimension == "overworld" else None,
                      save / "DIM-1" / "region" if dimension == "the_nether" else None,
                      save / "DIM1" / "region" if dimension == "the_end" else None):
        if candidate is not None and candidate.is_dir():
            return candidate
    raise WorldError(f"no region files for {dimension} in {save}")


def level_info(save):
    """Name and spawn point out of level.dat, best effort."""
    info = {"name": save.name, "spawn": None}
    try:
        data = nbt.parse((save / "level.dat").read_bytes()).get("Data", {})
    except (OSError, ValueError):
        return info

    info["name"] = data.get("LevelName", save.name)
    spawn = data.get("spawn")
    if isinstance(spawn, dict) and isinstance(spawn.get("pos"), list):   # 26.2+
        x, y, z = (list(spawn["pos"]) + [0, 0, 0])[:3]
        info["spawn"] = {"x": x, "y": y, "z": z}
    elif "SpawnX" in data:                                               # older saves
        info["spawn"] = {"x": data["SpawnX"], "y": data.get("SpawnY", 64), "z": data["SpawnZ"]}
    return info


# --------------------------------------------------------------------------
# region files

def region_coords(path):
    """r.<x>.<z>.mca -> (x, z), or None if the name is not one of ours."""
    parts = path.name.split(".")
    if len(parts) != 4 or parts[0] != "r" or parts[3] != "mca":
        return None
    try:
        return int(parts[1]), int(parts[2])
    except ValueError:
        return None


def read_chunks(path):
    """Yields (chunk_x, chunk_z, nbt) for every stored chunk in one region file."""
    raw = path.read_bytes()
    if len(raw) < 2 * SECTOR:
        return

    origin = region_coords(path)
    if origin is None:
        return
    region_x, region_z = origin

    for index in range(REGION_CHUNKS * REGION_CHUNKS):
        entry = struct.unpack_from(">I", raw, index * 4)[0]
        offset, sectors = entry >> 8, entry & 0xFF
        if offset == 0 or sectors == 0:
            continue

        start = offset * SECTOR
        if start + 5 > len(raw):
            continue
        length, compression = struct.unpack_from(">IB", raw, start)
        body = raw[start + 5:start + 4 + length]
        if not body:
            continue

        try:
            if compression == 1:
                chunk = nbt.parse(b"\x1f\x8b" + body[2:]) if body[:2] != b"\x1f\x8b" else nbt.parse(body)
            elif compression == 3:
                chunk = nbt.parse(body)
            else:                                    # 2 (zlib) is what the game writes
                chunk = nbt.parse(zlib.decompress(body))
        except (ValueError, zlib.error, struct.error, IndexError):
            continue

        yield (region_x * REGION_CHUNKS + index % REGION_CHUNKS,
               region_z * REGION_CHUNKS + index // REGION_CHUNKS,
               chunk)


def unpack(longs, bits, count):
    """Un-packs MC's bit-packed longs. Entries never straddle a long since 1.16."""
    if bits <= 0 or not longs:
        return [0] * count
    per_long = 64 // bits
    mask = (1 << bits) - 1
    out = []
    for word in longs:
        word &= 0xFFFFFFFFFFFFFFFF                   # NBT longs arrive signed
        for slot in range(per_long):
            out.append((word >> (slot * bits)) & mask)
            if len(out) == count:
                return out
    out.extend([0] * (count - len(out)))
    return out


def heightmap(chunk, which, min_y):
    """256 world-Y values for `which`, or None when the chunk never stored it."""
    packed = chunk.get("Heightmaps", {}).get(which)
    if not packed:
        return None
    # stored as "one above the highest matching block", relative to the world floor
    return [min_y + v - 1 for v in unpack(packed, 9, CHUNK * CHUNK)]


def section_lookup(chunk):
    """(min_y, {section_y: (palette, indices or None)}) for one chunk."""
    sections = {}
    min_y = chunk.get("yPos", -4) * SECTION
    for section in chunk.get("sections", []):
        states = section.get("block_states")
        if not isinstance(states, dict):
            continue
        palette = [entry.get("Name", "minecraft:air") for entry in states.get("palette", [])
                   if isinstance(entry, dict)]
        if not palette:
            continue
        data = states.get("data")
        if data is None:                              # single-block section
            sections[section.get("Y", 0)] = (palette, None)
            continue
        bits = max(4, (len(palette) - 1).bit_length())
        sections[section.get("Y", 0)] = (palette, unpack(data, bits, SECTION ** 3))
    return min_y, sections


def paintable(sections, x, y, z, min_y):
    """
    Walks down to the first block in the column that a map would actually draw.

    WORLD_SURFACE stops at anything that is not air, glass and barriers included, and those
    have no map colour - taking them at face value paints a glass roof solid black. Vanilla
    skips them, so this does too.

    @return (block name, its y)
    """
    while y >= min_y:
        name = block_at(sections, x, y, z)
        if mapcolors.color(name) != mapcolors.BASE["none"]:
            return name, y
        y -= 1
    return "minecraft:air", min_y


def block_at(sections, x, y, z):
    """Block id at chunk-local x/z and world y, or air where nothing is stored."""
    entry = sections.get(y >> 4)
    if entry is None:
        return "minecraft:air"
    palette, indices = entry
    if indices is None:
        return palette[0]
    return palette[indices[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)]]


# --------------------------------------------------------------------------
# rendering

def _shade(rgb, brightness):
    return (((rgb >> 16) & 0xFF) * brightness // 255,
            ((rgb >> 8) & 0xFF) * brightness // 255,
            (rgb & 0xFF) * brightness // 255)


def encode_png(width, height, pixels):
    """Minimal RGBA PNG. `pixels` is one bytearray, 4 bytes per pixel, row-major."""
    stride = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)                                 # filter: none
        raw += pixels[y * stride:(y + 1) * stride]

    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + chunk(b"IEND", b""))


def render(save, dimension="overworld", limit=64):
    """
    Paints every generated chunk of `dimension` into one RGBA PNG.

    Returns (png_bytes, meta). `meta` carries the world-space origin and size,
    which is what lets the dashboard turn a pixel back into block coordinates.
    """
    started = time.monotonic()
    files = sorted((f for f in region_dir(save, dimension).glob("r.*.mca")
                    if f.stat().st_size > 2 * SECTOR and region_coords(f)),
                   key=lambda f: f.stat().st_size, reverse=True)[:limit]
    if not files:
        raise WorldError(f"{dimension} has no generated regions yet")

    coords = [region_coords(f) for f in files]
    region_x0, region_z0 = min(c[0] for c in coords), min(c[1] for c in coords)
    region_x1, region_z1 = max(c[0] for c in coords), max(c[1] for c in coords)
    width = (region_x1 - region_x0 + 1) * REGION
    height = (region_z1 - region_z0 + 1) * REGION
    origin_x, origin_z = region_x0 * REGION, region_z0 * REGION

    # first pass: surface colour + height for every column, so shading can look north
    colors = [0] * (width * height)
    heights = [None] * (width * height)
    depths = [0] * (width * height)
    chunks = 0

    for path in files:
        for chunk_x, chunk_z, chunk in read_chunks(path):
            if not str(chunk.get("Status", "")).endswith("full"):
                continue
            min_y, sections = section_lookup(chunk)
            if not sections:
                continue
            surface = heightmap(chunk, SURFACE, min_y)
            if surface is None:
                continue
            floor = heightmap(chunk, OCEAN_FLOOR, min_y) or surface

            base_x = chunk_x * CHUNK - origin_x
            base_z = chunk_z * CHUNK - origin_z
            if not (0 <= base_x < width and 0 <= base_z < height):
                continue
            chunks += 1

            for local_z in range(CHUNK):
                row = (base_z + local_z) * width + base_x
                for local_x in range(CHUNK):
                    top = surface[local_z * CHUNK + local_x]
                    name, top = paintable(sections, local_x, top, local_z, min_y)
                    if name in WATER:
                        bed = floor[local_z * CHUNK + local_x]
                        depths[row + local_x] = max(0, top - bed)
                        top = bed
                    colors[row + local_x] = mapcolors.color(name)
                    heights[row + local_x] = top

    if not chunks:
        raise WorldError(f"{dimension} has regions on disk but no finished chunks")

    # second pass: vanilla's relief shading, comparing each column to the one north of it
    pixels = bytearray(width * height * 4)
    min_x = min_z = 1 << 30
    max_x = max_z = -(1 << 30)

    for z in range(height):
        row = z * width
        north = row - width
        for x in range(width):
            i = row + x
            here = heights[i]
            if here is None:
                continue                              # ungenerated: leave transparent

            checker = (x + z) & 1
            depth = depths[i]
            if depth > 0:
                d = depth * 0.1 + checker * 0.2
                brightness = HIGH if d < 0.5 else (LOW if d > 0.9 else NORMAL)
            else:
                above = heights[north + x] if z > 0 else None
                delta = 0.0 if above is None else float(here - above)
                d = delta + (checker - 0.5) * 0.4
                brightness = HIGH if d > 0.6 else (LOW if d < -0.6 else NORMAL)

            r, g, b = _shade(colors[i], brightness)
            pixels[i * 4:i * 4 + 4] = bytes((r, g, b, 255))

            min_x, max_x = min(min_x, x), max(max_x, x)
            min_z, max_z = min(min_z, z), max(max_z, z)

    png, width, height, origin_x, origin_z = _crop(
        pixels, width, height, origin_x, origin_z, min_x, min_z, max_x, max_z)

    return png, {
        "dimension": dimension,
        "origin_x": origin_x,
        "origin_z": origin_z,
        "width": width,
        "height": height,
        "blocks_per_pixel": 1,
        "chunks": chunks,
        "regions": len(files),
        "took_seconds": round(time.monotonic() - started, 2),
    }


def _crop(pixels, width, height, origin_x, origin_z, min_x, min_z, max_x, max_z):
    """Trims the transparent border, so the map is only as big as the world is."""
    if min_x > max_x:
        return encode_png(width, height, pixels), width, height, origin_x, origin_z

    new_width = max_x - min_x + 1
    new_height = max_z - min_z + 1
    if new_width == width and new_height == height:
        return encode_png(width, height, pixels), width, height, origin_x, origin_z

    cropped = bytearray(new_width * new_height * 4)
    for z in range(new_height):
        src = ((min_z + z) * width + min_x) * 4
        dst = z * new_width * 4
        cropped[dst:dst + new_width * 4] = pixels[src:src + new_width * 4]

    return (encode_png(new_width, new_height, cropped),
            new_width, new_height, origin_x + min_x, origin_z + min_z)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("save", nargs="?", help="world folder (default: the server's world "
                                            "under fabric/run, else newest in run/saves)")
    ap.add_argument("-d", "--dimension", default="overworld")
    ap.add_argument("-o", "--out", type=Path, default=Path("map.png"))
    args = ap.parse_args()

    save = find_save(args.save)
    if save is None:
        raise SystemExit("no save found - pass one explicitly")

    png, meta = render(save, args.dimension)
    args.out.write_bytes(png)
    info = level_info(save)
    print(f"{info['name']}: {meta['width']}x{meta['height']} blocks from {meta['chunks']} chunks "
          f"in {meta['took_seconds']}s -> {args.out} ({len(png) / 1024:.0f} KB)")
    print(f"  world origin  x={meta['origin_x']} z={meta['origin_z']}  spawn {info['spawn']}")


if __name__ == "__main__":
    main()
