import { decodeTags } from './decode';
import { Category, CleanResult, Finding, InspectionReport, MalformedFileError } from './types';
import { concat } from './jpeg';
import { contentDigest } from './evidence';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export interface Chunk {
  type: string;
  start: number;
  end: number;
  data: Uint8Array;
}

/**
 * Chunks that carry rendering or animation information. Removing these damages the picture,
 * so FilePass keeps them and says so. Everything not on this list is metadata and is removed.
 */
const RENDERING_CHUNKS = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT',
  'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCv', 'cLLi',
]);

export function readChunks(bytes: Uint8Array): Chunk[] {
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) throw new MalformedFileError('This does not look like a PNG file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Chunk[] = [];
  let i = 8;
  while (i + 8 <= bytes.length) {
    const length = view.getUint32(i);
    const type = Array.from(bytes.subarray(i + 4, i + 8), (c) => String.fromCharCode(c)).join('');
    if (!/^[A-Za-z]{4}$/.test(type)) throw new MalformedFileError('This PNG file is damaged and cannot be read safely.');
    if (i + 12 + length > bytes.length) throw new MalformedFileError('This PNG file ends unexpectedly.');
    chunks.push({ type, start: i, end: i + 12 + length, data: bytes.subarray(i + 8, i + 8 + length) });
    i += 12 + length;
    if (type === 'IEND') break;
  }
  if (!chunks.some((c) => c.type === 'IHDR')) throw new MalformedFileError('This PNG file is missing its header.');
  return chunks;
}

const KEYWORD_MAP: Record<string, { label: string; category: Category }> = {
  author: { label: 'Author', category: 'IDENTITY' },
  'creation time': { label: 'Created', category: 'TIME' },
  'modification time': { label: 'Modified', category: 'TIME' },
  software: { label: 'Software', category: 'DEVICE' },
  source: { label: 'Source device', category: 'DEVICE' },
  title: { label: 'Title', category: 'DOCUMENT' },
  description: { label: 'Description', category: 'DOCUMENT' },
  comment: { label: 'Comment', category: 'DOCUMENT' },
  copyright: { label: 'Copyright', category: 'IDENTITY' },
  disclaimer: { label: 'Disclaimer', category: 'DOCUMENT' },
  warning: { label: 'Warning', category: 'DOCUMENT' },
};

const utf8 = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: false }).decode(b);

async function inflate(data: Uint8Array): Promise<Uint8Array | undefined> {
  if (typeof DecompressionStream === 'undefined') return undefined;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return undefined;
  }
}

/** Reads keyword and text out of a tEXt / zTXt / iTXt chunk. Values may be untrusted text. */
async function readTextChunk(chunk: Chunk): Promise<{ keyword: string; text: string }> {
  const nul = chunk.data.indexOf(0);
  const keyword = utf8(chunk.data.subarray(0, nul < 0 ? chunk.data.length : nul));
  const rest = chunk.data.subarray(nul + 1);
  if (chunk.type === 'tEXt') return { keyword, text: utf8(rest) };
  if (chunk.type === 'zTXt') {
    const inflated = await inflate(rest.subarray(1));
    return { keyword, text: inflated ? utf8(inflated) : 'compressed text FilePass can remove but did not decode' };
  }
  // iTXt: compression flag, compression method, language tag, translated keyword, then text.
  const compressed = rest[0] === 1;
  let cursor = 2;
  for (let seen = 0; seen < 2 && cursor < rest.length; cursor++) if (rest[cursor] === 0) seen++;
  const body = rest.subarray(cursor);
  if (!compressed) return { keyword, text: utf8(body) };
  const inflated = await inflate(body);
  return { keyword, text: inflated ? utf8(inflated) : 'compressed text FilePass can remove but did not decode' };
}

const clip = (s: string) => (s.length > 160 ? `${s.slice(0, 157)}...` : s);

/** The label FilePass writes in place of whatever text a profile was carrying. */
const PROFILE_LABEL = 'ICC profile';

