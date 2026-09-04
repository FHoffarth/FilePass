/**
 * Structural accounting for an EXIF block.
 *
 * Whether a decoder returned something is not the same question as whether the block is
 * understood. A single valid Orientation tag is enough for any parser to hand back an
 * object, while the rest of the segment can point outside itself or carry bytes nothing
 * refers to. This walks the TIFF structure and answers one thing only: is every byte of
 * this block reached by that structure? Nothing here decodes values or reports metadata —
 * that stays with the decoder.
 */

/** Bytes per component, indexed by TIFF field type. Zero means a type FilePass does not model. */
const TYPE_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

const EXIF_IFD = 0x8769;
const GPS_IFD = 0x8825;
const INTEROP_IFD = 0xa005;
const THUMBNAIL_OFFSET = 0x0201;
const THUMBNAIL_LENGTH = 0x0202;

/** The identifier an APP1 segment carries when it holds EXIF. */
export const EXIF_HEADER_LENGTH = 6;

/**
 * True when every byte after the "Exif\0\0" identifier belongs to the TIFF structure:
 * headers, directory entries, the values they point at, and the thumbnail they declare.
 * A pointer that leaves the block, a field type FilePass cannot size, or a stretch of
 * bytes nothing refers to all make this false.
 */
export function exifIsAccountedFor(payload: Uint8Array): boolean {
  if (payload.length < EXIF_HEADER_LENGTH + 8) return false;
  const tiff = payload.subarray(EXIF_HEADER_LENGTH);
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const covered = new Uint8Array(tiff.length);

  const cover = (start: number, length: number): boolean => {
    if (!Number.isFinite(start) || start < 0 || length < 0) return false;
    if (start + length > tiff.length) return false;
    covered.fill(1, start, start + length);
    return true;
  };

  const order = String.fromCharCode(tiff[0], tiff[1]);
  if (order !== 'II' && order !== 'MM') return false;
  const little = order === 'II';
  if (view.getUint16(2, little) !== 42) return false;
  cover(0, 8);

  const pending: number[] = [view.getUint32(4, little)];
  const visited = new Set<number>();
  let thumbnailAt: number | undefined;
  let thumbnailSize: number | undefined;

  while (pending.length > 0) {
    const directory = pending.shift()!;
    if (directory === 0 || visited.has(directory)) continue;
    visited.add(directory);

    if (directory + 2 > tiff.length || !cover(directory, 2)) return false;
    const entries = view.getUint16(directory, little);
    const block = entries * 12 + 4;                       // the entries plus the next-IFD pointer
    if (!cover(directory + 2, block)) return false;

    for (let i = 0; i < entries; i++) {
      const entry = directory + 2 + i * 12;
      const tag = view.getUint16(entry, little);
      const type = view.getUint16(entry + 2, little);
      const count = view.getUint32(entry + 4, little);
      const unit = TYPE_SIZES[type] ?? 0;
      if (unit === 0) return false;                       // a field FilePass cannot size
      const size = unit * count;
      if (size > 4 && !cover(view.getUint32(entry + 8, little), size)) return false;

      if (tag === EXIF_IFD || tag === GPS_IFD || tag === INTEROP_IFD) {
        pending.push(view.getUint32(entry + 8, little));
      }
      if (tag === THUMBNAIL_OFFSET) thumbnailAt = view.getUint32(entry + 8, little);
      if (tag === THUMBNAIL_LENGTH) thumbnailSize = view.getUint32(entry + 8, little);
    }

    pending.push(view.getUint32(directory + 2 + entries * 12, little));
  }

  if (thumbnailAt !== undefined || thumbnailSize !== undefined) {
    if (thumbnailAt === undefined || thumbnailSize === undefined) return false;
    if (!cover(thumbnailAt, thumbnailSize)) return false;
  }

  return onlyAlignmentPaddingLeft(tiff, covered);
}

/**
 * TIFF values start on even offsets, so a writer may need a filler byte before one. That is
 * the only thing a well formed block leaves unreferenced: a single zero. Two bytes in a row,
 * or one that is not zero, is content the structure never accounted for.
 */
function onlyAlignmentPaddingLeft(tiff: Uint8Array, covered: Uint8Array): boolean {
  let run = 0;
  for (let i = 0; i <= tiff.length; i++) {
    const uncovered = i < tiff.length && covered[i] === 0;
    if (uncovered) {
      if (tiff[i] !== 0) return false;
      run += 1;
      if (run > 1) return false;
      continue;
    }
    run = 0;
  }
  return true;
}
