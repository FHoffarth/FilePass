/**
 * The unpacking budget has to be charged for what the reader actually produced, not only for
 * streams that finish. Against 570908d a truncated stream delivered close to a megabyte and
 * then failed, and those bytes were never counted: twelve such chunks in an 11 kB file made
 * FilePass unpack about 11 MB against an 8 MB budget and still accept the file.
 */
import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { inspectFile } from '../src/core/pipeline';
import { readChunks } from '../src/core/png';
import { MalformedFileError } from '../src/core/types';
import { fixture, runBytes } from './harness';

const crc = (buf: Buffer) => {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c) >>> 0;
};
const chunk = (type: string, payload: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), payload]);
  const out = Buffer.alloc(8 + payload.length + 4);
  out.writeUInt32BE(payload.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + payload.length);
  return out;
};
function png(chunks: Buffer[]): Uint8Array {
  const source = Buffer.from(fixture('clean.png'));
  const idat = readChunks(new Uint8Array(source)).find((c) => c.type === 'IDAT')!;
  return new Uint8Array(Buffer.concat([source.subarray(0, idat.start), ...chunks, source.subarray(idat.start)]));
}

const MB = 1024 * 1024;
/** A stream that hands over most of its bytes and then dies on a missing tail. */
const truncated = (i: number, size: number) => {
  const whole = zlib.deflateSync(Buffer.alloc(size, 0x41));
  return chunk('zTXt', Buffer.concat([Buffer.from(`t${i}\0\0`, 'latin1'), whole.subarray(0, whole.length - 6)]));
};
const intact = (i: number, size: number) =>
  chunk('zTXt', Buffer.concat([Buffer.from(`k${i}\0\0`, 'latin1'), zlib.deflateSync(Buffer.alloc(size, 0x41))]));

describe('the unpacking budget counts what was read, not what completed', () => {
  it('twelve truncated streams cannot spend eleven megabytes against an eight megabyte budget', async () => {
    const hostile = png(Array.from({ length: 12 }, (_, i) => truncated(i, 900 * 1024)));
    expect(hostile.length, 'a small file asking for a lot').toBeLessThan(64 * 1024);
    await expect(inspectFile(hostile)).rejects.toBeInstanceOf(MalformedFileError);

    const outcome = await runBytes(hostile, 'truncated-streams.png');
    expect(outcome.verdict).toBeUndefined();
    expect(outcome.downloadable).toBe(false);
    expect(outcome.error).toMatch(/unpacks to more than FilePass will read/);
  }, 120000);

  it('mixing intact and truncated streams does not reset the count either', async () => {
    const hostile = png([intact(0, MB), ...Array.from({ length: 9 }, (_, i) => truncated(i, 900 * 1024))]);
    await expect(inspectFile(hostile)).rejects.toBeInstanceOf(MalformedFileError);
  }, 120000);

  it('a broken stream inside the budget is still reported and removed', async () => {
    const bytes = png([truncated(0, 64 * 1024)]);
    const outcome = await runBytes(bytes, 'one-broken-stream.png');
    expect(outcome.findings!.length).toBeGreaterThan(0);
    expect(outcome.verdict).toBe('verified');
    expect(readChunks(outcome.output!).some((c) => c.type === 'zTXt')).toBe(false);
    expect(outcome.verification!.outputReport.findings).toEqual([]);
  }, 60000);

  it('ordinary files are unaffected, and the budget still admits exactly eight megabytes', async () => {
    const eight = png(Array.from({ length: 8 }, (_, i) => intact(i, MB)));
    const report = await inspectFile(eight);
    expect(report.findings.length).toBe(8);
    await expect(inspectFile(png([...Array.from({ length: 8 }, (_, i) => intact(i, MB)), intact(8, 1)])))
      .rejects.toBeInstanceOf(MalformedFileError);
  }, 180000);
});
