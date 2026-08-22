#!/usr/bin/env python3
"""
Minimal NBT reader - just enough to walk a chunk out of a region file.

Only the decoding half exists: nothing here ever writes a save back, which is
deliberate. Compound tags come back as dicts, lists as lists, and the numeric
array tags (7/11/12) as plain lists of ints.
"""

import gzip
import struct
import zlib

TAG_END = 0
TAG_COMPOUND = 10

_SIMPLE = {
    1: (">b", 1),
    2: (">h", 2),
    3: (">i", 4),
    4: (">q", 8),
    5: (">f", 4),
    6: (">d", 8),
}
# byte / int / long array: element format and width
_ARRAY = {7: ("b", 1), 11: ("i", 4), 12: ("q", 8)}


def _read(buf, i, tag):
    simple = _SIMPLE.get(tag)
    if simple:
        fmt, size = simple
        return struct.unpack_from(fmt, buf, i)[0], i + size

    if tag == 8:                                    # string
        n = struct.unpack_from(">H", buf, i)[0]
        i += 2
        return buf[i:i + n].decode("utf-8", "replace"), i + n

    array = _ARRAY.get(tag)
    if array:
        code, width = array
        n = struct.unpack_from(">i", buf, i)[0]
        i += 4
        return list(struct.unpack_from(f">{n}{code}", buf, i)), i + n * width

    if tag == 9:                                    # list
        element = buf[i]
        n = struct.unpack_from(">i", buf, i + 1)[0]
        i += 5
        out = []
        for _ in range(max(0, n)):
            value, i = _read(buf, i, element)
            out.append(value)
        return out, i

    if tag == TAG_COMPOUND:
        out = {}
        while True:
            element = buf[i]
            i += 1
            if element == TAG_END:
                return out, i
            n = struct.unpack_from(">H", buf, i)[0]
            i += 2
            name = buf[i:i + n].decode("utf-8", "replace")
            i += n
            out[name], i = _read(buf, i + 0, element)

    raise ValueError(f"unknown NBT tag {tag}")


def parse(data):
    """Decodes a named root tag, transparently un-gzipping/inflating first."""
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    elif data[:1] == b"\x78":
        data = zlib.decompress(data)

    tag = data[0]
    if tag != TAG_COMPOUND:
        raise ValueError(f"root tag is {tag}, expected a compound")
    name_length = struct.unpack_from(">H", data, 1)[0]
    return _read(data, 3 + name_length, tag)[0]
