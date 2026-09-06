import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { cleanFile, inspectFile } from '../src/core/pipeline';
import { readChunks } from '../src/core/png';
import { MalformedFileError } from '../src/core/types';
import { fixture, runBytes } from './harness';

const crc = (buf: Buffer): number => {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
};

const makeChunk = (type: string, payload: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), payload]);
  const out = Buffer.alloc(8 + payload.length + 4);
  out.writeUInt32BE(payload.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), 8 + payload.length);
  return out;
};

const makeIccChunk = (decompressedSize: number, name = 'custom'): Buffer => {
  const iccBuf = Buffer.alloc(decompressedSize, 0);
  iccBuf.writeUInt32BE(decompressedSize, 0);
  iccBuf.set(Buffer.from('acsp', 'latin1'), 36);

  const compressedIcc = zlib.deflateSync(iccBuf);
  return makeChunk('iCCP', Buffer.concat([
    Buffer.from(`${name}\0`, 'latin1'),
    Buffer.from([0]),
    compressedIcc,
  ]));
};

const makeZtxtChunk = (decompressedSize: number, keyword = 'comment'): Buffer => {
  const textBuf = Buffer.alloc(decompressedSize, 0x41);
  const compressedText = zlib.deflateSync(textBuf);
  return makeChunk('zTXt', Buffer.concat([
    Buffer.from(`${keyword}\0\0`, 'latin1'),
    compressedText,
  ]));
};

const insertChunks = (basePng: Uint8Array, chunks: Buffer[]): Uint8Array => {
  const source = Buffer.from(basePng);
  const idat = readChunks(new Uint8Array(source)).find((c) => c.type === 'IDAT')!;
  return new Uint8Array(Buffer.concat([
    source.subarray(0, idat.start),
    ...chunks,
    source.subarray(idat.start),
  ]));
};

