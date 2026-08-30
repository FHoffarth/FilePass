from PIL import Image, PngImagePlugin
import os
os.chdir(os.path.dirname(os.path.abspath(__file__)))

# --- JPEG with EXIF (identity/device/time), GPS, orientation, XMP, ICC-ish
img = Image.new("RGB", (64, 48), (200, 120, 40))
for x in range(64):
    for y in range(48):
        img.putpixel((x, y), (x * 4 % 256, y * 5 % 256, 90))
ex = Image.Exif()
ex[0x010F] = "Apple"            # Make
ex[0x0110] = "iPhone 17 Pro"    # Model
ex[0x0131] = "Adobe Photoshop 2026"  # Software
ex[0x013B] = "Alice Smith"      # Artist
ex[0x8298] = "(c) Alice Smith"  # Copyright
ex[0x0112] = 6                  # Orientation = rotate 90 CW
ex[0x0132] = "2026:08:22 14:32:11"
from PIL.TiffImagePlugin import IFDRational
gps = {1: "N", 2: (IFDRational(49), IFDRational(52), IFDRational(2208,100)), 3: "E", 4: (IFDRational(8), IFDRational(39), IFDRational(384,100))}
ex[0x8825] = gps
exif_ifd = {0x9003: "2026:08:22 14:32:11", 0xA430: "Alice Smith"}
ex[0x8769] = exif_ifd
xmp = b'<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>Alice Smith</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
img.save("dirty.jpg", quality=90, exif=ex.tobytes(), xmp=xmp, comment=b"internal draft - do not share")
img.save("clean.jpg", quality=90)

# --- PNG with textual metadata + transparency + eXIf
rgba = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
for i in range(32):
    rgba.putpixel((i, i), (255, 0, 0, 255))
    rgba.putpixel((i, 31 - i), (0, 0, 255, 128))
info = PngImagePlugin.PngInfo()
info.add_text("Author", "Alice Smith")
info.add_text("Software", "GIMP 3.0")
info.add_text("Creation Time", "2026-08-22T14:32:11")
info.add_itxt("XML:com.adobe.xmp", '<x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:creator>Alice Smith</dc:creator></x:xmpmeta>')
info.add_text("Comment", "<script>alert(1)</script> \u00fcml\u00e4ut \u4f60\u597d")
info.add_text("zipped", "x" * 400, zip=True)
rgba.save("dirty.png", pnginfo=info, exif=ex.tobytes())
rgba.save("clean.png")
print("jpeg/png fixtures written")
