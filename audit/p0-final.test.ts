/**
 * The four false-VERIFIED paths from the final local adversarial review, written as the
 * behaviour the trust contract requires. These fail against 7a8e6a5 and must pass after
 * the remediation. Assertions are structural: canary absence alone is never the proof.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { contains, fixture, run } from './harness';
import { readSegments, classify } from '../src/core/jpeg';
import { readChunks } from '../src/core/png';
import { inspectFile } from '../src/core/pipeline';
import { MalformedFileError } from '../src/core/types';

const CANARY = {
  jfif: 'FILEPASS_FINAL_JFIF_2001',
  app14: 'FILEPASS_FINAL_APP14_2002',
  iccp: 'FILEPASS_FINAL_ICCP2_2003',
  pages: 'FILEPASS_FINAL_PAGESXMP_2004',
};

const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const load = (b: Uint8Array) => PDFDocument.load(b, { throwOnInvalidObject: false, updateMetadata: false });

/** Nothing may be retained in a verified, downloadable output unless it was accounted for. */
function noFalseClean(outcome: Awaited<ReturnType<typeof run>>, canary: string) {
  const survives = contains(outcome.output, canary);
  expect(
    survives && outcome.verdict === 'verified',
    `${outcome.file}: verdict=${outcome.verdict} download=${outcome.downloadable} canary=${survives}`,
  ).toBe(false);
}

describe('P0-A: payload inside retained JPEG APP structures', () => {
  it('APP0/JFIF padding is accounted for and cannot ride through verified', async () => {
    const outcome = await run('a_jfif_pad.jpg');
    expect(contains(fixture('a_jfif_pad.jpg'), CANARY.jfif)).toBe(true);
    noFalseClean(outcome, CANARY.jfif);
    expect(outcome.findings, 'the extra bytes must be reported, not silently dropped').not.toEqual([]);
    expect(contains(outcome.output, CANARY.jfif)).toBe(false);
  });

  it('APP14/Adobe padding is accounted for and cannot ride through verified', async () => {
    const outcome = await run('a_app14_pad.jpg');
    expect(contains(fixture('a_app14_pad.jpg'), CANARY.app14)).toBe(true);
    noFalseClean(outcome, CANARY.app14);
    expect(outcome.findings).not.toEqual([]);
    expect(contains(outcome.output, CANARY.app14)).toBe(false);
  });

  it('the legal JFIF header survives, and its thumbnail is disclosed and removed', async () => {
    // Superseded policy: the thumbnail used to be retained silently. It is a second picture,
    // so it is now reported and dropped while the JFIF segment itself stays valid.
    const outcome = await run('a_jfif_thumb.jpg');
    expect(outcome.verdict).toBe('verified');
    expect(outcome.findings).toContain('OTHER/Embedded thumbnail image');
    const app0 = (bytes: Uint8Array) => readSegments(bytes).find((s) => classify(s).name === 'APP0/JFIF')!.payload!;
    expect(Array.from(app0(outcome.output!).subarray(0, 12)))
      .toEqual(Array.from(app0(fixture('a_jfif_thumb.jpg')).subarray(0, 12)));
    expect(Array.from(app0(outcome.output!).subarray(12))).toEqual([0, 0]);

    const adobe = await run('a_app14_ok.jpg');
    const kept = (bytes: Uint8Array) => readSegments(bytes)
      .filter((s) => classify(s).name === 'APP14/Adobe')
      .map((s) => Array.from(s.payload ?? []));
    expect(kept(adobe.output!)).toEqual(kept(fixture('a_app14_ok.jpg')));
  });

  it('a JFIF whose declared thumbnail is missing, or whose header is truncated, fails closed', async () => {
    for (const file of ['a_jfif_thumb_missing.jpg', 'a_jfif_truncated.jpg', 'a_app14_short.jpg']) {
      await expect(inspectFile(fixture(file)), file).rejects.toBeInstanceOf(MalformedFileError);
      const outcome = await run(file);
      expect(outcome.downloadable, file).toBe(false);
    }
  });

  it('every retained segment of a cleaned JPEG has a modelled length', async () => {
    for (const file of ['dirty.jpg', 'a_jfif_thumb.jpg', 'a_app14_ok.jpg', 'j_icc.jpg', 'j_progressive.jpg']) {
      const outcome = await run(file);
      for (const segment of readSegments(outcome.output!)) {
        expect(segment.padding, `${file}: ${classify(segment).name} still carries unaccounted bytes`).toBeUndefined();
      }
    }
  });
});

