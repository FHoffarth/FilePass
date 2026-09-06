"""Deterministic adversarial fixtures for the FilePass trust audit.

Nothing here touches the network. Run with:  python audit/fixtures/make_adversarial.py
"""
import os
import struct
import zlib

from PIL import Image
from PIL.TiffImagePlugin import IFDRational

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

AUTHOR_CANARY = "FILEPASS_SECRET_AUTHOR_7391"
OLD_REV_CANARY = "FILEPASS_OLD_REVISION_SECRET_4827"
TRAILING_CANARY = b"FILEPASS_TRAILING_SECRET_9284"
UNKNOWN_APP_CANARY = b"FILEPASS_UNKNOWN_APP_5512"
UNKNOWN_CHUNK_CANARY = b"FILEPASS_UNKNOWN_CHUNK_3140"
OBJSTM_CANARY = "FILEPASS_OBJSTM_SECRET_6620"

# --------------------------------------------------------------------------- JPEG


def base_image(size=(64, 48)):
    img = Image.new("RGB", size)
    for x in range(size[0]):
        for y in range(size[1]):
            img.putpixel((x, y), (x * 4 % 256, y * 5 % 256, 90))
    return img


def exif(orientation=None, artist=None, gps=True, extra=None):
    ex = Image.Exif()
    ex[0x010F] = "Apple"
    ex[0x0110] = "iPhone 17 Pro"
    ex[0x0131] = "Adobe Photoshop 2026"
    if artist is not None:
        ex[0x013B] = artist
    if orientation is not None:
        ex[0x0112] = orientation
    ex[0x0132] = "2026:08:22 14:32:11"
    if gps:
        ex[0x8825] = {
            1: "N", 2: (IFDRational(49), IFDRational(52), IFDRational(2208, 100)),
            3: "E", 4: (IFDRational(8), IFDRational(39), IFDRational(384, 100)),
        }
    ifd = {0x9003: "2026:08:22 14:32:11"}
    if extra:
        ifd.update(extra)
    ex[0x8769] = ifd
    return ex.tobytes()


def segments(data):
    """(marker, start, end) for every JPEG segment; the scan runs to the end."""
    out, i = [], 2
    while i < len(data):
        assert data[i] == 0xFF, f"bad marker at {i}"
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


def app_segment(marker, payload):
    return bytes([0xFF, marker]) + struct.pack(">H", len(payload) + 2) + payload


def insert_before(data, marker_to_find, blob):
    for marker, start, _end in segments(data):
        if marker == marker_to_find:
            return data[:start] + blob + data[start:]
    raise AssertionError("marker not found")


def write(name, data):
    with open(name, "wb") as fh:
        fh.write(data)
    print(f"  {name:32s} {len(data):>8d} bytes")


print("JPEG")
img = base_image()

for orientation in (1, 6, 8):
    buf = f"j_orient{orientation}.jpg"
    img.save(buf, quality=90, exif=exif(orientation=orientation, artist="Alice Smith"))
    print(f"  {buf}")

# ICC profile, must survive cleaning
srgb = open(os.path.join(os.path.dirname(Image.__file__), "..", "PIL", "__init__.py"), "rb")  # placeholder read
srgb.close()
try:
    from PIL import ImageCms
    profile = ImageCms.createProfile("sRGB")
    icc_bytes = ImageCms.ImageCmsProfile(profile).tobytes()
except Exception:  # pragma: no cover - ImageCms is optional
    icc_bytes = None
if icc_bytes:
    img.save("j_icc.jpg", quality=90, exif=exif(orientation=6, artist="Alice Smith"), icc_profile=icc_bytes)
    print("  j_icc.jpg (with ICC)")

# CMYK JPEG carries an Adobe APP14 marker
img.convert("CMYK").save("j_cmyk.jpg", quality=90, exif=exif(artist="Alice Smith"))
print("  j_cmyk.jpg")

# unicode + script-like metadata
img.save("j_unicode.jpg", quality=90, exif=exif(artist="Ünïcödé Añtøn 你好 ‮RTL"))
img.save("j_script.jpg", quality=90,
         exif=exif(artist="<script>alert('xss')</script>"),
         comment=b"<img src=x onerror=alert(1)>")
print("  j_unicode.jpg / j_script.jpg")

