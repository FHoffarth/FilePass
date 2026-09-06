import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { CANARIES, contains, fixture, run } from './harness';
import { readChunks } from '../src/core/png';
import { readSegments } from '../src/core/jpeg';

const notes: string[] = [];
const note = (line: string) => { notes.push(line); };

describe('P0 cases, re-stated as the required behaviour', () => {
  it('JPEG: bytes appended after EOI are reported and gone from the clean copy', async () => {
    const outcome = await run('j_trailing_dirty.jpg');
    note(`j_trailing_dirty.jpg verdict=${outcome.verdict} findings=${outcome.findings?.length} removed=${outcome.removed}`);
    expect(outcome.findings).toContain('OTHER/Extra data after the end of the image');
    expect(outcome.verdict).toBe('verified');
    expect(outcome.downloadable).toBe(true);
    expect(contains(outcome.output, CANARIES.trailing)).toBe(false);
  });

  it('JPEG: a COM segment after the scan is seen, named and removed', async () => {
    const outcome = await run('j_com_after_sos.jpg');
    note(`j_com_after_sos.jpg findings=${JSON.stringify(outcome.findings)} verdict=${outcome.verdict}`);
    expect(contains(fixture('j_com_after_sos.jpg'), CANARIES.trailing)).toBe(true);
    expect(outcome.findings).toContain('DOCUMENT/Comment');
    expect(contains(outcome.output, CANARIES.trailing)).toBe(false);
  });

  it('PDF: the unreferenced page-level XMP object is gone from the bytes', async () => {
    const outcome = await run('d_multi_meta.pdf');
    note(`d_multi_meta.pdf verdict=${outcome.verdict} findings=${outcome.findings?.length} removed=${outcome.removed}`);
    expect(outcome.verdict).toBe('verified');
    expect(contains(outcome.output, CANARIES.author)).toBe(false);
    const text = new TextDecoder('latin1').decode(outcome.output!);
    expect(text).not.toContain('xmpmeta');
    expect(text).not.toContain('/Type /Metadata');
  });

  it('PDF: objects lifted out of an object stream do not survive as loose objects', async () => {
    const outcome = await run('d_objstm.pdf');
    note(`d_objstm.pdf verdict=${outcome.verdict} findings=${JSON.stringify(outcome.findings)}`);
    expect(outcome.verdict).toBe('verified');
    expect(contains(outcome.output, CANARIES.objstm)).toBe(false);
  });

  it('PDF: the byte level backstop agrees with both parsers on the cleaned output', async () => {
    const outcome = await run('d_multi_meta.pdf');
    expect(outcome.verification!.outputReport.findings).toEqual([]);
    expect(outcome.verification!.survivingFindings).toEqual([]);
    const { independentPdfCheck, rawMetadataResidue } = await import('../src/core/verify-pdf');
    const second = await independentPdfCheck(outcome.output!);
    const residue = await rawMetadataResidue(outcome.output!, outcome.report!.findings);
    note(`  independent check on output: ok=${second.ok} leftovers=${second.leftovers.length} residue=${residue.length}`);
    expect(second.ok).toBe(true);
    expect(residue).toEqual([]);
  });

  it('PDF: the byte level backstop vetoes a cleaner that only removes references', async () => {
    const { rawMetadataResidue } = await import('../src/core/verify-pdf');
    const outcome = await run('d_multi_meta.pdf');
    // the untouched source stands in for an output whose orphans were never dropped
    const residue = await rawMetadataResidue(fixture('d_multi_meta.pdf'), outcome.report!.findings);
    note(`  backstop on an uncleaned file: ${residue.length} hits (${residue.map((f) => f.label).join(', ')})`);
    expect(residue.length).toBeGreaterThan(0);
  });
});

