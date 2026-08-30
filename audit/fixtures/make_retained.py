"""Fixtures for the retained-structure coverage fix: JPEG JFIF identity and PNG chunk shapes.

Every planted payload is synthetic. Run with: python audit/fixtures/make_retained.py
"""
import os
import struct
import zlib

from PIL import Image, ImageCms

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

JFIF = b"FILEPASS_RETAINED_JFIF_4001"
CHUNK = b"FILEPASS_RETAINED_CHUNK_4002"

REAL_ICC = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def write(name, data):
    with open(name, "wb") as fh:
        fh.write(data)
    print(f"  {name:32s} {len(data):>7d} bytes")


# ------------------------------------------------------------------ JPEG
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


def replace_app0(data, payload):
    out, prev, done = bytearray(), 0, False
    for marker, start, end in segments(data):
        if marker == 0xE0 and not done:
            out += data[prev:start] + bytes([0xFF, 0xE0]) + struct.pack(">H", len(payload) + 2) + payload
            prev, done = end, True
    assert done
    return bytes(out) + data[prev:]


print("JPEG: what counts as a JFIF identifier")
img = Image.new("RGB", (28, 20))
for x in range(28):
    for y in range(20):
        img.putpixel((x, y), (x * 5 % 256, y * 11 % 256, 90))
img.save("tmp.jpg", quality=85)
base = open("tmp.jpg", "rb").read()
jfif = next(base[s + 4:e] for m, s, e in segments(base) if m == 0xE0)
assert jfif[:5] == b"JFIF\x00"

write("e_jfif_ok.jpg", base)                                            # J1
write("e_jfif_x.jpg", replace_app0(base, b"JFIFx" + jfif[5:] + JFIF))   # J3
write("e_jfif_alt.jpg", replace_app0(base, b"JFIF1" + jfif[5:] + JFIF)) # J4
write("e_jfif_short.jpg", replace_app0(base, b"JFI" + JFIF))            # J5
os.remove("tmp.jpg")

# ------------------------------------------------------------------ PNG
SIG = b"\x89PNG\r\n\x1a\n"


def chunk(kind, payload):
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def parts_of(path):
    data = open(path, "rb").read()
    out, i = [], 8
    while i < len(data):
        n = struct.unpack(">I", data[i:i + 4])[0]
        kind = data[i + 4:i + 8]
        out.append((kind, data[i:i + 12 + n]))
        i += 12 + n
        if kind == b"IEND":
            break
    return out


Image.new("RGB", (16, 16), (30, 90, 160)).save("tmp.png")
rgb = parts_of("tmp.png")
IHDR = next(r for k, r in rgb if k == b"IHDR")
IDAT = b"".join(r for k, r in rgb if k == b"IDAT")
IEND = next(r for k, r in rgb if k == b"IEND")
os.remove("tmp.png")

# a palette image, for the chunks whose size depends on the colour type
palette = Image.new("P", (16, 16))
palette.putpalette([(i * 7) % 256 for i in range(768)])
palette.save("tmp_p.png")
pal = parts_of("tmp_p.png")
P_IHDR = next(r for k, r in pal if k == b"IHDR")
P_PLTE = next(r for k, r in pal if k == b"PLTE")
P_IDAT = b"".join(r for k, r in pal if k == b"IDAT")
os.remove("tmp_p.png")
PALETTE_ENTRIES = (struct.unpack(">I", P_PLTE[:4])[0]) // 3

GAMA = struct.pack(">I", 45455)
PHYS = struct.pack(">IIB", 2835, 2835, 1)
CHRM = struct.pack(">8I", 31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000)


def rgb_png(*extra):
    return SIG + IHDR + b"".join(extra) + IDAT + IEND


def palette_png(*extra):
    return SIG + P_IHDR + P_PLTE + b"".join(extra) + P_IDAT + IEND


