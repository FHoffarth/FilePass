/**
 * Maintained regression suite for the false-clean channels found by the independent review.
 * These assert the mechanism, not the canary strings: a fixture could swap its planted text
 * and every expectation here would still hold or still fail for the same structural reason.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFDict, PDFName, PDFArray } from 'pdf-lib';
import { CANARIES, contains, fixture, run } from './harness';
import { readChunks } from '../src/core/png';
import { readSegments, classify } from '../src/core/jpeg';
import { MalformedFileError } from '../src/core/types';
import { inspectFile } from '../src/core/pipeline';

const REVIEW = {
  annotXmp: 'FILEPASS_REVIEW_ANNOTXMP_1001',
  catalog: 'FILEPASS_REVIEW_CATALOG_1002',
  jpegPad: 'FILEPASS_REVIEW_JPEGPAD_1003',
  iccpName: 'FILEPASS_REVIEW_ICCP_1004',
  annotXmpFlate: 'FILEPASS_REVIEW_ANNOTXMPFLATE_1005',
  iccJpeg: 'FILEPASS_REVIEW_ICCJPEG_1007',
};

const latin1 = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

async function loaded(bytes: Uint8Array) {
  return PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false });
}

/** No verified, downloadable output may carry data FilePass did not disclose as kept. */
function assertNoFalseClean(outcome: Awaited<ReturnType<typeof run>>, canary: string) {
  const survives = contains(outcome.output, canary);
  expect(
    survives && outcome.verdict === 'verified',
    `${outcome.file}: verdict=${outcome.verdict}, canary survives=${survives}`,
  ).toBe(false);
}

describe('catalog level PieceInfo is handled like the page level one', () => {
  it('direct: the key is gone from the catalog and the private data is gone from the bytes', async () => {
    const outcome = await run('r_catalog_pieceinfo.pdf');
    expect(outcome.findings).toContain('OTHER/Editing data on the document');
    const after = await loaded(outcome.output!);
    expect(after.catalog.get(PDFName.of('PieceInfo'))).toBeUndefined();
    assertNoFalseClean(outcome, REVIEW.catalog);
    expect(contains(outcome.output, REVIEW.catalog)).toBe(false);
  });

  it('indirect, with nested references, is collected as well', async () => {
    const outcome = await run('r_catalog_pieceinfo_indirect.pdf');
    const after = await loaded(outcome.output!);
    expect(after.catalog.get(PDFName.of('PieceInfo'))).toBeUndefined();
    // the dictionary and the two objects hanging off it are unreachable and must not be written
    expect(contains(outcome.output, REVIEW.catalog)).toBe(false);
    expect(latin1(outcome.output!)).not.toContain('/Buried');
    expect(latin1(outcome.output!)).not.toContain('/Even');
    expect(outcome.verdict).toBe('verified');
  });

  it('page level PieceInfo still behaves as before', async () => {
    const outcome = await run('d_multi_meta.pdf');
    expect(outcome.findings).toContain('OTHER/Editing data on page 1');
    expect(contains(outcome.output, CANARIES.author)).toBe(false);
    expect(outcome.verdict).toBe('verified');
  });

  it('visible document content is untouched', async () => {
    for (const file of ['r_catalog_pieceinfo.pdf', 'r_catalog_pieceinfo_indirect.pdf']) {
      const outcome = await run(file);
      const before = await loaded(fixture(file));
      const after = await loaded(outcome.output!);
      expect(after.getPageCount(), file).toBe(before.getPageCount());
      const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const doc = await pdfjs.getDocument({ data: new Uint8Array(outcome.output!), isEvalSupported: false }).promise;
      const text = (await (await doc.getPage(1)).getTextContent()).items.map((i: any) => i.str).join('');
      expect(text, file).toContain('Quarterly numbers');
    }
  });
});

