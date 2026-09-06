# FilePass

Check what a file reveals before you share it. Drop a JPEG, PNG or PDF, see the hidden
metadata in plain language, and get a cleaned copy that FilePass has independently verified.

Everything happens in the browser. There is no backend, no upload endpoint, no account and
no analytics. `src/ui/local-only.test.tsx` and `src/core/local-only.node.test.ts` run the whole
flow with `fetch`, `XMLHttpRequest`, `WebSocket` and `sendBeacon` replaced by traps that fail
the test if they are ever touched.

```
npm install
npm run dev     # http://localhost:5173
npm test        # 43 tests
npm run lint    # tsc --noEmit
npm run build
```

## The trust loop

```
source file -> inspect -> findings -> clean copy -> RE-INSPECT the copy -> verdict -> download
```

The cleaner's own return value is never treated as proof. `verifyClean` in
[`src/core/pipeline.ts`](src/core/pipeline.ts) re-opens the output bytes and runs the same
inspector over them, then compares what came back against what the cleaner promised to remove.
"Ready to share" is reachable only from a `verified` verdict. A promised item that is still
detected, or anything new that appears in the copy, produces "Could not fully verify this file"
and no download button. For PDFs a second parser (pdf.js) that shares no code with the cleaner
(pdf-lib) has to agree; when that second opinion cannot be obtained the verdict is `unverified`,
never `verified`.

## Why the inspector is ours

Metadata libraries do not see everything. Measured on `fixtures/dirty.png`, `exifr` reports
three of the seven privacy-carrying chunks, and on `fixtures/dirty.jpg` it does not report the
`COM` comment at all. So FilePass enumerates the file structurally — every JPEG marker segment,
every PNG chunk, the PDF Info dictionary and metadata streams — and uses `exifr` only to give
names to what it already found. A container FilePass cannot decode is still listed, as
"metadata FilePass can remove but cannot read". Nothing can be silently invisible.

## What is preserved

Image pixel data is copied byte for byte; nothing is re-encoded or re-compressed. Kept on
purpose because they are rendering data, not privacy data: JFIF and ICC segments, Adobe colour
markers, PNG `tRNS`, `iCCP`, `gAMA`, `sRGB`, `pHYs` and the APNG animation chunks. Each retained
structure has to account for its own bytes: anything a segment or chunk declares beyond the shape
its format defines is reported and removed, and a structure that appears more often than the
format allows is refused rather than guessed at.

Two things inside those retained structures are not simply kept. A colour profile is disclosed
as retained — you are told it is there and how large it is — and its free-text name, which no
renderer reads, is replaced with a plain label. A JFIF thumbnail is a second picture that can
show what the image looked like before it was edited, so it is reported and removed while the
JFIF segment itself stays valid.

EXIF orientation is a special case — dropping it silently rotates people's photos, so FilePass
writes back a minimal EXIF block containing the orientation tag and nothing else, and says so.

PDF pages, text and images are carried across by pdf-lib. Earlier incremental revisions inside
the file are dropped when the clean copy is written.

## What fails closed

Digitally signed PDFs (rewriting would invalidate the signature), password-protected PDFs,
malformed or truncated files, empty files, unsupported formats and files above 50 MB. So do
PDFs that FilePass's two readers cannot agree about, images carrying more copies of a structure
than the format permits, and colour profiles that do not hold up as profiles. Each one gets an
explanation, not a cleaned file. The extension is never trusted: format comes from the magic
bytes.

## What FilePass does not do

It does not read or remove personal information that is visible inside the document or image,
and it never claims to. Wording such as "100% anonymous" or "all personal information removed"
is asserted against in the test suite.

Two further limits are worth stating plainly, because they are choices rather than oversights.
A colour profile is kept so the picture still looks right, and FilePass checks that it really is
a profile — but it does not read what is inside it, so bytes carried within a structurally valid
profile stay in the file. The same applies to the handful of fields that exist to render an
image, such as resolution and pixel dimensions: their values are whatever the file says they
are, and keeping them means keeping those values. FilePass tells you a profile was kept; it does
not promise that nothing can hide inside one.

## What FilePass refuses to spend

Compressed metadata inside a PNG is unpacked with ceilings: one megabyte for a single text
chunk, eight megabytes of text across a file, sixteen megabytes for a colour profile, and
sixteen megabytes for everything together, so text and profile cannot be added up to claim more
than either. A file that wants more than that is refused rather than unpacked, because metadata
is small in every real image and a small file should not be able to claim unbounded memory.
Those are limits FilePass sets for itself, not something the PNG format says.

PDFs have no such ceiling, and the gap is real rather than theoretical. FilePass unpacks nothing
in a PDF itself: `pdf-lib` and `pdfjs-dist` do it while they parse, and some of it happens before
FilePass has seen enough of the file to have an opinion about it. A small PDF can therefore buy
a lot of work. A one megabyte file whose metadata is compressed around a thousand to one expands
to roughly a gigabyte and takes the better part of a minute. The 50 MB limit above is a limit on
the file as it arrives, not on what it turns into.

What that costs was measured rather than assumed, and the measurement is the reason it is
accepted here. The file is still read correctly and the cleaned copy is still verified honestly.
The page does not freeze, the tab does not fall over, and no verdict changes. What it spends is
time and memory on your own device. This version says so instead of implying a ceiling that is
not there; bounding it properly would mean changing how the two parsers are driven, and that is
not a change to make quietly beside a release.

## Fixtures

`fixtures/` holds committed binaries plus the scripts that generate them (`make.py`,
`makepdf.py`, Pillow only). They carry known metadata, Unicode, compressed text chunks and a
`<script>` tag inside a metadata value.

## Dependencies

| Package | Why |
| --- | --- |
| `exifr` | decodes EXIF/GPS/XMP for display, read only |
| `pdf-lib` | the only browser-side PDF rewriter that keeps pages intact; last published 2022, so it is a known maintenance risk |
| `pdfjs-dist` | independent second opinion on cleaned PDFs, parsing only, never rendering |
| `react` | one screen |

JPEG and PNG inspection and cleaning have no runtime dependencies.
