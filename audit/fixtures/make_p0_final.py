"""Fixtures for the four false-VERIFIED paths found by the final local adversarial review.

Every planted payload is synthetic. Run with: python audit/fixtures/make_p0_final.py
"""
import os
import struct
import zlib

from PIL import Image, ImageCms

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

JFIF = b"FILEPASS_FINAL_JFIF_2001"
APP14 = b"FILEPASS_FINAL_APP14_2002"
ICCP2 = b"FILEPASS_FINAL_ICCP2_2003"
PAGES = b"FILEPASS_FINAL_PAGESXMP_2004"

REAL_ICC = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
assert REAL_ICC[36:40] == b"acsp" and struct.unpack(">I", REAL_ICC[:4])[0] == len(REAL_ICC)


def write(name, data):
    with open(name, "wb") as fh:
        fh.write(data)
    print(f"  {name:34s} {len(data):>7d} bytes")


# ------------------------------------------------------------------ JPEG helpers
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


def replace_segment(data, marker, new_payload):
    out, prev, done = bytearray(), 0, False
    for m, s, e in segments(data):
        if m == marker and not done:
            out += data[prev:s] + bytes([0xFF, marker]) + struct.pack(">H", len(new_payload) + 2) + new_payload
            prev, done = e, True
    assert done, f"marker {marker:#x} not found"
    return bytes(out) + data[prev:]


def payload_of(data, marker):
    for m, s, e in segments(data):
        if m == marker:
            return data[s + 4:e]
    raise AssertionError("marker not found")


print("P0-A: kept JPEG APP structures")
img = Image.new("RGB", (32, 24))
for x in range(32):
    for y in range(24):
        img.putpixel((x, y), (x * 7 % 256, y * 9 % 256, 70))
img.save("tmp_rgb.jpg", quality=85)
img.convert("CMYK").save("tmp_cmyk.jpg", quality=85)
rgb = open("tmp_rgb.jpg", "rb").read()
cmyk = open("tmp_cmyk.jpg", "rb").read()

jfif = payload_of(rgb, 0xE0)
assert jfif[:5] == b"JFIF\x00" and len(jfif) == 14, (jfif[:5], len(jfif))
write("a_jfif_pad.jpg", replace_segment(rgb, 0xE0, jfif + JFIF))

# a legal JFIF carrying a 2x2 RGB thumbnail: 14 fixed bytes + 3*2*2 thumbnail bytes
thumb = bytes([9, 9, 9] * 4)
write("a_jfif_thumb.jpg", replace_segment(rgb, 0xE0, jfif[:12] + bytes([2, 2]) + thumb))
# the same header, but the declared thumbnail data is missing
write("a_jfif_thumb_missing.jpg", replace_segment(rgb, 0xE0, jfif[:12] + bytes([4, 4])))
# a legal thumbnail AND appended payload: the thumbnail must survive, the payload must not
write("a_jfif_thumb_pad.jpg", replace_segment(rgb, 0xE0, jfif[:12] + bytes([2, 2]) + thumb + JFIF))
write("a_jfif_truncated.jpg", replace_segment(rgb, 0xE0, jfif[:10]))

adobe = payload_of(cmyk, 0xEE)
assert adobe[:5] == b"Adobe" and len(adobe) == 12, (adobe[:5], len(adobe))
write("a_app14_ok.jpg", cmyk)
write("a_app14_pad.jpg", replace_segment(cmyk, 0xEE, adobe + APP14))
write("a_app14_short.jpg", replace_segment(cmyk, 0xEE, adobe[:8]))

os.remove("tmp_rgb.jpg")
os.remove("tmp_cmyk.jpg")

# ------------------------------------------------------------------ PNG helpers
SIG = b"\x89PNG\r\n\x1a\n"


def chunk(kind, payload):
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def png_parts(path):
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


Image.new("RGB", (20, 20), (9, 140, 90)).save("tmp.png")
parts = png_parts("tmp.png")
IHDR = next(r for k, r in parts if k == b"IHDR")
IDAT = b"".join(r for k, r in parts if k == b"IDAT")
IEND = next(r for k, r in parts if k == b"IEND")
os.remove("tmp.png")


def png(*chunks):
    return SIG + IHDR + b"".join(chunks) + IDAT + IEND