# two APP1 EXIF segments: the second one is the one most tools never show
clean_jpeg = base_image().tobytes  # noqa: F841  (keeps linters quiet)
img.save("tmp_base.jpg", quality=90)
base = open("tmp_base.jpg", "rb").read()
second_exif = app_segment(0xE1, b"Exif\x00\x00" + exif(artist="Second EXIF Author")[6:])
write("j_multi_app1.jpg", insert_before(open("j_orient6.jpg", "rb").read(), 0xDB, second_exif))

# unknown APPn segment carrying a canary
write("j_unknown_app.jpg", insert_before(base, 0xDB, app_segment(0xE5, b"WEIRDNS\x00" + UNKNOWN_APP_CANARY)))

# metadata placed after DQT rather than at the front
write("j_late_exif.jpg", insert_before(base, 0xC0, app_segment(0xE1, b"Exif\x00\x00" + exif(artist="Late Author")[6:])))

# COM segment placed after the scan data, just before EOI
scan_end = len(base) - 2
assert base[scan_end:] == b"\xff\xd9"
write("j_com_after_sos.jpg", base[:scan_end] + app_segment(0xFE, b"POST-SCAN " + TRAILING_CANARY) + b"\xff\xd9")

# trailing bytes appended after EOI
write("j_trailing.jpg", base + b"\n" + TRAILING_CANARY + b"\n")
write("j_trailing_dirty.jpg", open("j_orient6.jpg", "rb").read() + TRAILING_CANARY)

