import { decodeTags, readOrientation } from './decode';
import { CleanResult, Finding, InspectionReport, MalformedFileError } from './types';

interface Segment {
  marker: number;
  start: number;
  end: number;
  payload?: Uint8Array;
  isScan?: boolean;
  /** Bytes that follow the end-of-image marker. Not part of the picture. */
  isTrailing?: boolean;
}

const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');

/**
 * Walks the entropy coded scan: stuffed FF00 pairs, fill bytes and restart markers all
 * belong to the picture, anything else is the next real marker. This is what makes
 * metadata placed after a scan visible to FilePass instead of being swallowed by it.
 */
function endOfScan(bytes: Uint8Array, from: number): number {
  let i = from;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const next = bytes[i + 1];
    if (next === undefined) break;
    if (next === 0x00) { i += 2; continue; }                   // stuffed data byte
    if (next === 0xff) { i += 1; continue; }                   // fill byte
    if (next >= 0xd0 && next <= 0xd7) { i += 2; continue; }    // restart marker
    return i;                                                  // a real marker starts here
  }
  throw new MalformedFileError('This JPEG file ends before the end of the image.');
}

/** Walks every marker segment. Nothing in a JPEG can be invisible to FilePass, only undecoded. */
export function readSegments(bytes: Uint8Array): Segment[] {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new MalformedFileError('This does not look like a JPEG file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segments: Segment[] = [];
  let i = 2;
  let endOfImage = -1;

  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw new MalformedFileError('This JPEG file is damaged and cannot be read safely.');
    let j = i + 1;
    while (bytes[j] === 0xff) j++;
    const marker = bytes[j];
    if (marker === undefined) throw new MalformedFileError('This JPEG file ends unexpectedly.');

    if (marker === 0xd9) { segments.push({ marker, start: i, end: j + 1 }); endOfImage = j + 1; break; }
    if (marker === 0xda) {
      if (j + 3 > bytes.length) throw new MalformedFileError('This JPEG file ends unexpectedly.');
      const headerLength = view.getUint16(j + 1);
      const headerEnd = j + 1 + headerLength;
      if (headerLength < 2 || headerEnd > bytes.length) throw new MalformedFileError('This JPEG file is damaged and cannot be read safely.');
      const scanEnd = endOfScan(bytes, headerEnd);
      segments.push({ marker, start: i, end: scanEnd, isScan: true, payload: bytes.subarray(j + 3, headerEnd) });
      i = scanEnd;
      continue;
    }
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) { segments.push({ marker, start: i, end: j + 1 }); i = j + 1; continue; }
    if (j + 3 > bytes.length) throw new MalformedFileError('This JPEG file ends unexpectedly.');
    const length = view.getUint16(j + 1);
    if (length < 2 || j + 1 + length > bytes.length) throw new MalformedFileError('This JPEG file is damaged and cannot be read safely.');
    segments.push({ marker, start: i, end: j + 1 + length, payload: bytes.subarray(j + 3, j + 1 + length) });
    i = j + 1 + length;
  }

  if (endOfImage < 0) throw new MalformedFileError('This JPEG file ends before the end of the image.');
  if (endOfImage < bytes.length) {
    segments.push({ marker: -1, start: endOfImage, end: bytes.length, isTrailing: true });
  }
  return segments;
}

export interface Container {
  name: string;
  removable: boolean;
  keptReason?: string;
}

export function classify(segment: Segment): Container {
  if (segment.isTrailing) return { name: 'TRAILING', removable: true };
  const head = segment.payload ? latin1(segment.payload.subarray(0, 32)) : '';
  const { marker } = segment;
  if (marker === 0xe0 && head.startsWith('JFIF')) return { name: 'APP0/JFIF', removable: false, keptReason: 'Needed to display the image correctly' };
  if (marker === 0xe1 && head.startsWith('Exif') && segment.payload?.[4] === 0) return { name: 'APP1/EXIF', removable: true };
  if (marker === 0xe1 && head.startsWith('http://ns.adobe.com/xap/1.0/')) return { name: 'APP1/XMP', removable: true };
  if (marker === 0xe2 && head.startsWith('ICC_PROFILE')) return { name: 'APP2/ICC', removable: false, keptReason: 'Colour profile, needed to display the image correctly' };
  if (marker === 0xed && head.startsWith('Photoshop')) return { name: 'APP13/Photoshop-IPTC', removable: true };
  if (marker === 0xee && head.startsWith('Adobe')) return { name: 'APP14/Adobe', removable: false, keptReason: 'Colour encoding, needed to display the image correctly' };
  if (marker === 0xfe) return { name: 'COM', removable: true };
  if (marker >= 0xe0 && marker <= 0xef) return { name: `APP${marker - 0xe0}`, removable: true };
  return { name: `0x${marker.toString(16)}`, removable: false, keptReason: 'Image structure' };
}