describe('P0-B: duplicate retained identities', () => {
  it.each(['b_iccp_equal.png', 'b_iccp_reordered.png'])(
    '%s: two colour profiles cannot both claim the same retained identity', async (file) => {
      const outcome = await run(file);
      expect(contains(fixture(file), CANARY.iccp)).toBe(true);
      noFalseClean(outcome, CANARY.iccp);
    },
  );

  it('a single legitimate profile still verifies', async () => {
    const outcome = await run('b_iccp_single.png');
    expect(outcome.verdict).toBe('verified');
    expect(outcome.findings).toContain('OTHER/Colour profile');
  });

  it('two retained findings that render the same text are not treated as the same evidence', async () => {
    const { verifyClean } = await import('../src/core/pipeline');
    const source = await inspectFile(fixture('c_iccp_valid.png'));
    const other = (await run('c_iccp_named.png')).output!;
    const sourceKept = source.findings.find((f) => !f.removable)!;
    const outputKept = (await inspectFile(other)).findings.find((f) => !f.removable)!;
    // identical display text, and the retained bytes are identical too, so this pair is fine
    expect(outputKept.value).toBe(sourceKept.value);
    const result = await verifyClean(source, { bytes: other, promisedRemovedIds: [], notes: [] });
    expect(result.verdict).toBe('verified');
  });
});

describe('P0-C: colour profile content validity', () => {
  const invalid = [
    ['c_iccp_plaintext.png', 'not compressed at all'],
    ['c_iccp_truncated_zlib.png', 'truncated deflate stream'],
    ['c_iccp_empty.png', 'empty profile'],
    ['c_iccp_bad_header.png', 'no ICC signature'],
    ['c_iccp_bad_method.png', 'unsupported compression method'],
    ['c_iccp_size_mismatch.png', 'profile disagrees with its own declared size'],
    ['c_iccp_bomb.png', 'decompresses far beyond any real profile'],
  ] as const;

  it.each(invalid)('%s (%s) is refused', async (file) => {
    await expect(inspectFile(fixture(file)), file).rejects.toBeInstanceOf(MalformedFileError);
    const outcome = await run(file);
    expect(outcome.downloadable, file).toBe(false);
    expect(outcome.verdict, file).toBeUndefined();
  });

  it('a genuine profile is accepted, disclosed and kept byte for byte', async () => {
    const outcome = await run('c_iccp_valid.png');
    expect(outcome.verdict).toBe('verified');
    expect(outcome.findings).toContain('OTHER/Colour profile');
    const body = (bytes: Uint8Array) => {
      const chunk = readChunks(bytes).find((c) => c.type === 'iCCP')!;
      return Array.from(chunk.data.subarray(chunk.data.indexOf(0) + 1));
    };
    expect(body(outcome.output!)).toEqual(body(fixture('c_iccp_valid.png')));
  });

  it('name normalisation still changes only the free text name', async () => {
    const outcome = await run('c_iccp_named.png');
    expect(outcome.findings).toContain('OTHER/Colour profile name');
    expect(contains(outcome.output, CANARY.iccp)).toBe(false);
    const after = readChunks(outcome.output!).find((c) => c.type === 'iCCP')!;
    expect(new TextDecoder().decode(after.data.subarray(0, after.data.indexOf(0)))).toBe('ICC profile');
    const body = (chunk: { data: Uint8Array }) => Array.from(chunk.data.subarray(chunk.data.indexOf(0) + 1));
    expect(body(after)).toEqual(body(readChunks(fixture('c_iccp_named.png')).find((c) => c.type === 'iCCP')!));
    expect(outcome.verdict).toBe('verified');
  });
});

