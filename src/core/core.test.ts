import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { inspectFile, cleanAndVerify, cleanFile, verifyClean } from './pipeline';
import { sniffFormat, MAX_BYTES } from './sniff';
import { readChunks } from './png';
import { readSegments, classify } from './jpeg';
import { suggestFilename } from './filename';
import { FileTooLargeError, MalformedFileError, UnsupportedFileError } from './types';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url))));

const labels = (report: { findings: { label: string }[] }) => report.findings.map((f) => f.label);
const values = (report: { findings: { value: string }[] }) => report.findings.map((f) => f.value).join(' | ');

describe('format detection', () => {
  it('detects by content, not by extension', () => {
    expect(sniffFormat(fixture('dirty.jpg'))).toBe('jpeg');
    expect(sniffFormat(fixture('dirty.png'))).toBe('png');
    expect(sniffFormat(fixture('dirty.pdf'))).toBe('pdf');
    // fake.png holds JPEG bytes
    expect(sniffFormat(fixture('fake.png'))).toBe('jpeg');
  });

  it('refuses unsupported and empty input', () => {
    expect(() => sniffFormat(new Uint8Array())).toThrow(UnsupportedFileError);
    expect(() => sniffFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toThrow(UnsupportedFileError);
  });

  it('refuses oversized input before parsing it', async () => {
    const huge = new Uint8Array(MAX_BYTES + 1);
    huge.set([0xff, 0xd8, 0xff]);
    await expect(inspectFile(huge)).rejects.toBeInstanceOf(FileTooLargeError);
  });
});

describe('JPEG', () => {
  it('finds identity, device, time and location metadata', async () => {
    const report = await inspectFile(fixture('dirty.jpg'));
    expect(labels(report)).toEqual(expect.arrayContaining([
      'Author', 'Camera manufacturer', 'Camera model', 'Software', 'Captured', 'GPS location', 'Comment', 'XMP metadata block',
    ]));
    const gps = report.findings.find((f) => f.category === 'LOCATION');
    expect(gps?.value).toBe('49.8728, 8.6511');
  });

  it('reports nothing for a file without metadata', async () => {
    const report = await inspectFile(fixture('clean.jpg'));
    expect(report.findings).toEqual([]);
  });

  it('removes every reported item and verifies it against the output bytes', async () => {
    const source = fixture('dirty.jpg');
    const report = await inspectFile(source);
    const { verification } = await cleanAndVerify(source, report);
    expect(verification.verdict).toBe('verified');
    expect(verification.survivingFindings).toEqual([]);
    expect(verification.introducedFindings).toEqual([]);
    expect(verification.removedIds.length).toBe(report.findings.length);
    expect(verification.outputReport.findings).toEqual([]);
  });

  it('keeps the picture itself untouched, including rotation and colour segments', async () => {
    const source = fixture('dirty.jpg');
    const report = await inspectFile(source);
    const { cleaned } = await cleanAndVerify(source, report);

    const sourceScan = readSegments(source).find((s) => s.isScan)!;
    const outputScan = readSegments(cleaned.bytes).find((s) => s.isScan)!;
    expect(Array.from(cleaned.bytes.subarray(outputScan.start)))
      .toEqual(Array.from(source.subarray(sourceScan.start)));

    const kept = readSegments(cleaned.bytes).map((s) => classify(s).name);
    expect(kept).toContain('APP0/JFIF');
    expect(kept).toContain('APP1/EXIF'); // orientation only
    expect(cleaned.bytes.length).toBeLessThan(source.length);
  });

  it('keeps orientation as the only surviving EXIF tag', async () => {
    const source = fixture('dirty.jpg');
    const report = await inspectFile(source);
    expect(report.notes.join(' ')).toMatch(/right way up/);
    const { cleaned } = await cleanAndVerify(source, report);
    const exif = readSegments(cleaned.bytes)
      .filter((s) => classify(s).name === 'APP1/EXIF')
      .map((s) => s.payload!.length);
    expect(exif).toEqual([32]); // "Exif\0\0" + a one entry TIFF header
    const exifr = (await import('exifr')).default;
    const parsed: any = await exifr.parse(cleaned.bytes as any, { ifd0: true, exif: true, gps: true, xmp: true, mergeOutput: false, translateKeys: false } as any);
    expect(Object.keys(parsed?.ifd0 ?? {})).toEqual(['274']);
    expect(parsed?.gps).toBeUndefined();
    expect(parsed?.exif).toBeUndefined();
  });

  it('fails closed on damaged JPEG bytes', async () => {
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x01, 0x02]);
    await expect(inspectFile(broken)).rejects.toBeInstanceOf(MalformedFileError);
  });
});

