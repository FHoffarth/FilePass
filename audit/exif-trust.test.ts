import { describe, expect, it } from 'vitest';
import { fixture, contains } from './harness';
import { classify, readSegments } from '../src/core/jpeg';
import { inspectFile, cleanAndVerify } from '../src/core/pipeline';
import { assessExif } from '../src/core/exif';

const CANARY = 'PRIVATE_CANARY_1234';
type Entry = [tag: number, type: number, count: number, value: number];

// All offsets below are explicit, hand-calculated TIFF offsets, not accountant output.
function tiff(little: boolean, size: number) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  const word = (at: number, value: number) => view.setUint16(at, value, little);
  const long = (at: number, value: number) => view.setUint32(at, value, little);
  bytes.set(little ? [73, 73] : [77, 77]);
  word(2, 42); long(4, 8);
  const ifd = (at: number, entries: Entry[], next = 0) => {
    word(at, entries.length);
    [...entries].sort((a, b) => a[0] - b[0]).forEach(([tag, type, count, value], i) => {
      const p = at + 2 + i * 12;
      word(p, tag); word(p + 2, type); long(p + 4, count); long(p + 8, value);
    });
    long(at + 2 + entries.length * 12, next);
  };
  const text = (at: number, value: string) => bytes.set(new TextEncoder().encode(value), at);
  const orientation: Entry = [0x112, 3, 1, little ? 6 : 6 * 65536];
  return { bytes, word, long, ifd, text, orientation };
}

function jpeg(tiffBytes: Uint8Array, terminator = 0): Uint8Array {
  const base = fixture('x_exif_orientation_only.jpg');
  const segment = readSegments(base).find(s => classify(s).name === 'APP1/EXIF')!;
  const app = new Uint8Array(10 + tiffBytes.length);
  app.set([255, 225]); new DataView(app.buffer).setUint16(2, app.length - 2);
  app.set([69, 120, 105, 102, 0, terminator], 4); app.set(tiffBytes, 10);
  const out = new Uint8Array(base.length - (segment.end - segment.start) + app.length);
  out.set(base.subarray(0, segment.start)); out.set(app, segment.start);
  out.set(base.subarray(segment.end), segment.start + app.length);
  return out;
}

async function disclosedAndCleaned(source: Uint8Array) {
  const before = await inspectFile(source);
  expect(before.findings.map(f => f.label)).toContain('Embedded camera data');
  const { cleaned, verification } = await cleanAndVerify(source, before);
  expect(verification.verdict).toBe('verified');
  expect((await inspectFile(cleaned.bytes)).findings).toEqual([]);
  expect(contains(cleaned.bytes, CANARY)).toBe(false);
  const original = readSegments(source).find(s => classify(s).name === 'APP1/EXIF')!.payload!;
  for (const s of readSegments(cleaned.bytes).filter(s => classify(s).name === 'APP1/EXIF')) {
    expect(s.payload).not.toEqual(original);
    expect(s.payload).toHaveLength(32);
  }
}

