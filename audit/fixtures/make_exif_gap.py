"""A JPEG that carries an EXIF segment no decoder can read.

The APP1 identifier is exactly what FilePass looks for, so the segment is recognised, but
the TIFF body behind it is nonsense, so no tag can be decoded from it. Synthetic payload.
Run with: python audit/fixtures/make_exif_gap.py
"""
import os
import struct

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

CANARY = b"FILEPASS_EXIFGAP_9001"


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


img = Image.new("RGB", (18, 14))
for x in range(18):
    for y in range(14):
        img.putpixel((x, y), (x * 14 % 256, y * 18 % 256, 60))
img.save("tmp.jpg", quality=85)
base = open("tmp.jpg", "rb").read()
after_app0 = next(end for marker, _start, end in segments(base) if marker == 0xE0)

# "Exif\0\0" is the identifier FilePass classifies on; everything after it is unreadable.
payload = b"Exif\x00\x00" + bytes(8) + CANARY + bytes(40)
app1 = bytes([0xFF, 0xE1]) + struct.pack(">H", len(payload) + 2) + payload
open("x_exif_unparsable.jpg", "wb").write(base[:after_app0] + app1 + base[after_app0:])
print(f"  x_exif_unparsable.jpg  APP1/EXIF payload {len(payload)} bytes")

# the same picture with ordinary, decodable EXIF, so the normal path stays covered
exif = Image.Exif()
exif[0x013B] = "Alice Smith"
exif[0x0110] = "iPhone 17 Pro"
img.save("x_exif_readable.jpg", quality=85, exif=exif.tobytes())
print("  x_exif_readable.jpg")
os.remove("tmp.jpg")