describe('PNG', () => {
  it('finds text chunks that the decoding library alone would miss', async () => {
    const report = await inspectFile(fixture('dirty.png'));
    const keys = report.findings.map((f) => f.key);
    // exifr reports only three of these; the structural walk finds all of them.
    expect(keys).toEqual(expect.arrayContaining([
      'tEXt:Author', 'tEXt:Software', 'tEXt:Creation Time', 'iTXt:XML:com.adobe.xmp', 'iTXt:Comment', 'zTXt:zipped',
    ]));
    expect(report.findings.some((f) => f.container === 'eXIf')).toBe(true);
  });

  it('decodes compressed and unicode text safely and never as markup', async () => {
    const report = await inspectFile(fixture('dirty.png'));
    const comment = report.findings.find((f) => f.key === 'iTXt:Comment')!;
    expect(comment.value).toContain('<script>alert(1)</script>');
    expect(comment.value).toContain('ümläut');
    expect(comment.value).toContain('你好');
    const zipped = report.findings.find((f) => f.key === 'zTXt:zipped')!;
    expect(zipped.value.startsWith('xxx')).toBe(true);
  });

  it('removes every text chunk and verifies the output', async () => {
    const source = fixture('dirty.png');
    const report = await inspectFile(source);
    const { cleaned, verification } = await cleanAndVerify(source, report);
    expect(verification.verdict).toBe('verified');
    expect(verification.outputReport.findings).toEqual([]);
    expect(readChunks(cleaned.bytes).map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
  });

  it('copies image data across byte for byte', async () => {
    const source = fixture('dirty.png');
    const report = await inspectFile(source);
    const { cleaned } = await cleanAndVerify(source, report);
    const idat = (b: Uint8Array) => readChunks(b).filter((c) => c.type === 'IDAT').map((c) => Array.from(c.data));
    expect(idat(cleaned.bytes)).toEqual(idat(source));
    const header = (b: Uint8Array) => Array.from(readChunks(b).find((c) => c.type === 'IHDR')!.data);
    expect(header(cleaned.bytes)).toEqual(header(source)); // size, bit depth, colour type, alpha
  });

  it('reports nothing for a file without metadata', async () => {
    expect((await inspectFile(fixture('clean.png'))).findings).toEqual([]);
  });

  it('fails closed on a damaged PNG', async () => {
    const broken = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 99, 73, 72, 68, 82]);
    await expect(inspectFile(broken)).rejects.toBeInstanceOf(MalformedFileError);
  });
});