describe('P0-D: metadata on the PDF page tree', () => {
  const metadataOnTree = async (bytes: Uint8Array) => {
    const doc = await load(bytes);
    const found: string[] = [];
    const seen = new Set<string>();
    const walk = (node: unknown, path: string) => {
      let dict = node;
      if (node instanceof PDFRef) {
        if (seen.has(node.tag)) return;
        seen.add(node.tag);
        dict = doc.context.lookup(node);
      }
      if (!(dict instanceof PDFDict)) return;
      if (dict.get(PDFName.of('Metadata'))) found.push(`${path}:Metadata`);
      if (dict.get(PDFName.of('PieceInfo'))) found.push(`${path}:PieceInfo`);
      const kids = dict.get(PDFName.of('Kids'));
      if (!kids) return;
      const array = doc.context.lookup(kids);
      if (array instanceof PDFArray) {
        for (let i = 0; i < array.size(); i++) walk(array.get(i), `${path}/${i}`);
      }
    };
    walk(doc.catalog.get(PDFName.of('Pages')), 'Pages');
    return found;
  };

  it.each(['d_pages_xmp_root.pdf', 'd_pages_xmp_nested.pdf', 'd_pages_pieceinfo.pdf'])(
    '%s: the page tree entry is reported, removed and gone on reparse', async (file) => {
      expect(await metadataOnTree(fixture(file)), 'fixture must carry it').not.toEqual([]);
      const outcome = await run(file);
      expect(outcome.findings!.length, file).toBeGreaterThan(2);   // more than just Title/Author
      noFalseClean(outcome, CANARY.pages);
      if (outcome.output) {
        expect(await metadataOnTree(outcome.output), `${file}: still on the tree`).toEqual([]);
      }
    },
  );

  it('the compressed page-tree XMP is gone even though no plaintext signature was ever visible', async () => {
    const source = fixture('d_pages_xmp_root.pdf');
    expect(latin1(source).includes('xmpmeta'), 'the attack hides the signature').toBe(false);
    const outcome = await run('d_pages_xmp_root.pdf');
    if (outcome.verdict === 'verified') {
      const doc = await load(outcome.output!);
      const pages = doc.context.lookup(doc.catalog.get(PDFName.of('Pages')));
      expect((pages as PDFDict).get(PDFName.of('Metadata'))).toBeUndefined();
    }
  });

  it('a cyclic page tree is handled deterministically and never verified by accident', async () => {
    const outcome = await run('d_pages_cycle.pdf');
    expect(contains(outcome.output, CANARY.pages) && outcome.verdict === 'verified').toBe(false);
  });

  it('ordinary documents keep their pages, text, annotations, widgets and shared objects', async () => {
    for (const file of ['dirty.pdf', 'd_multi_meta.pdf', 'r_reachable_only_via_annot.pdf', 'r_form_widget.pdf', 'r_annot_richtext.pdf']) {
      const outcome = await run(file);
      expect(outcome.verdict, file).toBe('verified');
      const before = await load(fixture(file));
      const after = await load(outcome.output!);
      expect(after.getPageCount(), file).toBe(before.getPageCount());
      const raw = latin1(outcome.output!);
      if (file === 'r_reachable_only_via_annot.pdf') {
        expect(raw).toContain('/Image');
        expect(raw).toContain('/BBox');
      }
      if (file === 'r_form_widget.pdf') {
        expect(raw).toContain('(EmployeeNumber)');
        expect(raw).toContain('(12345)');
      }
      if (file === 'r_annot_richtext.pdf') {
        expect(raw).toContain('Please double check row 12');
      }
    }
  });
});

describe('final self-attack: combinations', () => {
  it('a legal JFIF thumbnail plus appended payload keeps the thumbnail and loses the payload', async () => {
    const outcome = await run('a_jfif_thumb_pad.jpg');
    expect(contains(fixture('a_jfif_thumb_pad.jpg'), CANARY.jfif)).toBe(true);
    noFalseClean(outcome, CANARY.jfif);
    expect(contains(outcome.output, CANARY.jfif)).toBe(false);
    expect(outcome.findings).toContain('OTHER/Extra bytes inside a picture data block');

    const jfifOf = (bytes: Uint8Array) => readSegments(bytes).find((s) => classify(s).name === 'APP0/JFIF')!.payload!;
    const after = jfifOf(outcome.output!);
    const before = jfifOf(fixture('a_jfif_thumb.jpg'));
    // the JFIF header is intact; the thumbnail and the appended payload are both gone
    expect(Array.from(after.subarray(0, 12))).toEqual(Array.from(before.subarray(0, 12)));
    expect(Array.from(after.subarray(12))).toEqual([0, 0]);
    expect(outcome.findings).toContain('OTHER/Embedded thumbnail image');
    expect(outcome.verdict).toBe('verified');
  });
});
