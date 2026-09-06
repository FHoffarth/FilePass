/**
 * A refusal has to survive a failed cleanup.
 *
 * inflateBounded cancels the reader before giving up, in two places: when a stream runs past
 * its ceiling, and when the shared budget refuses mid-stream. `cancel()` returns a promise,
 * and the stream spec allows it to reject - the underlying source decides. Against f057067
 * that rejection replaced the refusal, the outer handler saw something that was not a
 * MalformedFileError, and the chunk came back as 'unreadable': merely undecodable text, which
 * FilePass reports and removes. The file was accepted.
 *
 * The fault is injected at the platform boundary, by substituting DecompressionStream with one
 * whose cancel rejects. Nothing in src/ is aware of the test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { inspectFile } from '../src/core/pipeline';
import { readChunks } from '../src/core/png';
import { MalformedFileError } from '../src/core/types';
import { fixture } from './harness';

const crc = (buf: Buffer) => {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c) >>> 0;
};
const mk = (type: string, payload: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), payload]);
  const out = Buffer.alloc(8 + payload.length + 4);
  out.writeUInt32BE(payload.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + payload.length);
  return out;
};
const zText = (i: number) =>
  mk('zTXt', Buffer.concat([Buffer.from(`t${i}\0\0`, 'latin1'), zlib.deflateSync(Buffer.alloc(1024, 0x41))]));
const png = (chunks: Buffer[]) => {
  const s = Buffer.from(fixture('clean.png'));
  const at = readChunks(new Uint8Array(s)).find((c) => c.type === 'IDAT')!.start;
  return new Uint8Array(Buffer.concat([s.subarray(0, at), ...chunks, s.subarray(at)]));
};

const PIECE = 256 * 1024;
const real = globalThis.DecompressionStream;

/** A decompressor that hands over `emit` bytes (or never stops), with a cancel of our choosing. */
function install(emit: number | null, cancel: () => unknown): void {
  class CancelRejects {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    constructor() {
      this.writable = new WritableStream();
      let sent = 0;
      this.readable = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emit !== null && sent >= emit) { controller.close(); return; }
          const size = emit === null ? PIECE : Math.min(PIECE, emit - sent);
          sent += size;
          controller.enqueue(new Uint8Array(size));
        },
        cancel,
      });
    }
  }
  (globalThis as any).DecompressionStream = CancelRejects;
}

const rejects = () => Promise.reject(new Error('the reader could not be cancelled'));

afterEach(() => { (globalThis as any).DecompressionStream = real; });

describe('a failed cancel cannot turn a refusal into acceptance', () => {
  it('the older path: a stream running past its ceiling stays a refusal', async () => {
    install(null, rejects);                        // never ends, so the ceiling decides
    await expect(inspectFile(png([zText(0)]))).rejects.toBeInstanceOf(MalformedFileError);
  }, 60000);

  it('the budget path: a refusal mid-stream stays a refusal', async () => {
    install(900 * 1024, rejects);                  // under the single-chunk ceiling
    // ten of them run the shared text budget past 8 MiB, and the budget throws mid-stream
    await expect(inspectFile(png(Array.from({ length: 10 }, (_, i) => zText(i)))))
      .rejects.toBeInstanceOf(MalformedFileError);
  }, 60000);

  it('says why it refused, rather than reporting the cleanup failure', async () => {
    install(900 * 1024, rejects);
    await expect(inspectFile(png(Array.from({ length: 10 }, (_, i) => zText(i)))))
      .rejects.toThrow(/unpacks to more than FilePass will read/);
  }, 60000);

  it('a cancel that throws where it stands is no different', async () => {
    install(null, () => { throw new Error('the reader threw on cancel'); });
    await expect(inspectFile(png([zText(0)]))).rejects.toBeInstanceOf(MalformedFileError);
  }, 60000);

  it('a cancel that never settles cannot hold the answer back', async () => {
    // Nothing waits on cancellation, so a source that simply never replies is not a way to
    // leave a file undecided. Against f057067 this hung until the test timed out.
    install(null, () => new Promise(() => {}));
    const answer = await Promise.race([
      inspectFile(png([zText(0)])).then(() => 'accepted', (e) => (e as Error).constructor.name),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 500)),
    ]);
    expect(answer).toBe('MalformedFileError');
  }, 60000);

  it('a cancel that works is unaffected', async () => {
    // the real decompressor, one oversized chunk: the refusal was never in doubt here
    await expect(inspectFile(png([
      mk('zTXt', Buffer.concat([Buffer.from('big\0\0', 'latin1'), zlib.deflateSync(Buffer.alloc(2 * 1024 * 1024, 0x41))])),
    ]))).rejects.toBeInstanceOf(MalformedFileError);
  }, 60000);
});