export async function inspect(bytes: Uint8Array): Promise<InspectionReport> {
  const segments = readSegments(bytes);
  const findings: Finding[] = [];
  const notes: string[] = [];

  const decoded = await decodeTags(bytes);
  const containers = segments.filter((s) => !s.isScan).map((s) => ({ segment: s, container: classify(s) }));
  const hasExif = containers.some((c) => c.container.name === 'APP1/EXIF');

  // Decoded EXIF/GPS content, attributed to the segment it came from.
  if (hasExif) {
    for (const tag of decoded) {
      findings.push({
        id: `APP1/EXIF#${tag.key}`,
        category: tag.category,
        label: tag.label,
        value: tag.value,
        container: 'APP1/EXIF',
        key: tag.key,
        removable: true,
      });
    }
  }

  // Containers FilePass can see but does not decode field by field are still reported, never hidden.
  for (const { segment, container } of containers) {
    if (!container.removable) continue;
    if (container.name === 'APP1/EXIF') continue; // reported above, tag by tag
    const size = segment.payload?.length ?? 0;
    if (container.name === 'COM') {
      findings.push({
        id: `COM#offset:${segment.start}`,
        category: 'DOCUMENT',
        label: 'Comment',
        value: latin1(segment.payload ?? new Uint8Array()).replace(/[\u0000-\u001f]/g, ' ').trim() || `${size} bytes`,
        container: 'COM',
        key: `offset:${segment.start}`,
        removable: true,
      });
      continue;
    }
    if (container.name === 'TRAILING') {
      findings.push({
        id: `TRAILING#offset:${segment.start}`,
        category: 'OTHER',
        label: 'Extra data after the end of the image',
        value: `${segment.end - segment.start} bytes that are not part of the picture`,
        container: 'TRAILING',
        key: `offset:${segment.start}`,
        removable: true,
      });
      continue;
    }
    const isXmp = container.name === 'APP1/XMP';
    findings.push({
      id: `${container.name}#offset:${segment.start}`,
      category: 'OTHER',
      label: isXmp ? 'XMP metadata block' : `${container.name} metadata block`,
      value: isXmp
        ? `${size} bytes of embedded XMP, which often names the author or the editing tool`
        : `${size} bytes FilePass can remove but cannot read`,
      container: container.name,
      key: `offset:${segment.start}`,
      removable: true,
    });
  }

  const orientation = await readOrientation(bytes);
  if (orientation !== undefined && orientation !== 1) {
    notes.push('Rotation information is kept so the picture still appears the right way up.');
  }

  return { format: 'jpeg', byteLength: bytes.length, findings, notes };
}

/** Minimal EXIF APP1 carrying nothing but the orientation tag. */
function orientationSegment(orientation: number): Uint8Array {
  const tiff = new Uint8Array(8 + 2 + 12 + 4);
  const view = new DataView(tiff.buffer);
  tiff[0] = 0x4d; tiff[1] = 0x4d;      // big endian
  view.setUint16(2, 42);
  view.setUint32(4, 8);                // offset of IFD0
  view.setUint16(8, 1);                // one entry
  view.setUint16(10, 0x0112);          // Orientation
  view.setUint16(12, 3);               // SHORT
  view.setUint32(14, 1);               // count
  view.setUint16(18, orientation);     // value, left aligned in the 4 byte field
  view.setUint32(22, 0);               // no next IFD
  const header = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif" + two NULs
  const payload = concat([header, tiff]);
  const segment = new Uint8Array(4 + payload.length);
  segment[0] = 0xff; segment[1] = 0xe1;
  new DataView(segment.buffer).setUint16(2, payload.length + 2);
  segment.set(payload, 4);
  return segment;
}

export async function clean(bytes: Uint8Array, report: InspectionReport): Promise<CleanResult> {
  const segments = readSegments(bytes);
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  const removedContainers = new Set<string>();
  const notes: string[] = [];

  const orientation = await readOrientation(bytes);
  const keepOrientation = orientation !== undefined && orientation !== 1;
  let orientationWritten = false;

  for (const segment of segments) {
    const container = classify(segment);
    if (!segment.isScan && container.removable) {
      removedContainers.add(container.name);
      continue;
    }
    parts.push(bytes.subarray(segment.start, segment.end));
    if (keepOrientation && !orientationWritten && container.name === 'APP0/JFIF') {
      parts.push(orientationSegment(orientation!));
      orientationWritten = true;
    }
  }
  if (keepOrientation && !orientationWritten) {
    parts.splice(1, 0, orientationSegment(orientation!));
    orientationWritten = true;
  }
  if (orientationWritten) {
    notes.push('Rotation information was rewritten on its own, without any other camera data.');
  }

  const promisedRemovedIds = report.findings
    .filter((f) => f.removable && removedContainers.has(f.container))
    .map((f) => f.id);

  return { bytes: concat(parts), promisedRemovedIds, notes };
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}