/** No real profile comes close to this, and it stops a crafted chunk from expanding forever. */
const MAX_PROFILE_BYTES = 16 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat([Uint8Array.from(type, (ch) => ch.charCodeAt(0)), data]);
  const out = new Uint8Array(8 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc32(body));
  return out;
}

/** PNG allows at most one embedded profile; more than one is a shape FilePass will not guess at. */
function assertOneProfile(chunks: Chunk[]): void {
  if (chunks.filter((chunk) => chunk.type === 'iCCP').length > 1) {
    throw new MalformedFileError('This image carries more than one colour profile, which FilePass cannot account for.');
  }
}

/** Inflates with a ceiling, so a small chunk cannot claim an unbounded amount of memory. */
async function inflateBounded(data: Uint8Array, limit: number): Promise<Uint8Array | undefined> {
  if (typeof DecompressionStream === 'undefined') return undefined;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) { await reader.cancel(); return undefined; }
      parts.push(value);
    }
    return concat(parts);
  } catch {
    return undefined;
  }
}

/**
 * Enough structure to justify calling the retained bytes a colour profile: it has to unpack,
 * be large enough to hold an ICC header, agree with its own declared size, and carry the
 * ICC signature. This is a validity check for the claim FilePass makes, not colour management.
 */
async function profileBytes(rest: Uint8Array): Promise<Uint8Array> {
  const profile = await inflateBounded(rest.subarray(1), MAX_PROFILE_BYTES);
  if (!profile) {
    throw new MalformedFileError('The colour profile in this image could not be unpacked, so FilePass will not vouch for it.');
  }
  if (profile.length < 132) {
    throw new MalformedFileError('The colour profile in this image is too small to be a profile.');
  }
  const view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength);
  if (view.getUint32(0) !== profile.length) {
    throw new MalformedFileError('The colour profile in this image does not match its own declared size.');
  }
  if (utf8(profile.subarray(36, 40)) !== 'acsp') {
    throw new MalformedFileError('The colour profile in this image is not in the expected format.');
  }
  return profile;
}

/**
 * Splits an iCCP chunk into its free text label and the profile bytes themselves.
 * The format is: a profile name of 1 to 79 bytes, a NUL, one compression method byte,
 * then the compressed profile. FilePass only rewrites structures it can account for,
 * so anything that does not match that shape is refused rather than guessed at.
 */
function readProfileChunk(chunk: Chunk): { name: string; rest: Uint8Array } {
  const nul = chunk.data.indexOf(0);
  if (nul < 1 || nul > 79) {
    throw new MalformedFileError('The colour profile in this image has no readable name, so FilePass will not touch it.');
  }
  const rest = chunk.data.subarray(nul + 1);
  if (rest.length < 2) {
    throw new MalformedFileError('The colour profile in this image is missing its data and cannot be checked.');
  }
  if (rest[0] !== 0) {
    throw new MalformedFileError('The colour profile in this image is packed in a way FilePass does not know.');
  }
  return { name: utf8(chunk.data.subarray(0, nul)).trim(), rest };
}