describe('shared decompression resource budget', () => {
  const base = fixture('clean.png');

  it('text alone under limit (8 MiB ok)', async () => {
    // 8 chunks of 1 MiB each = 8 MiB text
    const chunks = Array.from({ length: 8 }, (_, i) => makeZtxtChunk(1024 * 1024, `txt${i}`));
    const png = insertChunks(base, chunks);
    const report = await inspectFile(png);
    expect(report.format).toBe('png');
    expect(report.findings.filter((f) => f.container === 'zTXt')).toHaveLength(8);
  }, 30000);

  it('ICC alone under limit (16 MiB ok)', async () => {
    // 1 ICC profile of 16 MiB
    const icc = makeIccChunk(16 * 1024 * 1024);
    const png = insertChunks(base, [icc]);
    const report = await inspectFile(png);
    expect(report.format).toBe('png');
    expect(report.findings.some((f) => f.container === 'iCCP-profile')).toBe(true);
  }, 30000);

  it('text + ICC together under total limit (8 MiB text + 8 MiB ICC = 16 MiB ok)', async () => {
    const icc = makeIccChunk(8 * 1024 * 1024);
    const textChunks = Array.from({ length: 8 }, (_, i) => makeZtxtChunk(1024 * 1024, `txt${i}`));
    const png = insertChunks(base, [icc, ...textChunks]);
    const report = await inspectFile(png);
    expect(report.format).toBe('png');
    expect(report.findings.filter((f) => f.container === 'zTXt')).toHaveLength(8);
    expect(report.findings.some((f) => f.container === 'iCCP-profile')).toBe(true);
  }, 30000);

  it('text + ICC together over total limit (8 MiB text + 8.1 MiB ICC refused with MalformedFileError)', async () => {
    // 8 MiB text + 8.1 MiB ICC = 16.1 MiB (> 16 MiB total)
    const icc = makeIccChunk(8 * 1024 * 1024 + 100 * 1024);
    const textChunks = Array.from({ length: 8 }, (_, i) => makeZtxtChunk(1024 * 1024, `txt${i}`));
    const png = insertChunks(base, [icc, ...textChunks]);

    await expect(inspectFile(png)).rejects.toThrow(MalformedFileError);
    await expect(inspectFile(png)).rejects.toThrow(
      'The metadata in this image unpacks to more than FilePass will read, so it will not vouch for it.'
    );
  }, 30000);

  it('text over 8 MiB alone refused (even without ICC)', async () => {
    // 9 chunks of 1 MiB = 9 MiB (> 8 MiB text budget)
    const textChunks = Array.from({ length: 9 }, (_, i) => makeZtxtChunk(1024 * 1024, `txt${i}`));
    const png = insertChunks(base, textChunks);

    await expect(inspectFile(png)).rejects.toThrow(MalformedFileError);
    await expect(inspectFile(png)).rejects.toThrow(
      'The text in this image unpacks to more than FilePass will read, so it will not vouch for it.'
    );
  }, 30000);

  it('text chunk over 1 MiB refused', async () => {
    // Single chunk unpacking to 1.1 MiB (> 1 MiB single chunk ceiling)
    const largeChunk = makeZtxtChunk(1024 * 1024 + 100 * 1024, 'large');
    const png = insertChunks(base, [largeChunk]);

    await expect(inspectFile(png)).rejects.toThrow(MalformedFileError);
    await expect(inspectFile(png)).rejects.toThrow(
      'The text in this image unpacks to more than FilePass will read, so it will not vouch for it.'
    );
  }, 30000);

  it('multiple chunks cumulative refusal', async () => {
    // 17 chunks of 500 KB = 8.5 MiB (> 8 MiB text budget)
    const textChunks = Array.from({ length: 17 }, (_, i) => makeZtxtChunk(500 * 1024, `txt${i}`));
    const png = insertChunks(base, textChunks);

    await expect(inspectFile(png)).rejects.toThrow(MalformedFileError);
    await expect(inspectFile(png)).rejects.toThrow(
      'The text in this image unpacks to more than FilePass will read, so it will not vouch for it.'
    );
  }, 30000);

  it('corrupt/broken streams inside budget handled gracefully', async () => {
    // Truncated deflate stream that unpacks 50 KB then ends abruptly
    const textBuf = Buffer.alloc(50 * 1024, 0x42);
    const compressed = zlib.deflateSync(textBuf);
    const truncatedCompressed = compressed.subarray(0, compressed.length - 10);
    const brokenChunk = makeChunk('zTXt', Buffer.concat([
      Buffer.from('broken\0\0', 'latin1'),
      truncatedCompressed,
    ]));

    const png = insertChunks(base, [brokenChunk]);
    const report = await inspectFile(png);
    expect(report.format).toBe('png');
    const brokenFinding = report.findings.find((f) => f.container === 'zTXt');
    expect(brokenFinding).toBeDefined();
    expect(brokenFinding?.value).toBe('compressed text FilePass can remove but did not decode');
  });

  it('failed decompression after partial consumption charges the budget', async () => {
    // 8 broken zTXt chunks that each produce ~950 KB before truncating
    // Total partially decompressed ~ 7.6 MiB
    const brokenChunks = Array.from({ length: 8 }, (_, i) => {
      const textBuf = Buffer.alloc(950 * 1024, 0x43);
      const compressed = zlib.deflateSync(textBuf);
      // Truncate last 15 bytes to force decompression error at end of stream
      const truncated = compressed.subarray(0, compressed.length - 15);
      return makeChunk('zTXt', Buffer.concat([
        Buffer.from(`broken${i}\0\0`, 'latin1'),
        truncated,
      ]));
    });

    // 9th valid chunk of 900 KB.
    // If broken chunks were free, 0 + 900 KB <= 8 MiB (would pass).
    // Because broken chunks charged ~7.6 MiB, 7.6 MiB + 900 KB > 8 MiB (refused).
    const finalValidChunk = makeZtxtChunk(900 * 1024, 'final');

    const png = insertChunks(base, [...brokenChunks, finalValidChunk]);
    await expect(inspectFile(png)).rejects.toThrow(MalformedFileError);
    await expect(inspectFile(png)).rejects.toThrow(
      'The text in this image unpacks to more than FilePass will read, so it will not vouch for it.'
    );
  }, 30000);

  /**
   * The case this fix was written for, kept as a regression: against 71f320b a 23 KiB PNG
   * unpacked to about 22.5 MiB of metadata and was accepted, and the clean copy verified.
   */
  it('the reported adversarial file - 15 MiB ICC plus 7.5 MiB text - is refused end to end', async () => {
    const png = insertChunks(base, [
      makeIccChunk(15 * 1024 * 1024),
      ...Array.from({ length: 8 }, (_, i) => makeZtxtChunk(960 * 1024, `txt${i}`)),
    ]);
    expect(png.length, 'a small file asking for a lot').toBeLessThan(64 * 1024);

    await expect(inspectFile(png)).rejects.toThrow(
      'The metadata in this image unpacks to more than FilePass will read, so it will not vouch for it.',
    );

    // and through the product path, where the refusal has to end in no verdict and no download
    const outcome = await runBytes(png, 'metadata-bomb.png');
    expect(outcome.verdict).toBeUndefined();
    expect(outcome.downloadable).toBe(false);
    expect(outcome.error).toMatch(/unpacks to more than FilePass will read/);
  }, 60000);

  it('the shared budget does not depend on which of the two comes first', async () => {
    const text = () => Array.from({ length: 8 }, (_, i) => makeZtxtChunk(1024 * 1024, `txt${i}`));
    // 8 MiB text + 8.5 MiB ICC = 16.5 MiB either way round
    const iccFirst = insertChunks(base, [makeIccChunk(8 * 1024 * 1024 + 512 * 1024), ...text()]);
    const textFirst = insertChunks(base, [...text(), makeIccChunk(8 * 1024 * 1024 + 512 * 1024)]);

    for (const [name, png] of [['ICC first', iccFirst], ['text first', textFirst]] as const) {
      await expect(inspectFile(png), name).rejects.toThrow(
        'The metadata in this image unpacks to more than FilePass will read, so it will not vouch for it.',
      );
    }
  }, 60000);

  it('an ICC that fills the whole budget leaves no room for even a small text chunk', async () => {
    // Neither ceiling is breached on its own: the profile is under 16 MiB and the text is
    // far under 8 MiB. Only the shared total refuses this.
    const png = insertChunks(base, [makeIccChunk(16 * 1024 * 1024 - 4096), makeZtxtChunk(64 * 1024, 'small')]);
    await expect(inspectFile(png)).rejects.toThrow(
      'The metadata in this image unpacks to more than FilePass will read, so it will not vouch for it.',
    );
  }, 60000);

  /**
   * What the cleaner can and cannot do here. It never inflates text - it drops those chunks
   * whole - so the shared total cannot bind on this path, and the budget threaded into
   * clean() is future-proofing rather than a second enforced gate. What it does enforce is
   * the profile ceiling: a colour profile FilePass cannot vouch for is never rewritten.
   */
  it('the cleaner still refuses a profile it cannot vouch for, so cleaning is not a way round', async () => {
    const png = insertChunks(base, [makeIccChunk(16 * 1024 * 1024 + 100 * 1024)]);
    const report = { format: 'png' as const, byteLength: png.length, findings: [], notes: [] };
    await expect(cleanFile(png, report)).rejects.toThrow(MalformedFileError);
  }, 60000);

  it('the cleaner does not decompress text at all, which is why the total cannot bind there', async () => {
    // 8 MiB of text plus a profile that on its own is within every ceiling. Inspection
    // refuses it on the shared total; the cleaner, asked directly, only reads the profile.
    const png = insertChunks(base, [
      makeIccChunk(15 * 1024 * 1024),
      ...Array.from({ length: 8 }, (_, i) => makeZtxtChunk(960 * 1024, `txt${i}`)),
    ]);
    await expect(inspectFile(png)).rejects.toThrow(MalformedFileError);

    const report = { format: 'png' as const, byteLength: png.length, findings: [], notes: [] };
    await expect(cleanFile(png, report), 'documented, not desired: the cleaner sees only the profile')
      .resolves.toBeTruthy();
  }, 60000);
});