# truncated APP1: declared length runs past the end of the file
truncated = base[:2] + b"\xff\xe1\x40\x00" + b"Exif\x00\x00" + base[20:60]
write("j_truncated_app.jpg", truncated)
write("j_truncated_file.jpg", base[:len(base) // 2])

os.remove("tmp_base.jpg")

# --------------------------------------------------------------------------- PNG
print("PNG")


def chunk(kind, payload):
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


PNG_SIG = b"\x89PNG\r\n\x1a\n"


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


rgba = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
for i in range(32):
    rgba.putpixel((i, i), (255, 0, 0, 255))
    rgba.putpixel((i, 31 - i), (0, 0, 255, 128))
rgba.save("tmp_rgba.png")
rgba_bytes = open("tmp_rgba.png", "rb").read()
parts = png_chunks(rgba_bytes)
ihdr = next(raw for kind, raw in parts if kind == b"IHDR")
idats = [raw for kind, raw in parts if kind == b"IDAT"]
iend = next(raw for kind, raw in parts if kind == b"IEND")

text_chunks = (
    chunk(b"tEXt", b"Author\x00Alice Smith")
    + chunk(b"tEXt", b"Software\x00GIMP 3.0")
    + chunk(b"tEXt", b"Comment\x00<script>alert(1)</script>")
    + chunk(b"zTXt", b"Secret\x00\x00" + zlib.compress(b"compressed " + AUTHOR_CANARY.encode()))
    + chunk(b"iTXt", b"XML:com.adobe.xmp\x00\x00\x00\x00\x00<x:xmpmeta>Alice Smith</x:xmpmeta>")
    + chunk(b"iTXt", "Unicode\x00\x00\x00\x00\x00Ünïcödé 你好".encode("utf-8"))
    + chunk(b"tIME", struct.pack(">HBBBBB", 2026, 8, 22, 14, 32, 11))
    + chunk(b"eXIf", exif(orientation=6, artist="Alice Smith")[6:])
)

rendering = (
    chunk(b"gAMA", struct.pack(">I", 45455))
    + chunk(b"sRGB", b"\x00")
    + chunk(b"pHYs", struct.pack(">IIB", 2835, 2835, 1))
    + chunk(b"iCCP", b"ICC\x00\x00" + zlib.compress(icc_bytes if icc_bytes else b"fake-profile"))
)

write("p_full.png", PNG_SIG + ihdr + rendering + text_chunks + b"".join(idats) + iend)
write("p_text_after_idat.png", PNG_SIG + ihdr + b"".join(idats) + text_chunks + iend)
write("p_unknown_chunk.png", PNG_SIG + ihdr + chunk(b"prVt", UNKNOWN_CHUNK_CANARY) + b"".join(idats) + iend)
write("p_trailing.png", PNG_SIG + ihdr + text_chunks + b"".join(idats) + iend + b"\n" + TRAILING_CANARY)

# palette PNG with tRNS
pal = rgba.convert("P", palette=Image.ADAPTIVE, colors=16)
pal.save("tmp_pal.png", transparency=0)
pal_bytes = open("tmp_pal.png", "rb").read()
pal_parts = png_chunks(pal_bytes)
pal_head = b"".join(raw for kind, raw in pal_parts if kind in (b"IHDR", b"PLTE", b"tRNS"))
pal_body = b"".join(raw for kind, raw in pal_parts if kind == b"IDAT")
write("p_palette_trns.png", PNG_SIG + pal_head + text_chunks + pal_body + iend)

# APNG: two frames, animation control chunks must survive
actl = chunk(b"acTL", struct.pack(">II", 2, 0))
fctl0 = chunk(b"fcTL", struct.pack(">IIIIIHHBB", 0, 32, 32, 0, 0, 1, 2, 0, 0))
fctl1 = chunk(b"fcTL", struct.pack(">IIIIIHHBB", 1, 32, 32, 0, 0, 1, 2, 0, 0))
frame_data = b"".join(raw[8:-4] for kind, raw in parts if kind == b"IDAT")
fdat = chunk(b"fdAT", struct.pack(">I", 2) + frame_data)
write("p_apng.png", PNG_SIG + ihdr + actl + text_chunks + fctl0 + b"".join(idats) + fctl1 + fdat + iend)

# malformed: chunk length longer than the file
write("p_bad_length.png", PNG_SIG + ihdr[:8] + struct.pack(">I", 0xFFFF)[:4] + ihdr[8:] + b"".join(idats) + iend)
write("p_truncated.png", (PNG_SIG + ihdr + text_chunks + b"".join(idats))[:-20])

os.remove("tmp_rgba.png")
os.remove("tmp_pal.png")

# --------------------------------------------------------------------------- PDF
print("PDF")


def pdf_classic(objects, root=1, info=None, extra_trailer="", prefix=b""):
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    out[0:0] = prefix
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
    trailer += extra_trailer + " >>\nstartxref\n" + str(xref) + "\n%%EOF\n"
    return bytes(out + trailer.encode())


CONTENT = b"BT /F1 18 Tf 72 700 Td (Contact Alice Smith on 0170 5551234) Tj ET"
STREAM = b"<< /Length %d >>\nstream\n" % len(CONTENT) + CONTENT + b"\nendstream"
FONT = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"


def xmp_packet(creator):
    return (
        b'<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>'
        b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        b'<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">'
        b"<dc:creator><rdf:Seq><rdf:li>" + creator.encode() + b"</rdf:li></rdf:Seq></dc:creator>"
        b"</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
    )


def meta_obj(packet):
    return b"<< /Type /Metadata /Subtype /XML /Length %d >>\nstream\n" % len(packet) + packet + b"\nendstream"


# 1. visible personal data in page text, no hidden metadata at all
write("d_visible_only.pdf", pdf_classic([
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    STREAM, FONT,
]))

# 2. page level metadata plus catalog XMP plus Info, three places at once
write("d_multi_meta.pdf", pdf_classic([
    b"<< /Type /Catalog /Pages 2 0 R /Metadata 6 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> "
    b"/Contents 4 0 R /Metadata 8 0 R /PieceInfo << /Acme << /Private (" + AUTHOR_CANARY.encode() + b") >> >> >>",
    STREAM, FONT,
    meta_obj(xmp_packet(AUTHOR_CANARY)),
    b"<< /Title (Internal) /Author (" + AUTHOR_CANARY.encode() + b") /Producer (Acme) >>",
    meta_obj(xmp_packet("Page Level " + AUTHOR_CANARY)),
], info=7))

# 3. unusual custom Info keys and unicode / script-like values
write("d_custom_keys.pdf", pdf_classic([
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    STREAM, FONT,
    b"<< /Author (\xfe\xff\x00\xdc\x00n\x00\xef\x00c\x00\xf6\x00d\x00\xe9) "
    b"/XSNCoworkerName (<script>alert(1)</script>) /GTS_PDFXVersion (PDF/X-3:2002) "
    b"/SourceModified (D:20260814101500) /Company (" + AUTHOR_CANARY.encode() + b") >>",
], info=6))

# 4. truncated / hostile
write("d_truncated.pdf", pdf_classic([
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    STREAM,
])[:-60])

# 5. encrypted (declared in the trailer)
enc = pdf_classic([
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    STREAM,
    b"<< /Filter /Standard /V 1 /R 2 /O <" + b"41" * 32 + b"> /U <" + b"42" * 32 + b"> /P -1 >>",
], extra_trailer=" /Encrypt 5 0 R /ID [<41414141414141414141414141414141> <41414141414141414141414141414141>]")
write("d_encrypted.pdf", enc)

# 6. leading junk before the header
write("d_leading_junk.pdf", b"JUNK-BEFORE-HEADER\n" + pdf_classic([
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    STREAM,
]))

# 7. trailing bytes after %%EOF
write("d_trailing.pdf", pdf_classic([
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    STREAM, FONT,
    b"<< /Author (Alice Smith) >>",
], info=6) + b"\n" + TRAILING_CANARY + b"\n")


# 8. incremental update: revision 1 carries the secret, revision 2 replaces the Info dict
def incremental():
    base_objects = [
        b"<< /Type /Catalog /Pages 2 0 R /Metadata 6 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        STREAM, FONT,
        meta_obj(xmp_packet(OLD_REV_CANARY)),
        b"<< /Title (Rev One) /Author (" + OLD_REV_CANARY.encode() + b") >>",
    ]
    rev1 = bytearray(pdf_classic(base_objects, info=7))
    first_xref = rev1.rindex(b"xref\n0 ")

    out = bytearray(rev1)
    # revision 2 rewrites object 7 (Info) and object 6 (XMP) with harmless values
    new_packet = xmp_packet("Rev Two Author")
    updates = {
        7: b"<< /Title (Rev Two) /Author (Rev Two Author) >>",
        6: b"<< /Type /Metadata /Subtype /XML /Length %d >>\nstream\n" % len(new_packet) + new_packet + b"\nendstream",
    }
    offsets = {}
    for num, body in sorted(updates.items()):
        offsets[num] = len(out)
        out += f"{num} 0 obj\n".encode() + body + b"\nendobj\n"
    xref2 = len(out)
    out += b"xref\n"
    for num in sorted(offsets):
        out += f"{num} 1\n".encode() + f"{offsets[num]:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size 8 /Root 1 0 R /Info 7 0 R /Prev {first_xref} >>\n"
            f"startxref\n{xref2}\n%%EOF\n").encode()
    return bytes(out)


write("d_incremental.pdf", incremental())


# 9. object stream + cross reference stream: the Info dict is compressed inside an ObjStm
def objstm_pdf():
    # objects 1..5 classic, object 6 = ObjStm holding objects 7 (Info) and 8 (unused dict)
    info_body = b"<< /Title (Hidden In Stream) /Author (" + OBJSTM_CANARY.encode() + b") /Producer (Acme) >>"
    extra_body = b"<< /Note (" + OBJSTM_CANARY.encode() + b") >>"
    pairs = []
    payload = b""
    for num, body in ((7, info_body), (8, extra_body)):
        pairs.append(f"{num} {len(payload)}")
        payload += body + b" "
    header = (" ".join(pairs) + " ").encode()
    stream_data = header + payload
    compressed = zlib.compress(stream_data)
    objstm = (b"<< /Type /ObjStm /N 2 /First %d /Length %d /Filter /FlateDecode >>\nstream\n"
              % (len(header), len(compressed))) + compressed + b"\nendstream"

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        STREAM, FONT, objstm,
    ]
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"

    xref_offset = len(out)
    # entries for objects 0..9 (9 = the xref stream itself)
    rows = [(0, 0, 65535)]
    for num in range(1, 7):
        rows.append((1, offsets[num], 0))
    rows.append((2, 6, 0))  # object 7 lives in stream 6, index 0
    rows.append((2, 6, 1))  # object 8 lives in stream 6, index 1
    rows.append((1, xref_offset, 0))  # object 9, the xref stream
    table = b"".join(struct.pack(">BIH", kind, a, b) for kind, a, b in rows)
    packed = zlib.compress(table)
    xref_stream = (b"<< /Type /XRef /Size 10 /W [1 4 2] /Root 1 0 R /Info 7 0 R "
                   b"/Filter /FlateDecode /Length %d >>\nstream\n" % len(packed)) + packed + b"\nendstream"
    out += b"9 0 obj\n" + xref_stream + b"\nendobj\n"
    out += b"startxref\n" + str(xref_offset).encode() + b"\n%%EOF\n"
    return bytes(out)


write("d_objstm.pdf", objstm_pdf())

print("done")
