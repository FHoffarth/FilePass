/**
 * Independent review gate. These cases are NOT copies of the P0 regression corpus: they
 * probe structures the fix did not target, looking for a shared blind spot between the
 * inspector, the cleaner, the second parser and the byte level backstop.
 * Nothing here asserts desired behaviour yet; it records what actually happens.
 */
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { contains, fixture, run } from './harness';
import { readChunks } from '../src/core/png';
import { readSegments, classify } from '../src/core/jpeg';

const CANARY = {
  annotXmp: 'FILEPASS_REVIEW_ANNOTXMP_1001',
  catalog: 'FILEPASS_REVIEW_CATALOG_1002',
  jpegPad: 'FILEPASS_REVIEW_JPEGPAD_1003',
  iccpName: 'FILEPASS_REVIEW_ICCP_1004',
  annotXmpFlate: 'FILEPASS_REVIEW_ANNOTXMPFLATE_1005',
  hexString: 'FILEPASS_REVIEW_HEXSTRING_1006',
};

const rows: string[] = [];
const record = (name: string, o: Awaited<ReturnType<typeof run>>, canary: string) => {
  const line = `${name} | findings=${o.findings?.length ?? '-'} | verdict=${o.verdict ?? 'error'} | download=${o.downloadable ? 'YES' : 'no'} | canary in output=${contains(o.output, canary) ? 'SURVIVES' : 'gone'}`;
  rows.push(line);
  return line;
};

describe('new attack: metadata hanging off an annotation', () => {
  it('uncompressed annotation XMP', async () => {
    const outcome = await run('r_annot_xmp.pdf');
    record('r_annot_xmp.pdf', outcome, CANARY.annotXmp);
    expect(contains(fixture('r_annot_xmp.pdf'), CANARY.annotXmp)).toBe(true);
    const survives = contains(outcome.output, CANARY.annotXmp);
    // the only thing that must never happen
    expect(survives && outcome.verdict === 'verified').toBe(false);
  });

  it('Flate compressed annotation XMP, invisible to a plaintext byte scan', async () => {
    const outcome = await run('r_annot_xmp_flate.pdf');
    record('r_annot_xmp_flate.pdf', outcome, CANARY.annotXmpFlate);
    const raw = new TextDecoder('latin1').decode(outcome.output ?? new Uint8Array());
    rows.push(`  compressed XMP still an object in the output: ${raw.includes('/Metadata') || raw.includes('FlateDecode')}`);
    const survivesCompressed = outcome.output
      ? new TextDecoder('latin1').decode(outcome.output).includes('/Subtype /XML')
      : false;
    rows.push(`  /Subtype /XML present in output: ${survivesCompressed}`);
    expect(contains(outcome.output, CANARY.annotXmpFlate) && outcome.verdict === 'verified').toBe(false);
  });
});

describe('new attack: private data on the catalog rather than a page', () => {
  it('catalog level PieceInfo', async () => {
    const outcome = await run('r_catalog_pieceinfo.pdf');
    record('r_catalog_pieceinfo.pdf', outcome, CANARY.catalog);
    expect(contains(fixture('r_catalog_pieceinfo.pdf'), CANARY.catalog)).toBe(true);
    expect(contains(outcome.output, CANARY.catalog) && outcome.verdict === 'verified').toBe(false);
  });
});

describe('new attack: alternate PDF string syntax', () => {
  it('hex string Info values', async () => {
    const outcome = await run('r_hex_info.pdf');
    record('r_hex_info.pdf', outcome, CANARY.hexString);
    rows.push(`  findings: ${JSON.stringify(outcome.findings)}`);
    expect(contains(outcome.output, CANARY.hexString)).toBe(false);
  });
});

describe('new attack: payload smuggled inside kept JPEG segments', () => {
  it('oversized DQT segment', async () => {
    const outcome = await run('j_padded_dqt.jpg');
    record('j_padded_dqt.jpg', outcome, CANARY.jpegPad);
    try {
      rows.push(`  segments: ${readSegments(fixture('j_padded_dqt.jpg')).map((s) => classify(s).name).join(' ')}`);
    } catch (error) {
      rows.push(`  segments: refused at parse time (${(error as Error).message})`);
    }
    expect(contains(fixture('j_padded_dqt.jpg'), CANARY.jpegPad)).toBe(true);
    expect(contains(outcome.output, CANARY.jpegPad) && outcome.verdict === 'verified').toBe(false);
  });

  it('oversized SOS header', async () => {
    const outcome = await run('j_padded_sos.jpg');
    record('j_padded_sos.jpg', outcome, CANARY.jpegPad);
    expect(contains(outcome.output, CANARY.jpegPad) && outcome.verdict === 'verified').toBe(false);
  });
});

describe('new attack: payload inside a PNG chunk kept for rendering', () => {
  it('iCCP profile name', async () => {
    const outcome = await run('p_iccp_name.png');
    record('p_iccp_name.png', outcome, CANARY.iccpName);
    rows.push(`  chunks after: ${readChunks(outcome.output!).map((c) => c.type).join(' ')}`);
    expect(contains(fixture('p_iccp_name.png'), CANARY.iccpName)).toBe(true);
    expect(contains(outcome.output, CANARY.iccpName) && outcome.verdict === 'verified').toBe(false);
  });

  it('unknown critical chunk', async () => {
    const outcome = await run('p_unknown_critical.png');
    rows.push(`p_unknown_critical.png | findings=${outcome.findings?.length} | verdict=${outcome.verdict} | chunks after: ${readChunks(outcome.output!).map((c) => c.type).join(' ')}`);
    expect(outcome.output).toBeTruthy();
  });
});

describe('fidelity of the orphan sweep', () => {
  it('objects reachable only through an annotation or an indirect length survive', async () => {
    const outcome = await run('r_reachable_only_via_annot.pdf');
    const after = await PDFDocument.load(outcome.output!, { throwOnInvalidObject: false });
    const raw = new TextDecoder('latin1').decode(outcome.output!);
    rows.push(`r_reachable_only_via_annot.pdf | pages=${after.getPageCount()} | verdict=${outcome.verdict}`);
    rows.push(`  XObject image kept: ${raw.includes('/Image')} | appearance stream kept: ${raw.includes('/BBox')} | annotation kept: ${raw.includes('/Annot')}`);
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(outcome.output!), isEvalSupported: false }).promise;
    const text = (await (await doc.getPage(1)).getTextContent()).items.map((i: any) => i.str).join('');
    rows.push(`  visible text: "${text}"`);
    expect(text).toContain('Quarterly numbers');
    expect(raw).toContain('/Image');
    expect(raw).toContain('/BBox');
  });

  it('writes the review table', () => {
    writeFileSync('audit/review-attacks.txt', rows.join('\n'));
    expect(rows.length).toBeGreaterThan(0);
  });
});
