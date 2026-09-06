import { describe, expect, it, vi } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { inspectFile, verifyClean, cleanAndVerify } from '../src/core/pipeline';
import { MAX_BYTES, sniffFormat } from '../src/core/sniff';
import { FileTooLargeError, MalformedFileError, UnsupportedFileError } from '../src/core/types';
import { fixture, measurement } from './harness';

const notes: string[] = [];
const note = (line: string) => notes.push(line);
writeFileSync('audit/sabotage-notes.txt', '');
const flush = () => appendFileSync('audit/sabotage-notes.txt', notes.splice(0).join('\n') + '\n');

describe('phase 8: cleaner and verifier sabotage', () => {
  it('1. cleaner returns the original dirty bytes', async () => {
    const source = fixture('dirty.jpg');
    const report = await inspectFile(source);
    const result = await verifyClean(report, { bytes: source, promisedRemovedIds: report.findings.map((f) => f.id), notes: [] });
    note(`1. verdict=${result.verdict} surviving=${result.survivingFindings.length} removed=${result.removedIds.length}`);
    expect(result.verdict).toBe('partial');
    expect(result.removedIds).toEqual([]);
  });

  it('2. cleaner removes only some of what it promised', async () => {
    const source = fixture('dirty.png');
    const report = await inspectFile(source);
    // hand-built half clean output: keep one tEXt chunk, drop the rest
    const { readChunks } = await import('../src/core/png');
    const chunks = readChunks(source);
    const keep = chunks.filter((c) => ['IHDR', 'IDAT', 'IEND'].includes(c.type) || c.type === 'tEXt');
    const parts = [source.subarray(0, 8), ...keep.map((c) => source.subarray(c.start, c.end))];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const half = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) { half.set(p, offset); offset += p.length; }

    const result = await verifyClean(report, { bytes: half, promisedRemovedIds: report.findings.map((f) => f.id), notes: [] });
    note(`2. verdict=${result.verdict} surviving=${result.survivingFindings.map((f) => f.label).join(',')}`);
    expect(result.verdict).toBe('partial');
    expect(result.survivingFindings.length).toBeGreaterThan(0);
  });

  it('3. cleaner adds new metadata that was not in the source', async () => {
    const report = await inspectFile(fixture('clean.png'));
    const result = await verifyClean(report, { bytes: fixture('dirty.png'), promisedRemovedIds: [], notes: [] });
    note(`3. verdict=${result.verdict} introduced=${result.introducedFindings.length}`);
    expect(result.verdict).toBe('partial');
    expect(result.introducedFindings.length).toBeGreaterThan(0);
  });

  it('7. cleaner produces malformed output', async () => {
    const report = await inspectFile(fixture('dirty.jpg'));
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x01]);
    await expect(verifyClean(report, { bytes: broken, promisedRemovedIds: ['x'], notes: [] }))
      .rejects.toBeInstanceOf(MalformedFileError);
    note('7. malformed output throws out of verifyClean, no verdict is produced');
  });

  it('8. cleaner returns empty bytes', async () => {
    const report = await inspectFile(fixture('dirty.jpg'));
    await expect(verifyClean(report, { bytes: new Uint8Array(), promisedRemovedIds: ['x'], notes: [] }))
      .rejects.toBeInstanceOf(UnsupportedFileError);
    note('8. empty output throws out of verifyClean');
  });

  it('9. output parses as a different format than the source', async () => {
    const report = await inspectFile(fixture('dirty.jpg'));
    const result = await verifyClean(report, { bytes: fixture('dirty.png'), promisedRemovedIds: report.findings.map((f) => f.id), notes: [] });
    note(`9. jpeg source, png output: verdict=${result.verdict} outputFormat=${result.outputReport.format} introduced=${result.introducedFindings.length}`);
    expect(result.verdict).toBe('partial');
  });

  it('flushes notes', () => { flush(); expect(true).toBe(true); });
});

describe('phase 8: independent PDF verifier sabotage', () => {
  it('5. second opinion reports failure with no leftovers -> unverified', async () => {
    vi.resetModules();
    vi.doMock('../src/core/verify-pdf', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/core/verify-pdf')>()),
      independentPdfCheck: async () => ({ ok: false, leftovers: [], reason: 'simulated outage' }),
    }));
    const pipeline = await import('../src/core/pipeline');
    const source = fixture('dirty.pdf');
    const report = await pipeline.inspectFile(source);
    const { verification } = await pipeline.cleanAndVerify(source, report);
    appendFileSync('audit/sabotage-notes.txt', `5. verdict=${verification.verdict}\n`);
    expect(verification.verdict).toBe('unverified');
    vi.doUnmock('../src/core/verify-pdf');
    vi.resetModules();
  });

  it('6. second opinion throws -> the failure propagates, no verdict', async () => {
    vi.resetModules();
    vi.doMock('../src/core/verify-pdf', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/core/verify-pdf')>()),
      independentPdfCheck: async () => { throw new Error('verifier exploded'); },
    }));
    const pipeline = await import('../src/core/pipeline');
    const source = fixture('dirty.pdf');
    const report = await pipeline.inspectFile(source);
    await expect(pipeline.cleanAndVerify(source, report)).rejects.toThrow(/exploded/);
    appendFileSync('audit/sabotage-notes.txt', '6. thrown verifier propagates as an error, never verified\n');
    vi.doUnmock('../src/core/verify-pdf');
    vi.resetModules();
  });

  it('5b. second opinion reports leftovers -> partial, and they are shown', async () => {
    vi.resetModules();
    vi.doMock('../src/core/verify-pdf', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/core/verify-pdf')>()),
      independentPdfCheck: async () => ({
        ok: false,
        leftovers: [{ id: 'Info#Author', category: 'IDENTITY', label: 'Author', value: 'Alice Smith', container: 'Info', key: 'Author', removable: true }],
      }),
    }));
    const pipeline = await import('../src/core/pipeline');
    const source = fixture('dirty.pdf');
    const report = await pipeline.inspectFile(source);
    const { verification } = await pipeline.cleanAndVerify(source, report);
    appendFileSync('audit/sabotage-notes.txt', `5b. verdict=${verification.verdict} surviving=${verification.survivingFindings.map((f) => f.label).join(',')}\n`);
    expect(verification.verdict).toBe('partial');
    expect(verification.survivingFindings.map((f) => f.label)).toContain('Author');
    vi.doUnmock('../src/core/verify-pdf');
    vi.resetModules();
  });
});