export async function inspect(bytes: Uint8Array): Promise<InspectionReport> {
  const chunks = readChunks(bytes);
  assertOneProfile(chunks);
  const findings: Finding[] = [];
  const notes: string[] = [];

  for (const chunk of chunks) {
    if (chunk.type === 'iCCP') {
      // The colour profile itself has to stay, and FilePass says so rather than letting it
      // ride along undisclosed. Its name is free text with no effect on rendering, so that
      // part is replaced with a plain label.
      const { name, rest } = readProfileChunk(chunk);
      const profile = await profileBytes(rest);
      if (name && name !== PROFILE_LABEL) {
        findings.push({
          id: 'iCCP#name',
          category: 'OTHER',
          label: 'Colour profile name',
          value: clip(name),
          container: 'iCCP',
          key: 'iCCP:name',
          removable: true,
        });
      }
      findings.push({
        id: 'iCCP#profile',
        category: 'OTHER',
        label: 'Colour profile',
        // the profile itself, not the chunk: this stays the same when the name is replaced
        value: `${profile.length} bytes of colour information`,
        evidence: await contentDigest(profile),
        container: 'iCCP-profile',
        key: 'iCCP',
        removable: false,
        keptReason: 'Needed to display the image with the right colours',
      });
      continue;
    }
    if (RENDERING_CHUNKS.has(chunk.type)) continue;
    const id = `${chunk.type}#offset:${chunk.start}`;

    if (chunk.type === 'tEXt' || chunk.type === 'zTXt' || chunk.type === 'iTXt') {
      const { keyword, text } = await readTextChunk(chunk);
      const known = KEYWORD_MAP[keyword.trim().toLowerCase()];
      const isXmp = keyword === 'XML:com.adobe.xmp';
      findings.push({
        id,
        category: isXmp ? 'OTHER' : known?.category ?? 'OTHER',
        label: isXmp ? 'XMP metadata block' : known?.label ?? `Text entry "${clip(keyword)}"`,
        value: isXmp ? `${chunk.data.length} bytes of embedded XMP, which often names the author or the editing tool` : clip(text.trim()),
        container: chunk.type,
        key: `${chunk.type}:${keyword}`,
        removable: true,
      });
      continue;
    }

    if (chunk.type === 'eXIf') {
      const tags = await decodeTags(bytes);
      if (tags.length === 0) {
        findings.push({
          id, category: 'OTHER', label: 'Embedded camera data',
          value: `${chunk.data.length} bytes FilePass can remove but did not decode`,
          container: 'eXIf', key: 'eXIf', removable: true,
        });
      }
      for (const tag of tags) {
        findings.push({
          id: `eXIf#${tag.key}`,
          category: tag.category, label: tag.label, value: tag.value,
          container: 'eXIf', key: tag.key, removable: true,
        });
      }
      continue;
    }

    if (chunk.type === 'tIME') {
      findings.push({
        id, category: 'TIME', label: 'Modified', value: readTime(chunk.data),
        container: 'tIME', key: 'tIME', removable: true,
      });
      continue;
    }

    findings.push({
      id, category: 'OTHER', label: `${chunk.type} data block`,
      value: `${chunk.data.length} bytes FilePass can remove but cannot read`,
      container: chunk.type, key: chunk.type, removable: true,
    });
  }

  if (chunks.some((c) => c.type === 'tRNS') || chunks.some((c) => c.type === 'iCCP')) {
    notes.push('Transparency and colour information are kept so the picture still looks the same.');
  }

  return { format: 'png', byteLength: bytes.length, findings, notes };
}

function readTime(data: Uint8Array): string {
  if (data.length < 7) return `${data.length} bytes`;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${view.getUint16(0)}-${pad(data[2])}-${pad(data[3])} ${pad(data[4])}:${pad(data[5])}:${pad(data[6])}`;
}

export async function clean(bytes: Uint8Array, report: InspectionReport): Promise<CleanResult> {
  const chunks = readChunks(bytes);
  assertOneProfile(chunks);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  const removedContainers = new Set<string>();

  for (const chunk of chunks) {
    if (chunk.type === 'iCCP') {
      const { name, rest } = readProfileChunk(chunk);
      await profileBytes(rest);   // never rewrite a chunk whose profile FilePass cannot vouch for
      if (name && name !== PROFILE_LABEL) {
        const label = Uint8Array.from(PROFILE_LABEL, (ch) => ch.charCodeAt(0));
        parts.push(buildChunk('iCCP', concat([label, Uint8Array.of(0), rest])));
        removedContainers.add('iCCP');
      } else {
        parts.push(bytes.subarray(chunk.start, chunk.end));
      }
      continue;
    }
    if (RENDERING_CHUNKS.has(chunk.type)) {
      parts.push(bytes.subarray(chunk.start, chunk.end));
      continue;
    }
    removedContainers.add(chunk.type);
  }

  const promisedRemovedIds = report.findings
    .filter((f) => f.removable && removedContainers.has(f.container))
    .map((f) => f.id);

  return { bytes: concat(parts), promisedRemovedIds, notes: [] };
}
