"""EXIF blocks that parse in part while the rest of the segment is unaccounted for.

Both are the reviewer's probes against 389e68e: a valid Orientation tag is enough for the
decoder to return something, so a truthiness check on its output says "readable" while the
segment still carries structure nobody validated. Synthetic payloads.
Run with: python audit/fixtures/make_exif_partial.py
"""
import os
import struct

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

CANARY = b"FILEPASS_EXIFPART_9101"


def segments(data):
    out, i = [], 2
    while i < len(data):
        j = i + 1
        while data[j] == 0xFF:
            j += 1
        marker = data[j]
        if marker == 0xD9:
            out.append((marker, i, j + 1))
            break
        if marker == 0xDA:
            out.append((marker, i, len(data)))
            break
        length = struct.unpack(">H", data[j + 1:j + 3])[0]
        out.append((marker, i, j + 1 + length))
        i = j + 1 + length
    return out


def ifd(entries, next_ifd=0):
    """A big-endian IFD: entry count, twelve bytes per entry, then the next-IFD offset."""
    body = struct.pack(">H", len(entries))
    for tag, kind, count, value in entries:
        body += struct.pack(">HHI", tag, kind, count) + value
    return body + struct.pack(">I", next_ifd)


SHORT = 3
LONG = 4
ORIENTATION = struct.pack(">HH", 6, 0)          # a SHORT sits in the first half of the field


def app1(tiff):
    payload = b"Exif\x00\x00" + tiff
    return bytes([0xFF, 0xE1]) + struct.pack(">H", len(payload) + 2) + payload


def tiff_header(first_ifd=8):
    return b"MM" + struct.pack(">HI", 42, first_ifd)


img = Image.new("RGB", (18, 14))
for x in range(18):
    for y in range(14):
        img.putpixel((x, y), (x * 11 % 256, y * 7 % 256, 95))
img.save("tmp.jpg", quality=85)
base = open("tmp.jpg", "rb").read()
after_app0 = next(end for marker, _s, end in segments(base) if marker == 0xE0)
os.remove("tmp.jpg")


def write(name, tiff):
    data = base[:after_app0] + app1(tiff) + base[after_app0:]
    with open(name, "wb") as fh:
        fh.write(data)
    print(f"  {name:32s} EXIF payload {len(tiff) + 6} bytes")


# D: a valid orientation, and a pointer to an Exif IFD that lies outside the segment
write("x_exif_bad_pointer.jpg", tiff_header() + ifd([
    (0x0112, SHORT, 1, ORIENTATION),
    (0x8769, LONG, 1, struct.pack(">I", 0xFFFFFFF0)),
]))

# E: a valid orientation, then payload bytes no part of the structure refers to
write("x_exif_unreferenced.jpg", tiff_header() + ifd([
    (0x0112, SHORT, 1, ORIENTATION),
]) + CANARY + bytes(24))

# a control: the same orientation-only structure with nothing left over
write("x_exif_orientation_only.jpg", tiff_header() + ifd([
    (0x0112, SHORT, 1, ORIENTATION),
]))
