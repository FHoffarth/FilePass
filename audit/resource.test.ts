import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { inspectFile } from '../src/core/pipeline';
import { readChunks } from '../src/core/png';
import { fixture } from './harness';

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

describe('phase 12: hostile but size-legal input', () => {
  it('measures many decompression bombs in one PNG', async () => {
    const source = Buffer.from(fixture('clean.png'));
    const chunks = readChunks(new Uint8Array(source));
    const idat = chunks.find((c) => c.type === 'IDAT')!;
    const bomb = zlib.deflateSync(Buffer.alloc(20 * 1024 * 1024, 0x41));
    const bombs = Buffer.concat(Array.from({ length: 10 }, (_, i) => chunk('zTXt', Buffer.concat([Buffer.from(`bomb${i}\0\0`, 'latin1'), bomb]))));
    const hostile = new Uint8Array(Buffer.concat([source.subarray(0, idat.start), bombs, source.subarray(idat.start)]));

    const started = Date.now();
    const before = process.memoryUsage().heapUsed;
    const report = await inspectFile(hostile);
    const line = `bomb x10: file ${(hostile.length / 1024).toFixed(0)} KB expands to ~200 MB, parsed in ${Date.now() - started} ms, ` +
      `findings ${report.findings.length}, heap delta ${((process.memoryUsage().heapUsed - before) / 1e6).toFixed(0)} MB, ` +
      `longest displayed value ${Math.max(...report.findings.map((f) => f.value.length))} chars`;
    appendFileSync('audit/sabotage-notes.txt', line + '\n');
    expect(report.findings.length).toBe(10);
  }, 300000);
});
