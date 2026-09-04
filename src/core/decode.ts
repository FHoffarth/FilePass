import exifr from 'exifr';
import { Category, Finding } from './types';

/** EXIF tags FilePass understands, by numeric id. Anything absent here is reported as OTHER. */
const EXIF_TAGS: Record<number, { label: string; category: Category }> = {
  0x010e: { label: 'Description', category: 'DOCUMENT' },
  0x010f: { label: 'Camera manufacturer', category: 'DEVICE' },
  0x0110: { label: 'Camera model', category: 'DEVICE' },
  0x0131: { label: 'Software', category: 'DEVICE' },
  0x013b: { label: 'Author', category: 'IDENTITY' },
  0x8298: { label: 'Copyright', category: 'IDENTITY' },
  0x0132: { label: 'Modified', category: 'TIME' },
  0x9003: { label: 'Captured', category: 'TIME' },
  0x9004: { label: 'Created', category: 'TIME' },
  0x9286: { label: 'User comment', category: 'OTHER' },
  0xa430: { label: 'Camera owner', category: 'IDENTITY' },
  0xa431: { label: 'Camera serial number', category: 'DEVICE' },
  0xa433: { label: 'Lens manufacturer', category: 'DEVICE' },
  0xa434: { label: 'Lens model', category: 'DEVICE' },
  0xc615: { label: 'Original file name', category: 'DOCUMENT' },
};

/** Tags that exist for rendering, not for privacy. Never removed silently, never reported as a leak. */
const RENDERING_TAGS = new Set([
  0x0112, 0x011a, 0x011b, 0x0128, 0x0213, 0x0201, 0x0202, 0xa001, 0xa002, 0xa003,
]);

/** Pointers into other IFDs; structure, not content. */
const POINTER_TAGS = new Set([0x8769, 0x8825, 0xa005, 0x014a, 0x0111, 0x0117]);

const asText = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Uint8Array) return `${v.length} bytes of binary data`;
  if (Array.isArray(v)) return v.map(asText).join(', ');
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

const EXIFR_OPTIONS = {
  tiff: true, ifd0: true, exif: true, gps: true, xmp: true, iptc: true,
  mergeOutput: false, translateKeys: false, translateValues: false,
  reviveValues: false, sanitize: false,
} as const;

export interface DecodedTag {
  key: string;
  label: string;
  category: Category;
  value: string;
}

/**
 * Semantic decoding of EXIF/GPS/XMP for display. This is deliberately NOT the inspector:
 * exifr does not surface every metadata structure (it misses PNG zTXt and JPEG COM, for one),
 * so the format modules enumerate containers structurally and use this only to name what is inside.
 */
export async function decodeTags(bytes: Uint8Array): Promise<DecodedTag[]> {
  let parsed: Record<string, any> | undefined;
  try {
    parsed = await exifr.parse(bytes as any, EXIFR_OPTIONS as any);
  } catch {
    return [];
  }
  if (!parsed) return [];
  const out: DecodedTag[] = [];

  for (const block of ['ifd0', 'exif'] as const) {
    const b = parsed[block];
    if (!b || typeof b !== 'object') continue;
    for (const [rawKey, value] of Object.entries(b)) {
      const tag = Number(rawKey);
      if (!Number.isFinite(tag)) continue;
      if (RENDERING_TAGS.has(tag) || POINTER_TAGS.has(tag)) continue;
      const text = asText(value);
      if (!text) continue;
      const known = EXIF_TAGS[tag];
      out.push({
        key: `${block}:${tag}`,
        label: known ? known.label : `EXIF tag ${tag}`,
        category: known ? known.category : 'OTHER',
        value: text,
      });
    }
  }

  const gps = parsed.gps;
  if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
    out.push({
      key: 'gps:position',
      label: 'GPS location',
      category: 'LOCATION',
      value: `${gps.latitude.toFixed(4)}, ${gps.longitude.toFixed(4)}`,
    });
  }

  return out;
}

/**
 * Whether the decoder made sense of the EXIF at all, which is a different question from
 * whether any of it is worth reporting: an EXIF block holding nothing but the orientation
 * tag decodes perfectly and yields no findings, while a corrupt one yields none either.
 */
export async function exifIsReadable(bytes: Uint8Array): Promise<boolean> {
  try {
    const parsed: any = await exifr.parse(bytes as any, EXIFR_OPTIONS as any);
    return Boolean(parsed && (parsed.ifd0 || parsed.exif || parsed.gps));
  } catch {
    return false;
  }
}

/** Orientation drives how the image is displayed; FilePass preserves it rather than rotating photos. */
export async function readOrientation(bytes: Uint8Array): Promise<number | undefined> {
  try {
    const parsed: any = await exifr.parse(bytes as any, { ifd0: [0x0112], mergeOutput: false, translateKeys: false, translateValues: false } as any);
    const v = parsed?.ifd0?.['274'];
    return typeof v === 'number' ? v : undefined;
  } catch {
    return undefined;
  }
}