print("PNG: fixed size retained chunks")
write("e_fixed_ok.png", rgb_png(
    chunk(b"gAMA", GAMA), chunk(b"pHYs", PHYS), chunk(b"cHRM", CHRM),
    chunk(b"sRGB", b"\x00"), chunk(b"sBIT", b"\x08\x08\x08"), chunk(b"bKGD", struct.pack(">3H", 0, 0, 0)),
    chunk(b"iCCP", b"sRGB\x00\x00" + zlib.compress(REAL_ICC)),
))
for name, kind, payload in [
    ("e_gama_long.png", b"gAMA", GAMA + CHUNK),
    ("e_gama_short.png", b"gAMA", GAMA[:2]),
    ("e_phys_long.png", b"pHYs", PHYS + CHUNK),
    ("e_chrm_short.png", b"cHRM", CHRM[:20]),
    ("e_srgb_long.png", b"sRGB", b"\x00" + CHUNK),
    ("e_cicp_long.png", b"cICP", b"\x01\x0d\x00\x01" + CHUNK),
]:
    write(name, rgb_png(chunk(kind, payload)))

print("PNG: variable size retained chunks")
write("e_variable_ok.png", palette_png(
    chunk(b"tRNS", bytes([255] * PALETTE_ENTRIES)),
    chunk(b"sBIT", b"\x08\x08\x08"),
    chunk(b"bKGD", b"\x00"),
    chunk(b"hIST", b"".join(struct.pack(">H", 1) for _ in range(PALETTE_ENTRIES))),
    chunk(b"sPLT", b"web\x00\x08" + bytes(6 * 4)),
))
write("e_trns_long.png", palette_png(chunk(b"tRNS", bytes([255] * (PALETTE_ENTRIES + 8)))))
write("e_sbit_wrong.png", palette_png(chunk(b"sBIT", b"\x08\x08")))
write("e_bkgd_long.png", palette_png(chunk(b"bKGD", b"\x00" + CHUNK)))
write("e_hist_wrong.png", palette_png(chunk(b"hIST", b"\x00\x01\x00\x02")))
write("e_splt_pad.png", palette_png(chunk(b"sPLT", b"web\x00\x08" + bytes(6 * 4) + CHUNK)))
write("e_plte_bad.png", SIG + P_IHDR + chunk(b"PLTE", P_PLTE[8:-4] + b"\x00") + P_IDAT + IEND)

print("PNG: APNG control structures")
actl = chunk(b"acTL", struct.pack(">II", 2, 0))
fctl0 = chunk(b"fcTL", struct.pack(">IIIIIHHBB", 0, 16, 16, 0, 0, 1, 2, 0, 0))
fctl1 = chunk(b"fcTL", struct.pack(">IIIIIHHBB", 1, 16, 16, 0, 0, 1, 2, 0, 0))
frame = b"".join(r[8:-4] for k, r in rgb if k == b"IDAT")
fdat = chunk(b"fdAT", struct.pack(">I", 2) + frame)
write("e_apng_ok.png", SIG + IHDR + actl + fctl0 + IDAT + fctl1 + fdat + IEND)
write("e_actl_long.png", SIG + IHDR + chunk(b"acTL", struct.pack(">II", 2, 0) + CHUNK) + fctl0 + IDAT + fctl1 + fdat + IEND)
write("e_fctl_short.png", SIG + IHDR + actl + chunk(b"fcTL", struct.pack(">IIIIIHHBB", 0, 16, 16, 0, 0, 1, 2, 0, 0)[:20]) + IDAT + IEND)
write("e_fdat_short.png", SIG + IHDR + actl + fctl0 + IDAT + fctl1 + chunk(b"fdAT", b"\x00\x00") + IEND)

print("verifier: a retained profile that disappears")
write("e_profile_present.png", rgb_png(chunk(b"iCCP", b"sRGB\x00\x00" + zlib.compress(REAL_ICC))))
write("e_profile_absent.png", rgb_png())
print("done")