describe('PDF', () => {
  it('finds the info dictionary and the XMP block', async () => {
    const report = await inspectFile(fixture('dirty.pdf'));
    expect(labels(report)).toEqual(expect.arrayContaining([
      'Title', 'Author', 'Subject', 'Keywords', 'Created with', 'Produced by', 'Created', 'Modified', 'Company', 'XMP metadata block',
    ]));
    expect(values(report)).toContain('Alice Smith');
    expect(report.findings.find((f) => f.label === 'Created')!.value).toBe('14.08.2026, 10:15');
  });

  it('removes metadata, keeps the pages, and passes an independent second check', async () => {
    const source = fixture('dirty.pdf');
    const report = await inspectFile(source);
    const { cleaned, verification } = await cleanAndVerify(source, report);

    expect(verification.verdict).toBe('verified');
    expect(verification.outputReport.findings).toEqual([]);
    expect(verification.removedIds.length).toBe(report.findings.length);

    const before = await PDFDocument.load(source);
    const after = await PDFDocument.load(cleaned.bytes);
    expect(after.getPageCount()).toBe(before.getPageCount());
    expect(after.getPage(0).getSize()).toEqual(before.getPage(0).getSize());
  });

  it('keeps the visible text of the document', async () => {
    const source = fixture('dirty.pdf');
    const report = await inspectFile(source);
    const { cleaned } = await cleanAndVerify(source, report);
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(cleaned.bytes), isEvalSupported: false }).promise;
    const text = (await (await doc.getPage(1)).getTextContent()).items.map((i: any) => i.str).join('');
    expect(text).toBe('Confidential Proposal v7');
  });

  it('does not stamp its own tool name into the output', async () => {
    const source = fixture('dirty.pdf');
    const report = await inspectFile(source);
    const { cleaned } = await cleanAndVerify(source, report);
    const raw = new TextDecoder('latin1').decode(cleaned.bytes);
    expect(raw).not.toContain('pdf-lib');
    expect(raw).not.toContain('Alice Smith');
    expect(raw).not.toContain('xmpmeta');
  });

  it('refuses to clean a signed PDF instead of breaking the signature', async () => {
    const report = await inspectFile(fixture('signed.pdf'));
    expect(report.blocked?.reason).toMatch(/digitally signed/);
    expect(report.findings.length).toBeGreaterThan(0); // it still explains what is inside
    await expect(cleanFile(fixture('signed.pdf'), report)).rejects.toBeInstanceOf(MalformedFileError);
  });

  it('fails closed on malformed and empty PDFs', async () => {
    await expect(inspectFile(fixture('malformed.pdf'))).rejects.toBeInstanceOf(MalformedFileError);
    await expect(inspectFile(fixture('empty.pdf'))).rejects.toBeInstanceOf(UnsupportedFileError);
  });

  it('reports nothing for a PDF without metadata', async () => {
    expect((await inspectFile(fixture('no_metadata.pdf'))).findings).toEqual([]);
  });
});

describe('verification is independent of the cleaner', () => {
  it('never reports success when the cleaner lies about what it removed', async () => {
    const source = fixture('dirty.jpg');
    const report = await inspectFile(source);
    const lying = { bytes: source, promisedRemovedIds: report.findings.map((f) => f.id), notes: [] };
    const verification = await verifyClean(report, lying);
    expect(verification.verdict).toBe('partial');
    expect(verification.survivingFindings.length).toBeGreaterThan(0);
    expect(verification.removedIds).toEqual([]);
  });

  it('treats metadata that appears in the output as a failure', async () => {
    const source = fixture('clean.png');
    const report = await inspectFile(source);
    const verification = await verifyClean(report, { bytes: fixture('dirty.png'), promisedRemovedIds: [], notes: [] });
    expect(verification.verdict).toBe('partial');
    expect(verification.introducedFindings.length).toBeGreaterThan(0);
  });
});

describe('filename suggestion', () => {
  it('drops version and status tokens only', () => {
    expect(suggestFilename('Proposal_v7_FINAL_internal.pdf')).toBe('Proposal.pdf');
    expect(suggestFilename('holiday-photo-2026-08-22.jpg')).toBe('holiday-photo.jpg');
    expect(suggestFilename('report (2).pdf')).toBe('report.pdf');
  });

  it('never empties a name and never rewrites meaning', () => {
    expect(suggestFilename('final.pdf')).toBe('final.pdf');
    expect(suggestFilename('Vertragsentwurf.pdf')).toBe('Vertragsentwurf.pdf');
    expect(suggestFilename('IMG_2044.jpg')).toBe('IMG.jpg');
  });
});
