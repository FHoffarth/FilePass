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
markers, PNG `tRNS`, `iCCP`, `gAMA`, `sRGB`, `pHYs` and the APNG animation chunks. EXIF
orientation is a special case — dropping it silently rotates people's photos, so FilePass writes
back a minimal EXIF block containing the orientation tag and nothing else, and says so.

PDF pages, text and images are carried across by pdf-lib. Earlier incremental revisions inside
the file are dropped when the clean copy is written.

## What fails closed

Digitally signed PDFs (rewriting would invalidate the signature), password-protected PDFs,
malformed or truncated files, empty files, unsupported formats and files above 50 MB. Each one
gets an explanation, not a cleaned file. The extension is never trusted: format comes from the
magic bytes.

## What FilePass does not do

It does not read or remove personal information that is visible inside the document or image,
and it never claims to. Wording such as "100% anonymous" or "all personal information removed"
is asserted against in the test suite.

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
