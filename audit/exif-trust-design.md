# EXIF trust assessment — Round 3 candidate

## Reproduction before production changes

At `26af4cd5443e8a21648c995a02e450c57f395fa9`, the new pipeline regressions
reproduced ASCII Orientation carrying `PRIVATE_CANARY_1234`, directory cycles,
and value/header or value/directory overlaps in both byte orders. Each could
produce zero findings. The initial test run had 46 failures and 16 passes.

## Decision

Replace `exifIsAccountedFor()` with `assessExif()`. Its result separates:

- **Uncertainty:** a structural, representation, ownership or traversal check
  failed. The caller must emit a generic finding regardless of decoder output.
- **Supported structure:** all checked structure is valid under this model.
  This is not an assertion that its content is harmless.
- **Content/disclosure:** non-rendering fields require a named finding or a
  generic fallback. Thumbnails and directories not decoded field by field always
  require disclosure, even when their declared ranges are valid.
- **Orientation:** only an assessed, valid SHORT/count=1/value=1..8 in IFD0 may
  be rewritten into the clean copy. Uncertain or conflicting orientation is not
  promoted from the semantic parser into output.

JPEG inspection decodes each EXIF APP1 independently, so an ignored second block
cannot borrow the first block's named findings. Conflicting orientations across
APP1 blocks are disclosed. Cleaning still removes the original APP1 containers;
the only reconstructed EXIF is the fixed, validated orientation representation.

## Graph and ownership rules

The iterative DFS distinguishes active nodes from completed nodes. An edge into
an active node is a cycle. A completed directory may be referenced again only
with the same directory interpretation. Pointer fields must have the supported
namespace and LONG/count=1 representation. Header, directories, typed value ranges
and thumbnail ranges are distinct owners.

An exact alias of a value range with the same type and component count is allowed:
for example XResolution and YResolution may point at the same rational. Exact
sharing of a thumbnail range is also allowed, with disclosure required. Neither
claims the bytes again. Header/directory/value intersections and conflicting
interpretations cannot authorize a clean result. Partial aliases and unsupported
image layouts are conservatively disclosed; this is a boundary of FilePass's
supported model, not a claim that all such layouts are prohibited by TIFF.

The relevant TIFF rules are in [TIFF 6.0, section 2, pages 13–16](https://www.itu.int/itudoc/itu-t/com16/tiff-fx/docs/tiff6.pdf):
values are addressed by offsets, directory and out-of-line value starts are word
aligned, field type/count determine the represented bytes, and fields need not
store their values adjacent to their entries. FilePass therefore tests compatible
sharing explicitly instead of requiring a unique allocation per field.

Only a zero filling the one-byte gap between an odd-length owner and the next
even-aligned owner is accepted as alignment. Terminal zeros and nonzero unused
inline bytes are disclosed conservatively. Zero counts, empty directories,
unsorted/duplicate tags, bounds violations and unsupported types are uncertain.

## Deliberate limits

This is not a semantic implementation of every EXIF field. The silent-rendering
exceptions validate their supported type/count/value domains. Other fields are
reportable content. Unsupported SubIFD/strip layouts are disclosed rather than
certified. A thumbnail declaration does not prove its bytes are a safe picture;
thumbnail content is always disclosed and removed with its original APP1.

The in-memory regression fixtures exercise `inspectFile()` and, for the malformed
and uncertain cases, `cleanAndVerify()` followed by re-inspection. They include
positive controls for ordinary metadata, both byte orders, alignment, compatible
shared values/directories and next-IFD/Exif/GPS/Interop traversal. Existing unreadable,
bad-pointer and unreferenced-payload regressions remain in the focused gate.

This document describes a remediation candidate, not independent approval.