def iccp(name, body, method=0):
    return chunk(b"iCCP", name + b"\x00" + bytes([method]) + body)


print("P0-B: duplicate retained identities")
real = zlib.compress(REAL_ICC)
# a second profile whose compressed payload is exactly as long as the first one
carrier = (ICCP2 + b" ") * 200
fake = carrier[:len(real)]
assert len(fake) == len(real) and ICCP2 in fake
write("b_iccp_equal.png", png(iccp(b"sRGB", real), iccp(b"sRGB", fake)))
write("b_iccp_reordered.png", png(iccp(b"sRGB", fake), iccp(b"sRGB", real)))
write("b_iccp_single.png", png(iccp(b"sRGB", real)))

print("P0-C: colour profile content validity")
write("c_iccp_valid.png", png(iccp(b"sRGB", real)))
write("c_iccp_plaintext.png", png(iccp(b"sRGB", carrier[:300])))
write("c_iccp_truncated_zlib.png", png(iccp(b"sRGB", real[:len(real) // 2])))
write("c_iccp_empty.png", png(iccp(b"sRGB", zlib.compress(b""))))
write("c_iccp_bad_header.png", png(iccp(b"sRGB", zlib.compress(bytes(400)))))
write("c_iccp_bad_method.png", png(iccp(b"sRGB", real, method=1)))
# a profile whose own declared size disagrees with what was decompressed
mismatched = bytearray(REAL_ICC)
struct.pack_into(">I", mismatched, 0, len(REAL_ICC) + 500)
write("c_iccp_size_mismatch.png", png(iccp(b"sRGB", zlib.compress(bytes(mismatched)))))
write("c_iccp_bomb.png", png(iccp(b"sRGB", zlib.compress(bytes(40 * 1024 * 1024)))))
# the canary lives in the free text name, the profile itself is genuine
write("c_iccp_named.png", png(iccp(ICCP2, real)))

# ------------------------------------------------------------------ PDF
print("P0-D: page tree metadata")


def pdf(objects, root=1, info=None):
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    n = len(objects) + 1
    out += f"xref\n0 {n}\n".encode() + b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    trailer = f"trailer\n<< /Size {n} /Root {root} 0 R"
    if info:
        trailer += f" /Info {info} 0 R"
    trailer += " >>\nstartxref\n" + str(xref) + "\n%%EOF\n"
    return bytes(out + trailer.encode())


CONTENT = b"BT /F1 14 Tf 72 700 Td (Quarterly numbers) Tj ET"
STREAM = b"<< /Length %d >>\nstream\n" % len(CONTENT) + CONTENT + b"\nendstream"
FONT = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
XMP = b'<?xpacket begin="\xef\xbb\xbf"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:creator>' + PAGES + b"</dc:creator></x:xmpmeta>"
COMPRESSED = zlib.compress(XMP)
# deliberately no /Type /Metadata, so a plaintext signature scan cannot see it either
META = b"<< /Subtype /XML /Filter /FlateDecode /Length %d >>\nstream\n" % len(COMPRESSED) + COMPRESSED + b"\nendstream"
PAGE = (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>")

write("d_pages_xmp_root.pdf", pdf([
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 /Metadata 6 0 R >>",
    PAGE, STREAM, FONT, META,
    b"<< /Title (Report) /Author (Alice Smith) >>",
], info=7))

write("d_pages_xmp_nested.pdf", pdf([
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [6 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 6 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    STREAM, FONT,
    b"<< /Type /Pages /Parent 2 0 R /Kids [3 0 R] /Count 1 /Metadata 7 0 R >>",
    META,
    b"<< /Title (Report) /Author (Alice Smith) >>",
], info=8))

write("d_pages_pieceinfo.pdf", pdf([
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 /PieceInfo << /Acme << /Private (" + PAGES + b") >> >> >>",
    PAGE, STREAM, FONT,
    b"<< /Title (Report) /Author (Alice Smith) >>",
], info=6))

# a page tree that points back at itself
write("d_pages_cycle.pdf", pdf([
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [6 0 R] /Count 1 >>",
    PAGE, STREAM, FONT,
    b"<< /Type /Pages /Parent 2 0 R /Kids [2 0 R 3 0 R] /Count 1 /Metadata 7 0 R >>",
    META,
], info=None))

print("done")