describe('fidelity evidence', () => {
  it('JPEG: encoded scan data is byte identical for every readable fixture', async () => {
    const files = ['dirty.jpg', 'j_orient1.jpg', 'j_orient6.jpg', 'j_orient8.jpg', 'j_icc.jpg', 'j_cmyk.jpg', 'j_multi_app1.jpg', 'j_late_exif.jpg'];
    for (const file of files) {
      const outcome = await run(file);
      const source = fixture(file);
      const a = readSegments(source).find((s) => s.isScan)!;
      const b = readSegments(outcome.output!).find((s) => s.isScan)!;
      expect(Array.from(outcome.output!.subarray(b.start)), file).toEqual(Array.from(source.subarray(a.start)));
    }
    note('JPEG scan data identical for 8 fixtures');
  });

  it('JPEG: rendering segments survive, orientation is carried across', async () => {
    for (const [file, expected] of [['j_orient1.jpg', 1], ['j_orient6.jpg', 6], ['j_orient8.jpg', 8]] as const) {
      const outcome = await run(file);
      const exifr = (await import('exifr')).default;
      const parsed: any = await exifr.parse(outcome.output! as any, { ifd0: true, exif: true, gps: true, xmp: true, mergeOutput: false, translateKeys: false, translateValues: false } as any);
      const orientation = parsed?.ifd0?.['274'];
      note(`${file}: orientation in output = ${orientation ?? 'none'} (source ${expected})`);
      if (expected === 1) expect(orientation).toBeUndefined();
      else expect(orientation).toBe(expected);
      expect(parsed?.gps).toBeUndefined();
    }
    const icc = await run('j_icc.jpg');
    const names = readSegments(icc.output!).map((s) => s.marker);
    expect(names).toContain(0xe2); // ICC kept
    const cmyk = await run('j_cmyk.jpg');
    expect(readSegments(cmyk.output!).map((s) => s.marker)).toContain(0xee); // Adobe APP14 kept
    note('ICC (APP2) and Adobe (APP14) segments preserved');
  });

  it('PNG: pixel and rendering chunks survive, including APNG animation', async () => {
    for (const file of ['p_full.png', 'p_palette_trns.png', 'p_apng.png', 'p_text_after_idat.png']) {
      const outcome = await run(file);
      const before = readChunks(fixture(file));
      const after = readChunks(outcome.output!);
      const idatBefore = before.filter((c) => c.type === 'IDAT').map((c) => Array.from(c.data));
      const idatAfter = after.filter((c) => c.type === 'IDAT').map((c) => Array.from(c.data));
      expect(idatAfter, file).toEqual(idatBefore);
      note(`${file}: ${before.map((c) => c.type).join(' ')}  ->  ${after.map((c) => c.type).join(' ')}`);
    }
    const apng = await run('p_apng.png');
    const kinds = readChunks(apng.output!).map((c) => c.type);
    expect(kinds).toEqual(['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'IEND']);
    const pal = await run('p_palette_trns.png');
    expect(readChunks(pal.output!).map((c) => c.type)).toContain('tRNS');
    expect(readChunks(pal.output!).map((c) => c.type)).toContain('PLTE');
  });

  it('PDF: page count and visible text survive, and visible text is never claimed as removed', async () => {
    for (const file of ['dirty.pdf', 'd_multi_meta.pdf', 'd_custom_keys.pdf', 'd_incremental.pdf', 'd_objstm.pdf', 'd_visible_only.pdf']) {
      const outcome = await run(file);
      const before = await PDFDocument.load(fixture(file), { throwOnInvalidObject: false });
      const after = await PDFDocument.load(outcome.output!, { throwOnInvalidObject: false });
      expect(after.getPageCount(), file).toBe(before.getPageCount());
      const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const doc = await pdfjs.getDocument({ data: new Uint8Array(outcome.output!), isEvalSupported: false }).promise;
      const text = (await (await doc.getPage(1)).getTextContent()).items.map((i: any) => i.str).join('');
      note(`${file}: pages ${before.getPageCount()} -> ${after.getPageCount()}, text "${text}"`);
      if (file !== 'dirty.pdf') expect(text).toContain('Alice Smith'); // visible content untouched, as documented
    }
  });

  it('PDF: a file only pdf-lib can read is never called verified', async () => {
    const outcome = await run('d_truncated.pdf');
    note(`d_truncated.pdf verdict=${outcome.verdict} findings=${outcome.findings?.length} downloadable=${outcome.downloadable}`);
    expect(['unverified', 'refused']).toContain(outcome.verdict);
    expect(outcome.downloadable).toBe(false);
    expect(outcome.blocked).toMatch(/could not be read the same way twice/);
  });
});

describe('unknown data is treated conservatively', () => {
  it('JPEG unknown APPn is reported and removed', async () => {
    const outcome = await run('j_unknown_app.jpg');
    expect(outcome.findings).toEqual(['OTHER/APP5 metadata block']);
    expect(contains(fixture('j_unknown_app.jpg'), CANARIES.unknownApp)).toBe(true);
    expect(contains(outcome.output, CANARIES.unknownApp)).toBe(false);
  });

  it('PNG unknown ancillary chunk is reported and removed', async () => {
    const outcome = await run('p_unknown_chunk.png');
    expect(outcome.findings).toEqual(['OTHER/prVt data block']);
    expect(contains(outcome.output, CANARIES.unknownChunk)).toBe(false);
  });

  it('PNG trailing bytes after IEND are dropped', async () => {
    const outcome = await run('p_trailing.png');
    expect(contains(fixture('p_trailing.png'), CANARIES.trailing)).toBe(true);
    expect(contains(outcome.output, CANARIES.trailing)).toBe(false);
    note('PNG trailing data dropped by the chunk rebuild');
  });

  it('PDF trailing bytes after %%EOF are dropped', async () => {
    const outcome = await run('d_trailing.pdf');
    expect(contains(fixture('d_trailing.pdf'), CANARIES.trailing)).toBe(true);
    expect(contains(outcome.output, CANARIES.trailing)).toBe(false);
  });

  it('PDF incremental history: the superseded revision does not survive', async () => {
    const outcome = await run('d_incremental.pdf');
    expect(contains(fixture('d_incremental.pdf'), CANARIES.oldRevision)).toBe(true);
    expect(contains(outcome.output, CANARIES.oldRevision)).toBe(false);
    note(`d_incremental.pdf findings=${JSON.stringify(outcome.findings)} verdict=${outcome.verdict}`);
    // does inspection even see the old revision?
    expect(outcome.findings?.join(' ')).not.toContain('Rev One');
  });
});

describe('write notes', () => {
  it('dumps observations', () => {
    writeFileSync('audit/evidence-notes.txt', notes.join('\n'));
    expect(notes.length).toBeGreaterThan(0);
  });
});