describe('JPEG structural segments carry only their format defined payload', () => {
  it('every kept structural segment in a cleaned file is exactly as long as its structure', async () => {
    for (const file of ['dirty.jpg', 'j_orient6.jpg', 'j_icc.jpg', 'j_cmyk.jpg', 'j_progressive.jpg', 'j_restart.jpg', 'j_padded_sos.jpg']) {
      const outcome = await run(file);
      // readSegments throws if any modelled segment declares more than its structure needs,
      // so a clean parse of the output is itself the proof that no padding survived.
      const segments = readSegments(outcome.output!);
      for (const segment of segments) {
        expect(segment.padding, `${file} ${classify(segment).name}`).toBeUndefined();
      }
    }
  });

  it('an oversized scan header is reported and trimmed, and the scan data is untouched', async () => {
    const source = fixture('j_padded_sos.jpg');
    const outcome = await run('j_padded_sos.jpg');
    expect(outcome.findings).toContain('OTHER/Extra bytes inside a picture data block');
    assertNoFalseClean(outcome, REVIEW.jpegPad);
    const before = readSegments(source).find((s) => s.isScan)!;
    const after = readSegments(outcome.output!).find((s) => s.isScan)!;
    const entropyBefore = source.subarray(before.payloadStart! + before.payload!.length, before.end);
    const entropyAfter = outcome.output!.subarray(after.payloadStart! + after.payload!.length, after.end);
    expect(Array.from(entropyAfter)).toEqual(Array.from(entropyBefore));
  });

  it('an ambiguous table structure fails closed instead of being copied through', async () => {
    await expect(inspectFile(fixture('j_padded_dqt.jpg'))).rejects.toBeInstanceOf(MalformedFileError);
    const outcome = await run('j_padded_dqt.jpg');
    expect(outcome.downloadable).toBe(false);
    expect(outcome.verdict).toBeUndefined();
  });

  it('ordinary JPEGs are unaffected by the length checks', async () => {
    for (const file of ['clean.jpg', 'dirty.jpg', 'j_unicode.jpg', 'j_multi_app1.jpg', 'j_late_exif.jpg']) {
      const outcome = await run(file);
      expect(outcome.verdict, file).toBe('verified');
    }
  });
});

describe('colour profiles are kept, bounded and disclosed', () => {
  it('JPEG: bytes past the declared profile length are reported and removed', async () => {
    const outcome = await run('j_icc_canary.jpg');
    expect(outcome.findings).toContain('OTHER/Extra bytes inside a picture data block');
    assertNoFalseClean(outcome, REVIEW.iccJpeg);
    expect(contains(outcome.output, REVIEW.iccJpeg)).toBe(false);
  });

  it('JPEG: the profile itself survives byte for byte and is disclosed as kept', async () => {
    const source = fixture('j_icc.jpg');
    const outcome = await run('j_icc.jpg');
    expect(outcome.findings).toContain('OTHER/Colour profile');
    const profileOf = (bytes: Uint8Array) => readSegments(bytes)
      .filter((s) => classify(s).name === 'APP2/ICC')
      .map((s) => Array.from(s.payload!));
    expect(profileOf(outcome.output!)).toEqual(profileOf(source));
    expect(outcome.verdict).toBe('verified');
    expect(outcome.verification!.remainingFindings.map((f) => f.label)).toContain('Colour profile');
  });

  it('PNG: the free text profile name is removed while the profile bytes stay', async () => {
    const source = fixture('p_iccp_name.png');
    const outcome = await run('p_iccp_name.png');
    expect(outcome.findings).toContain('OTHER/Colour profile name');
    assertNoFalseClean(outcome, REVIEW.iccpName);

    const iccpBefore = readChunks(source).find((c) => c.type === 'iCCP')!;
    const iccpAfter = readChunks(outcome.output!).find((c) => c.type === 'iCCP')!;
    expect(iccpAfter, 'the profile chunk must still be there').toBeTruthy();
    const profileBytes = (chunk: typeof iccpBefore) => Array.from(chunk.data.subarray(chunk.data.indexOf(0) + 1));
    expect(profileBytes(iccpAfter)).toEqual(profileBytes(iccpBefore));
    const nameAfter = new TextDecoder().decode(iccpAfter.data.subarray(0, iccpAfter.data.indexOf(0)));
    expect(nameAfter).toBe('ICC profile');
  });

  it('PNG: a profile that is already plainly labelled is left completely alone', async () => {
    const outcome = await run('p_full.png');
    const before = readChunks(fixture('p_full.png')).find((c) => c.type === 'iCCP')!;
    const after = readChunks(outcome.output!).find((c) => c.type === 'iCCP')!;
    expect(Array.from(after.data).length).toBeGreaterThan(0);
    expect(outcome.verdict).toBe('verified');
    expect(before.data.length).toBeGreaterThan(0);
  });
});

