/**
 * Reachability is not validity or absence of metadata. Validate graph traversal,
 * range ownership and the representations of the rendering fields we may omit.
 * All other values are content to disclose, even when the display parser ignores them.
 */
export type ExifAssessment =
  | { status: 'uncertain'; reason: string }
  | { status: 'valid'; hasContent: boolean; alwaysReport: boolean; orientation?: number };

const TYPE_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
type Role = 'image' | 'exif' | 'gps' | 'interop';
interface Region { start: number; end: number; kind: 'header' | 'directory' | 'value' | 'thumbnail'; representation?: string }
interface Visit { at: number; role: Role; exit?: boolean }
const POINTERS = new Map<number, Role>([[0x8769, 'exif'], [0x8825, 'gps'], [0xa005, 'interop']]);

export function assessExif(payload: Uint8Array): ExifAssessment {
  const uncertain = (reason: string): ExifAssessment => ({ status: 'uncertain', reason });
  if (payload.length < 14 || ![69, 120, 105, 102, 0, 0].every((b, i) => payload[i] === b)) {
    return uncertain('Invalid EXIF identifier or missing TIFF header');
  }
  const tiff = payload.subarray(6);
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = String.fromCharCode(tiff[0], tiff[1]);
  if (order !== 'II' && order !== 'MM') return uncertain('Unknown byte order');
  const little = order === 'II';
  const word = (at: number) => view.getUint16(at, little);
  const long = (at: number) => view.getUint32(at, little);
  if (word(2) !== 42) return uncertain('Unsupported TIFF version');

  const regions: Region[] = [];
  const inBounds = (at: number, length: number) => Number.isSafeInteger(at)
    && Number.isSafeInteger(length) && at >= 0 && length > 0
    && at <= tiff.length && length <= tiff.length - at;

  // Exact aliases of the same typed value or thumbnail have one owner. Partial/
  // type-conflicting aliases are uncertain. Directories use the completed state.
  const claim = (region: Region): boolean => {
    if (!inBounds(region.start, region.end - region.start)) return false;
    let lo = 0; let hi = regions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (regions[mid].start < region.start) lo = mid + 1; else hi = mid;
    }
    const same = regions[lo];
    if (same?.start === region.start && same.end === region.end && same.kind === region.kind) {
      if (region.kind === 'thumbnail'
        || (region.kind === 'value' && same.representation === region.representation)) return true;
    }
    if ((lo > 0 && regions[lo - 1].end > region.start) || (same && same.start < region.end)) return false;
    regions.splice(lo, 0, region);
    return true;
  };
  claim({ start: 0, end: 8, kind: 'header' });

  const first = long(4);
  if (first < 8 || first % 2 !== 0) return uncertain('Invalid first directory');
  const states = new Map<number, { role: Role; active: boolean }>();
  const stack: Visit[] = [{ at: first, role: 'image' }];
  let hasContent = false;
  let alwaysReport = false;
  let orientation: number | undefined;

  // Iterative DFS: revisiting the active path is a cycle; a completed node with
  // the same interpretation can be referenced again without re-owning its bytes.
  while (stack.length) {
    const { at, role, exit } = stack.pop()!;
    if (exit) { states.get(at)!.active = false; continue; }
    const state = states.get(at);
    if (state) {
      if (state.active || state.role !== role) return uncertain('Cyclic or conflicting directory reference');
      continue;
    }
    if (at < 8 || at % 2 !== 0 || !inBounds(at, 2)) return uncertain('Invalid directory offset');
    const entries = word(at);
    if (!entries) return uncertain('Empty directory');
    const end = at + 2 + entries * 12 + 4;
    if (!claim({ start: at, end, kind: 'directory' })) return uncertain('Overlapping or truncated directory');
    states.set(at, { role, active: true });
    stack.push({ at, role, exit: true });
    const children: Visit[] = [];
    let previousTag = -1;
    let thumbnailAt: number | undefined;
    let thumbnailSize: number | undefined;

    for (let i = 0; i < entries; i++) {
      const entry = at + 2 + i * 12;
      const tag = word(entry); const type = word(entry + 2); const count = long(entry + 4);
      if (tag <= previousTag) return uncertain('Unsorted or duplicate tag');
      previousTag = tag;
      const unit = TYPE_SIZES[type] ?? 0;
      if (!unit || !count) return uncertain('Unsupported field type or empty value');
      const size = unit * count; // uint32 * at most 8 is exact; bounds use subtraction.
      const valueAt = size > 4 ? long(entry + 8) : entry + 8;
      if (!inBounds(valueAt, size)) return uncertain('Value leaves the EXIF block');
      if (size > 4 && (valueAt % 2 !== 0 || !claim({
        start: valueAt, end: valueAt + size, kind: 'value', representation: `${type}:${count}`,
      }))) return uncertain('Unaligned or conflicting value range');
      if (type === 2 && tiff[valueAt + size - 1] !== 0) return uncertain('Unterminated ASCII field');
      if (size < 4 && tiff.subarray(valueAt + size, entry + 12).some(b => b !== 0)) {
        return uncertain('Unexplained bytes in inline value padding');
      }

      const pointerRole = POINTERS.get(tag);
      if (pointerRole) {
        if (role !== (pointerRole === 'interop' ? 'exif' : 'image')) return uncertain('Pointer in an unsupported directory namespace');
        if (type !== 4 || count !== 1 || long(valueAt) === 0) return uncertain('Invalid directory pointer representation');
        children.push({ at: long(valueAt), role: pointerRole });
        continue;
      }
      // These layouts need additional traversal/image rules, not silent exemption
      // merely because the semantic decoder filters their pointer tag identifiers.
      if (tag === 0x14a || tag === 0x111 || tag === 0x117) return uncertain('Unsupported image/pointer layout');

      if (tag === 0x201 || tag === 0x202) {
        if (role !== 'image' || type !== 4 || count !== 1 || long(valueAt) === 0) {
          return uncertain('Invalid thumbnail declaration');
        }
        if (tag === 0x201) thumbnailAt = long(valueAt); else thumbnailSize = long(valueAt);
        continue;
      }

      // Only these supported type/count/value/role combinations are safe to omit.
      // Unknown tags are content, not an implicit assertion of harmlessness.
      const shortScalar = () => type === 3 && count === 1;
      const scalar = () => type === 3 ? word(valueAt) : long(valueAt);
      let rendering = false;
      if (role === 'image' && [0x112, 0x128, 0x213].includes(tag)) {
        const max = tag === 0x112 ? 8 : tag === 0x128 ? 3 : 2;
        if (!shortScalar() || word(valueAt) < 1 || word(valueAt) > max) return uncertain('Invalid rendering scalar');
        if (tag === 0x112 && at === first) orientation = word(valueAt);
        rendering = true;
      } else if (role === 'image' && (tag === 0x11a || tag === 0x11b)) {
        if (type !== 5 || count !== 1 || long(valueAt) === 0 || long(valueAt + 4) === 0) {
          return uncertain('Invalid resolution rational');
        }
        rendering = true;
      } else if (role === 'exif' && tag === 0xa001) {
        if (!shortScalar() || ![1, 65535].includes(word(valueAt))) return uncertain('Unsupported colour space');
        rendering = true;
      } else if (role === 'exif' && (tag === 0xa002 || tag === 0xa003)) {
        if (![3, 4].includes(type) || count !== 1 || scalar() === 0) return uncertain('Invalid pixel dimension');
        rendering = true;
      }
      if (!rendering) {
        hasContent = true;
        if ((role === 'image' && at !== first) || role === 'interop') alwaysReport = true;
      }
    }

    if (thumbnailAt !== undefined || thumbnailSize !== undefined) {
      if (thumbnailAt === undefined || thumbnailSize === undefined || !claim({
        start: thumbnailAt, end: thumbnailAt + thumbnailSize, kind: 'thumbnail',
      })) return uncertain('Missing or conflicting thumbnail range');
      // A second picture remains content even when its declared range is valid.
      hasContent = true; alwaysReport = true;
    }
    const next = long(end - 4);
    if (next) children.push({ at: next, role });
    stack.push(...children.reverse());
  }

  let end = 0;
  for (const region of regions) {
    if (region.start !== end) {
      // One zero after an odd end, BEFORE an even-aligned owner. No trailing
      // padding exception or arbitrary isolated zero can justify a clean claim.
      if (region.start !== end + 1 || end % 2 !== 1 || region.start % 2 !== 0 || tiff[end] !== 0) {
        return uncertain('Unreferenced bytes');
      }
    }
    end = region.end;
  }
  if (end !== tiff.length) return uncertain('Unreferenced trailing bytes');
  return { status: 'valid', hasContent, alwaysReport, orientation };
}
