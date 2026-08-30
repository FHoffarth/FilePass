"""Independent review gate: new adversarial cases, different structural representations
from the P0 regression corpus. Audit only, no production code involved.
"""
import os
import struct
import zlib

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

ANNOT_XMP = "FILEPASS_REVIEW_ANNOTXMP_1001"
CATALOG = "FILEPASS_REVIEW_CATALOG_1002"
JPEG_PAD = "FILEPASS_REVIEW_JPEGPAD_1003"
ICCP_NAME = "FILEPASS_REVIEW_ICCP_1004"
ANNOT_XMP_FLATE = "FILEPASS_REVIEW_ANNOTXMPFLATE_1005"
HEXSTR = "FILEPASS_REVIEW_HEXSTRING_1006"


def write(name, data):
    with open(name, "wb") as fh:
        fh.write(data)
    print(f"  {name:36s} {len(data):>7d} bytes")


# --------------------------------------------------------------------------- PDF helpers
def pdf(objects, root=1, info=None, extra=""):
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
    trailer += extra + " >>\nstartxref\n" + str(xref) + "\n%%EOF\n"
    return bytes(out + trailer.encode())


CONTENT = b"BT /F1 14 Tf 72 700 Td (Quarterly numbers, page one) Tj ET"
STREAM = b"<< /Length %d >>\nstream\n" % len(CONTENT) + CONTENT + b"\nendstream"
FONT = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"


def xmp(creator):
    return (b'<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>'
            b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            b'<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>'
            + creator.encode() + b"</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>")


print("PDF review attacks")

# N1: XMP hanging off an annotation, uncompressed. Reachable, so the orphan sweep keeps it,
# and nothing inspects annotation level metadata.
packet = xmp(ANNOT_XMP)
write("r_annot_xmp.pdf", pdf([
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> "
    b"/Contents 4 0 R /Annots [6 0 R] >>",
    STREAM, FONT,
    b"<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /Contents (see note) /T (Reviewer) /Metadata 7 0 R >>",
    b"<< /Type /Metadata /Subtype /XML /Length %d >>\nstream\n" % len(packet) + packet + b"\nendstream",
    b"<< /Title (Report) /Author (Alice Smith) >>",
], info=8))

# N1b: same, but the XMP stream is Flate compressed so a plaintext byte scan cannot see it.
compressed = zlib.compress(xmp(ANNOT_XMP_FLATE))
write("r_annot_xmp_flate.pdf", pdf([
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> "
    b"/Contents 4 0 R /Annots [6 0 R] >>",
    STREAM, FONT,
    b"<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /Contents (see note) /Metadata 7 0 R >>",
    b"<< /Type /Metadata /Subtype /XML /Filter /FlateDecode /Length %d >>\nstream\n" % len(compressed)
    + compressed + b"\nendstream",
    b"<< /Title (Report) /Author (Alice Smith) >>",
], info=8))

# N2: private application data hanging off the catalog rather than a page.
write("r_catalog_pieceinfo.pdf", pdf([
    b"<< /Type /Catalog /Pages 2 0 R /PieceInfo << /Acme << /Private (" + CATALOG.encode() + b") "
    b"/LastModified (D:20260822143211+02'00') >> >> >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    STREAM, FONT,
    b"<< /Title (Report) /Author (Alice Smith) >>",
], info=6))

# N3: Info values written as hex strings instead of literals.
hex_value = HEXSTR.encode().hex().upper().encode()
write("r_hex_info.pdf", pdf([
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    STREAM, FONT,
    b"<< /Title (Report) /Author <" + hex_value + b"> >>",
], info=6))

# N4 (fidelity): an object reachable only through an annotation must survive the orphan sweep,
# and indirect /Length plus an XObject must not be collected.
img_data = zlib.compress(bytes([255, 0, 0] * 16))
write("r_reachable_only_via_annot.pdf", pdf([
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
    b"/Resources << /Font << /F1 5 0 R >> /XObject << /Im0 7 0 R >> >> /Contents 4 0 R /Annots [6 0 R] >>",
    b"<< /Length 8 0 R >>\nstream\n" + CONTENT + b"\nendstream",
    FONT,
    b"<< /Type /Annot /Subtype /Square /Rect [10 10 30 30] /AP << /N 9 0 R >> >>",
    b"<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 "
    b"/Filter /FlateDecode /Length %d >>\nstream\n" % len(img_data) + img_data + b"\nendstream",
    str(len(CONTENT)).encode(),
    b"<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length 21 >>\nstream\n"
    b"0 0 1 rg 0 0 20 20 re f\nendstream",
]))