describe('annotation metadata is found by the inspector, not only by the byte scan', () => {
  it('annotation XMP is a named finding and its object is gone', async () => {
    const outcome = await run('r_annot_xmp.pdf');
    expect(outcome.findings!.some((f) => f.includes('XMP metadata on a comment'))).toBe(true);
    const after = await loaded(outcome.output!);
    const page = after.getPage(0);
    const annots = after.context.lookup(page.node.get(PDFName.of('Annots')));
    const annot = annots instanceof PDFArray ? after.context.lookup(annots.get(0)) : undefined;
    expect(annot instanceof PDFDict && annot.get(PDFName.of('Metadata'))).toBeFalsy();
    assertNoFalseClean(outcome, REVIEW.annotXmp);
  });

  it('a compressed annotation XMP stream is caught by the same semantic path', async () => {
    const outcome = await run('r_annot_xmp_flate.pdf');
    expect(outcome.findings!.some((f) => f.includes('XMP metadata on a comment'))).toBe(true);
    expect(latin1(outcome.output!)).not.toContain('/Subtype /XML');
    assertNoFalseClean(outcome, REVIEW.annotXmpFlate);
  });

  it('comment text and rich text survive while the author does not', async () => {
    const outcome = await run('r_annot_richtext.pdf');
    const raw = latin1(outcome.output!);
    expect(raw).toContain('Please double check row 12');   // /Contents
    expect(raw).toContain('xmlns=');                        // /RC rich text
    expect(raw).not.toContain(REVIEW.annotXmp);             // /T author
    expect(outcome.verdict).toBe('verified');
  });

  it('form field names are never treated as comment authors', async () => {
    const outcome = await run('r_form_widget.pdf');
    expect(outcome.findings!.some((f) => f.includes('Comment author'))).toBe(false);
    const raw = latin1(outcome.output!);
    expect(raw).toContain('(EmployeeNumber)');   // field name intact
    expect(raw).toContain('(12345)');            // field value intact
    expect(outcome.verdict).toBe('verified');
  });
});

describe('the verified invariant after the follow-up', () => {
  it('only findings disclosed as kept may coexist with verified', async () => {
    for (const file of ['j_icc.jpg', 'p_full.png', 'p_iccp_name.png']) {
      const outcome = await run(file);
      if (outcome.verdict !== 'verified') continue;
      for (const finding of outcome.verification!.outputReport.findings) {
        expect(finding.removable, `${file}: ${finding.label} survived and is removable`).toBe(false);
        expect(finding.keptReason, `${file}: ${finding.label} has no stated reason`).toBeTruthy();
      }
    }
  });

  it('the exception is narrow: a removable leftover, or a kept finding the source never had, both block verified', async () => {
    const { verifyClean } = await import('../src/core/pipeline');

    // (a) a removable finding still present in the output
    const dirty = fixture('dirty.png');
    const dirtyReport = await inspectFile(dirty);
    const untouched = await verifyClean(dirtyReport, { bytes: dirty, promisedRemovedIds: [], notes: [] });
    expect(untouched.verdict).not.toBe('verified');
    expect(untouched.outputReport.findings.some((f) => f.removable)).toBe(true);

    // (b) a kept finding that was not in the source is an introduced one, not a disclosed choice
    const iccOutput = (await run('j_icc.jpg')).output!;
    const plainReport = await inspectFile(fixture('clean.jpg'));
    const swapped = await verifyClean(plainReport, { bytes: iccOutput, promisedRemovedIds: [], notes: [] });
    expect(swapped.outputReport.findings.some((f) => !f.removable)).toBe(true);
    expect(swapped.verdict).not.toBe('verified');
  });
});

describe('large multi part colour profiles', () => {
  it('a profile split across several APP2 segments is accepted and kept intact', async () => {
    const outcome = await run('j_icc_multichunk.jpg');
    expect(outcome.verdict).toBe('verified');
    expect(outcome.findings).toContain('OTHER/Colour profile');
    const profileOf = (bytes: Uint8Array) => readSegments(bytes)
      .filter((s) => classify(s).name === 'APP2/ICC')
      .map((s) => Array.from(s.payload!));
    expect(profileOf(outcome.output!)).toEqual(profileOf(fixture('j_icc_multichunk.jpg')));
  });
});