describe.each([false, true])('EXIF trust, little endian = %s', little => {
  it('reports and removes the ASCII Orientation canary through the real pipeline', async () => {
    const t = tiff(little, 45); t.ifd(8, [[0x112, 2, 19, 26]]); t.text(26, CANARY);
    const source = jpeg(t.bytes);
    expect(contains(source, CANARY)).toBe(true);
    await disclosedAndCleaned(source);
  });

  it.each([0, 0x8769, 0x8825, 0xa005])('reports directory cycle through pointer %s', async tag => {
    const t = tiff(little, tag ? 38 : 26);
    t.ifd(8, tag ? [t.orientation, [tag, 4, 1, 8]] : [t.orientation], tag ? 0 : 8);
    await disclosedAndCleaned(jpeg(t.bytes));
  });

  it.each([0, 8, 10])('rejects value overlap with header/directory at %s', async at => {
    const t = tiff(little, 38); t.ifd(8, [t.orientation, [0x11a, 5, 1, at]]);
    await disclosedAndCleaned(jpeg(t.bytes));
  });

  it.each([0, 9, 65535])('refuses invalid Orientation value %s without rewriting it', async value => {
    const t = tiff(little, 26); t.ifd(8, [[0x112, 3, 1, little ? value : value * 65536]]);
    await disclosedAndCleaned(jpeg(t.bytes));
  });

  it.each([[3, 0], [4, 1], [3, 2], [13, 1]])('refuses Orientation type/count %s/%s', async (type, count) => {
    const t = tiff(little, 26); t.ifd(8, [[0x112, type, count, 6]]);
    await disclosedAndCleaned(jpeg(t.bytes));
  });

  it('keeps valid scalar Orientation unreported and preserves its value on cleaning', async () => {
    const t = tiff(little, 26); t.ifd(8, [t.orientation]);
    const report = await inspectFile(jpeg(t.bytes));
    expect(report.findings).toEqual([]);
    expect(report.notes.join(' ')).toMatch(/right way up/);
    const { cleaned, verification } = await cleanAndVerify(jpeg(t.bytes), report);
    expect(verification.verdict).toBe('verified');
    const output = readSegments(cleaned.bytes).find(s => classify(s).name === 'APP1/EXIF')!.payload!;
    expect(new DataView(output.buffer, output.byteOffset).getUint16(24)).toBe(6);
  });

  it('reports ordinary out-of-line Author without an unnecessary generic finding', async () => {
    const t = tiff(little, 44); t.ifd(8, [t.orientation, [0x13b, 2, 6, 38]]); t.text(38, 'Alice\0');
    const report = await inspectFile(jpeg(t.bytes));
    expect(report.findings.map(f => [f.label, f.value])).toEqual([['Author', 'Alice']]);
  });

  it('accepts a real alignment zero between an odd-sized value and the next even value', async () => {
    const t = tiff(little, 62);
    t.ifd(8, [t.orientation, [0x10f, 2, 5, 50], [0x13b, 2, 6, 56]]);
    t.text(50, 'Acme\0'); t.text(56, 'Alice\0');
    const report = await inspectFile(jpeg(t.bytes));
    expect(report.findings.map(f => f.label).sort()).toEqual(['Author', 'Camera manufacturer']);
    t.bytes[55] = 88;
    await disclosedAndCleaned(jpeg(t.bytes));
  });

  it('does not treat a terminal zero as alignment before a nonexistent structure', async () => {
    const t = tiff(little, 27); t.ifd(8, [t.orientation]);
    await disclosedAndCleaned(jpeg(t.bytes));
  });

  it('accepts shared, identically typed rational values without conflicting ownership', async () => {
    const t = tiff(little, 58);
    t.ifd(8, [t.orientation, [0x11a, 5, 1, 50], [0x11b, 5, 1, 50]]);
    t.long(50, 72); t.long(54, 1);
    expect((await inspectFile(jpeg(t.bytes))).findings).toEqual([]);
  });

  it('refuses partial overlap of independently declared values', async () => {
    const t = tiff(little, 62);
    t.ifd(8, [t.orientation, [0x11a, 5, 1, 50], [0x11b, 5, 1, 54]]);
    t.long(50, 72); t.long(54, 1); t.long(58, 1);
    await disclosedAndCleaned(jpeg(t.bytes));
  });

  it('accepts valid next-IFD, Exif/GPS/Interop directories and discloses their content', async () => {
    const t = tiff(little, 134);
    t.ifd(8, [t.orientation, [0x8769, 4, 1, 50], [0x8825, 4, 1, 98]], 116);
    t.ifd(50, [[0xa001, 3, 1, little ? 1 : 65536], [0xa005, 4, 1, 80]]);
    t.ifd(80, [[1, 2, 4, little ? 0x00383952 : 0x52393800]]); // InteroperabilityIndex R98\0
    t.ifd(98, [[0, 1, 4, little ? 0x00000302 : 0x02030000]]); // GPSVersionID 2.3.0.0
    t.ifd(116, [t.orientation]);
    const source = jpeg(t.bytes);
    const payload = readSegments(source).find(s => classify(s).name === 'APP1/EXIF')!.payload!;
    expect(assessExif(payload).status).toBe('valid');
    await disclosedAndCleaned(source);
  });

  it('accepts two acyclic references to the same compatible directory', async () => {
    const t = tiff(little, 86);
    t.ifd(8, [t.orientation, [0x8769, 4, 1, 68]], 38);
    t.ifd(38, [t.orientation, [0x8769, 4, 1, 68]]);
    t.ifd(68, [[0xa001, 3, 1, little ? 1 : 65536]]);
    expect((await inspectFile(jpeg(t.bytes))).findings).toEqual([]);
  });

  it.each([0x8769, 0x8825, 0xa005])('refuses malformed pointer representation %s', async tag => {
    const t = tiff(little, 38); t.ifd(8, [t.orientation, [tag, 3, 0, 0]]);
    await disclosedAndCleaned(jpeg(t.bytes));
  });

  it('rejects range arithmetic beyond the APP1 boundary', async () => {
    const t = tiff(little, 26); t.ifd(8, [[0x11a, 5, 0xffffffff, 0xfffffff0]]);
    await disclosedAndCleaned(jpeg(t.bytes));
  });

  it('does not skip a nonzero second EXIF identifier terminator', async () => {
    const t = tiff(little, 26); t.ifd(8, [t.orientation]);
    await disclosedAndCleaned(jpeg(t.bytes, 88));
  });

  it('discloses a declared thumbnail even if no metadata is semantically decoded', async () => {
    const thumbnail = fixture('clean.jpg');
    const t = tiff(little, 50 + thumbnail.length);
    t.ifd(8, [t.orientation, [0x201, 4, 1, 50], [0x202, 4, 1, thumbnail.length]]);
    t.bytes.set(thumbnail, 50);
    await disclosedAndCleaned(jpeg(t.bytes));
  });

  it('does not trust non-image canary bytes merely declared as a thumbnail', async () => {
    const t = tiff(little, 69);
    t.ifd(8, [t.orientation, [0x201, 4, 1, 50], [0x202, 4, 1, 19]]); t.text(50, CANARY);
    await disclosedAndCleaned(jpeg(t.bytes));
  });

  it('discloses content in a directory the semantic decoder does not report', async () => {
    const t = tiff(little, 57); t.ifd(8, [t.orientation], 26);
    t.ifd(26, [[0x13b, 2, 13, 44]]); t.text(44, 'SECOND_OWNER\0');
    const report = await inspectFile(jpeg(t.bytes));
    expect(report.findings.length).toBeGreaterThan(0);
    const { cleaned, verification } = await cleanAndVerify(jpeg(t.bytes), report);
    expect(verification.verdict).toBe('verified');
    expect(contains(cleaned.bytes, 'SECOND_OWNER')).toBe(false);
  });

  it('refuses a TIFF without an IFD or with an empty IFD', async () => {
    const t = tiff(little, 14); t.ifd(8, []);
    await disclosedAndCleaned(jpeg(t.bytes));
    t.long(4, 0);
    await disclosedAndCleaned(jpeg(t.bytes.subarray(0, 8)));
  });

  it('refuses unsorted or duplicate tags rather than trusting decoder selection', async () => {
    const t = tiff(little, 38); t.ifd(8, [t.orientation, [0x128, 3, 1, little ? 2 : 2 * 65536]]);
    const firstEntry = t.bytes.slice(10, 22);
    t.bytes.copyWithin(10, 22, 34); t.bytes.set(firstEntry, 22);
    await disclosedAndCleaned(jpeg(t.bytes));
    t.word(10, 0x112);
    await disclosedAndCleaned(jpeg(t.bytes));
  });

  it('does not omit nonzero unused bytes in an inline rendering value', async () => {
    const t = tiff(little, 26); t.ifd(8, [t.orientation]);
    t.bytes[20] = 88; t.bytes[21] = 89;
    await disclosedAndCleaned(jpeg(t.bytes));
  });

  it('does not conflate content or conflicting orientations from distinct APP1 blocks', async () => {
    const first = tiff(little, 26); first.ifd(8, [first.orientation]);
    const second = tiff(little, 26); second.ifd(8, [[0x112, 3, 1, little ? 8 : 8 * 65536]]);
    const a = jpeg(first.bytes); const b = jpeg(second.bytes);
    const s = readSegments(b).find(s => classify(s).name === 'APP1/EXIF')!;
    const combined = new Uint8Array(a.length + s.end - s.start);
    combined.set(a.subarray(0, 2)); combined.set(b.subarray(s.start, s.end), 2);
    combined.set(a.subarray(2), 2 + s.end - s.start);
    await disclosedAndCleaned(combined);
  });

  it('does not use pointer exemptions in an incompatible directory namespace', async () => {
    const t = tiff(little, 74);
    t.ifd(8, [t.orientation, [0x8769, 4, 1, 38]]);
    t.ifd(38, [[0x8769, 4, 1, 56]]); // ExifIFDPointer belongs in the image IFD, not Exif IFD.
    t.ifd(56, [[0xa001, 3, 1, little ? 1 : 65536]]);
    await disclosedAndCleaned(jpeg(t.bytes));
  });

  it('allows exact sharing of a declared thumbnail while still disclosing the image', async () => {
    const thumbnail = fixture('clean.jpg');
    const t = tiff(little, 80 + thumbnail.length);
    const tags: Entry[] = [[0x201, 4, 1, 80], [0x202, 4, 1, thumbnail.length]];
    t.ifd(8, [t.orientation, ...tags], 50); t.ifd(50, tags);
    t.bytes.set(thumbnail, 80);
    const source = jpeg(t.bytes);
    const payload = readSegments(source).find(s => classify(s).name === 'APP1/EXIF')!.payload!;
    expect(assessExif(payload).status).toBe('valid');
    await disclosedAndCleaned(source);
  });
});