describe('phase 7: format sniffing', () => {
  const cases: [string, Uint8Array, string][] = [
    ['JPEG bytes named .png', fixture('fake.png'), 'jpeg'],
    ['PNG bytes, no extension', fixture('dirty.png'), 'png'],
    ['PDF bytes', fixture('dirty.pdf'), 'pdf'],
  ];

  it('identifies by content', () => {
    for (const [label, bytes, expected] of cases) {
      expect(sniffFormat(bytes), label).toBe(expected);
    }
  });

  it('rejects junk, truncated signatures and empty input', () => {
    const rows: string[] = [];
    const check = (label: string, bytes: Uint8Array) => {
      try { rows.push(`${label}: accepted as ${sniffFormat(bytes)}`); } catch (e) { rows.push(`${label}: refused (${(e as Error).message})`); }
    };
    check('random bytes named .pdf', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    check('empty file', new Uint8Array());
    check('truncated JPEG signature', new Uint8Array([0xff, 0xd8]));
    check('truncated PNG signature', new Uint8Array([137, 80, 78, 71]));
    check('leading junk before %PDF', fixture('d_leading_junk.pdf'));
    check('ZIP (docx/odt)', new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    appendFileSync('audit/sabotage-notes.txt', rows.map((r) => `sniff: ${r}`).join('\n') + '\n');
    expect(rows.every((r) => r.includes('refused'))).toBe(true);
  });
});

describe('phase 12: size and resource limits', () => {
  const jpegHeader = (size: number) => {
    const b = new Uint8Array(size);
    b.set([0xff, 0xd8, 0xff, 0xe0]);
    return b;
  };

  it('just below the limit is accepted for parsing, at the limit too, above is refused', async () => {
    const rows: string[] = [];
    for (const [label, size] of [['limit - 1', MAX_BYTES - 1], ['limit', MAX_BYTES], ['limit + 1', MAX_BYTES + 1]] as const) {
      try {
        await inspectFile(jpegHeader(size));
        rows.push(`${label}: parsed (no size refusal)`);
      } catch (error) {
        rows.push(`${label}: ${(error as Error).constructor.name} - ${(error as Error).message.slice(0, 60)}`);
      }
    }
    appendFileSync('audit/sabotage-notes.txt', rows.map((r) => `size: ${r}`).join('\n') + '\n');
    expect(rows[2]).toContain('FileTooLargeError');
    expect(rows[0]).not.toContain('FileTooLargeError');
    expect(rows[1]).not.toContain('FileTooLargeError');
  });

  it('characterises a compression bomb inside a PNG zTXt chunk', async () => {
    const crc = (buf: Buffer) => {
      let c = ~0;
      for (const byte of buf) {
        c ^= byte;
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      }
      return (~c) >>> 0;
    };
    const chunk = (type: string, payload: Buffer) => {
      const body = Buffer.concat([Buffer.from(type, 'latin1'), payload]);
      const out = Buffer.alloc(8 + payload.length + 4);
      out.writeUInt32BE(payload.length, 0);
      body.copy(out, 4);
      out.writeUInt32BE(crc(body), 8 + payload.length);
      return out;
    };
    const source = Buffer.from(fixture('clean.png'));
    const { readChunks } = await import('../src/core/png');
    const chunks = readChunks(new Uint8Array(source));
    const bomb = zlib.deflateSync(Buffer.alloc(40 * 1024 * 1024, 0x41)); // 40 MB of 'A'
    const zText = chunk('zTXt', Buffer.concat([Buffer.from('bomb\0\0', 'latin1'), bomb]));
    const head = source.subarray(0, chunks.find((c) => c.type === 'IDAT')!.start);
    const tail = source.subarray(chunks.find((c) => c.type === 'IDAT')!.start);
    const hostile = new Uint8Array(Buffer.concat([head, zText, tail]));

    const started = Date.now();
    let result = 'ok';
    try {
      const report = await inspectFile(hostile);
      const finding = report.findings.find((f) => f.key.includes('bomb'));
      result = `parsed, finding value length ${finding?.value.length}, file ${hostile.length} bytes`;
    } catch (error) {
      result = `refused: ${(error as Error).message}`;
    }
    appendFileSync('audit/sabotage-notes.txt', `bomb: ${result}\n`);
    // How long it took is a fact about this machine, not about FilePass, so it stays out of
    // the tracked note: a number that changes on every run makes the evidence file change too.
    measurement(`bomb (40 MB declared): ${result.split(':')[0]} after ${Date.now() - started} ms`);
    expect(result.length).toBeGreaterThan(0);
  }, 120000);
});
