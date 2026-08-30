import os
os.chdir(os.path.dirname(os.path.abspath(__file__)))

def build(objects, root=1, info=None, extra_trailer=""):
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    n = len(objects) + 1
    out += f"xref\n0 {n}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    tr = f"trailer\n<< /Size {n} /Root {root} 0 R"
    if info: tr += f" /Info {info} 0 R"
    tr += extra_trailer + " >>\nstartxref\n" + str(xref) + "\n%%EOF\n"
    out += tr.encode()
    return bytes(out)

content = b"BT /F1 18 Tf 72 700 Td (Confidential Proposal v7) Tj ET"
stream = b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream"
xmp = (b'<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>'
 b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
 b'<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">'
 b'<dc:creator><rdf:Seq><rdf:li>Alice Smith</rdf:li></rdf:Seq></dc:creator>'
 b'<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Internal Proposal</rdf:li></rdf:Alt></dc:title>'
 b'<xmp:CreatorTool>Adobe Acrobat 2026</xmp:CreatorTool><pdf:Producer>Acme PDF Engine</pdf:Producer>'
 b'</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>')
xmpobj = b"<< /Type /Metadata /Subtype /XML /Length %d >>\nstream\n" % len(xmp) + xmp + b"\nendstream"

objs = [
  b"<< /Type /Catalog /Pages 2 0 R /Metadata 6 0 R >>",
  b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
  stream,
  b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  xmpobj,
  b"<< /Title (Internal Proposal) /Author (Alice Smith) /Subject (Pricing) /Keywords (internal, draft) "
  b"/Creator (Adobe Acrobat 2026) /Producer (Acme PDF Engine) /CreationDate (D:20260814101500+02'00') "
  b"/ModDate (D:20260822143211+02'00') /Company (Acme GmbH) >>",
]
open("dirty.pdf","wb").write(build(objs, root=1, info=7))

# clean pdf: no info, no metadata
objs2 = list(objs[:5]); objs2[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
open("no_metadata.pdf","wb").write(build(objs2, root=1))

# signed pdf (AcroForm with signature field + ByteRange)
sig = b"<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 100 200 300] /Contents <00112233> /M (D:20260822143211+02'00') >>"
objs3 = [
  b"<< /Type /Catalog /Pages 2 0 R /Metadata 6 0 R /AcroForm << /Fields [8 0 R] /SigFlags 3 >> >>",
  b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [8 0 R] >>",
  stream,
  b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  xmpobj,
  b"<< /Title (Signed Contract) /Author (Alice Smith) >>",
  b"<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [0 0 0 0] /V 9 0 R /P 3 0 R >>",
  sig,
]
open("signed.pdf","wb").write(build(objs3, root=1, info=7))

open("malformed.pdf","wb").write(b"%PDF-1.7\nthis is not a pdf body at all\n")
open("empty.pdf","wb").write(b"")
open("fake.png","wb").write(open("dirty.jpg","rb").read())  # misleading extension
print("pdf fixtures written")