# --------------------------------------------------------------------------- JPEG
print("JPEG review attacks")


def segments(data):
    out, i = [], 2
    while i < len(data):
        assert data[i] == 0xFF
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


img = Image.new("RGB", (48, 32))
for x in range(48):
    for y in range(32):
        img.putpixel((x, y), (x * 5 % 256, y * 7 % 256, 60))
ex = Image.Exif()
ex[0x013B] = "Alice Smith"
ex[0x0110] = "iPhone 17 Pro"
img.save("tmp_r.jpg", quality=88, exif=ex.tobytes())
base = open("tmp_r.jpg", "rb").read()

# N5: payload smuggled inside an oversized DQT segment, past the tables the decoder reads.
out = bytearray()
prev = 0
for marker, start, end in segments(base):
    if marker == 0xDB and JPEG_PAD.encode() not in out:
        body = base[start + 4:end]                       # existing table bytes
        payload = body + JPEG_PAD.encode()
        out += base[prev:start] + bytes([0xFF, 0xDB]) + struct.pack(">H", len(payload) + 2) + payload
        prev = end
write("j_padded_dqt.jpg", bytes(out) + base[prev:])

# N6: payload smuggled inside an oversized SOS header, before the entropy data.
sos = next(s for s in segments(base) if s[0] == 0xDA)
marker, start, _end = sos
header_len = struct.unpack(">H", base[start + 2:start + 4])[0]
header = base[start + 4:start + 2 + header_len]
scan = base[start + 2 + header_len:]
payload = header + JPEG_PAD.encode()
write("j_padded_sos.jpg", base[:start] + bytes([0xFF, 0xDA]) + struct.pack(">H", len(payload) + 2) + payload + scan)

os.remove("tmp_r.jpg")

# --------------------------------------------------------------------------- PNG
print("PNG review attacks")
PNG_SIG = b"\x89PNG\r\n\x1a\n"


def chunk(kind, payload):
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def png_chunks(data):
    out, i = [], 8
    while i < len(data):
        length = struct.unpack(">I", data[i:i + 4])[0]
        kind = data[i + 4:i + 8]
        out.append((kind, data[i:i + 12 + length]))
        i += 12 + length
        if kind == b"IEND":
            break
    return out


rgb = Image.new("RGB", (24, 24), (10, 120, 200))
rgb.save("tmp_r.png")
parts = png_chunks(open("tmp_r.png", "rb").read())
ihdr = next(raw for k, raw in parts if k == b"IHDR")
idats = b"".join(raw for k, raw in parts if k == b"IDAT")
iend = next(raw for k, raw in parts if k == b"IEND")

# N7: the canary rides in the iCCP profile *name*, inside a chunk FilePass keeps for rendering.
# The profile body itself is a genuine ICC profile, so only the free text name is under attack.
from PIL import ImageCms
REAL_ICC = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def iccp_chunk(name, body, method=0):
    return chunk(b"iCCP", name + b"\x00" + bytes([method]) + body)


real = zlib.compress(REAL_ICC)
iccp = iccp_chunk(ICCP_NAME.encode(), real)
write("p_iccp_name.png", PNG_SIG + ihdr + iccp + chunk(b"tEXt", b"Author\x00Alice Smith") + idats + iend)

# the malformed iCCP family from the PR #1 review, kept reproducible next to a valid one
write("p_iccp_ok.png", PNG_SIG + ihdr + iccp_chunk(b"sRGB", real) + idats + iend)
write("p_iccp_no_nul.png", PNG_SIG + ihdr + chunk(b"iCCP", b"ProfileNameWithNoTerminatorAtAll") + idats + iend)
write("p_iccp_no_method.png", PNG_SIG + ihdr + chunk(b"iCCP", b"sRGB\x00") + idats + iend)
write("p_iccp_bad_method.png", PNG_SIG + ihdr + iccp_chunk(b"sRGB", real, method=7) + idats + iend)
write("p_iccp_no_payload.png", PNG_SIG + ihdr + chunk(b"iCCP", b"sRGB\x00\x00") + idats + iend)
write("p_iccp_empty_name.png", PNG_SIG + ihdr + iccp_chunk(b"", real) + idats + iend)

# N8: an unknown *critical* chunk (uppercase first letter) that a decoder must understand.
write("p_unknown_critical.png", PNG_SIG + ihdr + chunk(b"sECr", b"critical-payload") + idats + iend)

os.remove("tmp_r.png")
print("done")
