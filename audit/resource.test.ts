import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { inspectFile } from '../src/core/pipeline';
import { readChunks } from '../src/core/png';
import { MalformedFileError } from '../src/core/types';
import { fixture, measurement, runBytes as run } from './harness';

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

/** Builds a PNG whose compressed text chunks unpack to the requested sizes. */
function withCompressedText(sizes: number[]): Uint8Array {
  const source = Buffer.from(fixture('clean.png'));
  const idat = readChunks(new Uint8Array(source)).find((c) => c.type === 'IDAT')!;
  const chunks = Buffer.concat(sizes.map((size, i) => chunk('zTXt', Buffer.concat([
    Buffer.from(`text${i}\0\0`, 'latin1'),
    zlib.deflateSync(Buffer.alloc(size, 0x41)),
  ]))));
  return new Uint8Array(Buffer.concat([source.subarray(0, idat.start), chunks, source.subarray(idat.start)]));
}

const MB = 1024 * 1024;

/**
 * The ceiling is a product limit, not a PNG rule: compressed text metadata is small in every
 * real image, and FilePass would rather refuse a file than spend unbounded memory unpacking
 * one. Superseded measurement: this file used to record that ten bombs simply parsed.
 */
describe('phase 12: what a file may ask FilePass to unpack', () => {
  it('a chunk just under the per-chunk ceiling is read normally', async () => {
    const report = await inspectFile(withCompressedText([MB - 1024]));
    expect(report.findings.length).toBe(1);
    expect(report.findings[0].value.length).toBeLessThanOrEqual(160);   // still clipped for display
  }, 60000);

  it('a chunk over the per-chunk ceiling is refused', async () => {
    await expect(inspectFile(withCompressedText([MB + 1024]))).rejects.toBeInstanceOf(MalformedFileError);
  }, 60000);

  it('chunks that are each small but together exceed the file budget are refused', async () => {
    const many = Array.from({ length: 9 }, () => MB - 1024);            // 9 MB against an 8 MB budget
    await expect(inspectFile(withCompressedText(many))).rejects.toBeInstanceOf(MalformedFileError);
  }, 120000);

  it('several chunks within the budget stay readable', async () => {
    const report = await inspectFile(withCompressedText([MB / 2, MB / 2, MB / 2]));
    expect(report.findings.length).toBe(3);
  }, 60000);

  it('a refused file yields no verdict and no download', async () => {
    const hostile = withCompressedText([20 * MB]);
    // the product path starts at inspection, so nothing downstream is ever reached
    await expect(inspectFile(hostile)).rejects.toBeInstanceOf(MalformedFileError);
    const outcome = await run(hostile);
    expect(outcome.verdict).toBeUndefined();
    expect(outcome.downloadable).toBe(false);
    expect(outcome.error).toMatch(/unpacks to more than FilePass will read/);
  }, 60000);

  it('records what the ceiling costs in practice', async () => {
    const hostile = withCompressedText(Array.from({ length: 10 }, () => 20 * MB));
    const started = Date.now();
    const before = process.memoryUsage().heapUsed;
    let outcome = 'parsed';
    try { await inspectFile(hostile); } catch (error) { outcome = (error as Error).constructor.name; }
    // Not a tracked note either: this file is owned by sabotage.test.ts, and appending to a
    // file another test truncates makes the result depend on which of the two ran last.
    measurement(`bomb x10 (~200 MB declared): ${outcome} after ${Date.now() - started} ms, `
      + `heap delta ${((process.memoryUsage().heapUsed - before) / 1e6).toFixed(0)} MB, `
      + `file ${(hostile.length / 1024).toFixed(0)} KB`);
    expect(outcome).toBe('MalformedFileError');
  }, 120000);
});
