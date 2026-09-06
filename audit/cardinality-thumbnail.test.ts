/**
 * Being the right shape is not the same as being allowed to be there, and a structure that
 * is allowed to be there is not automatically allowed to stay undisclosed. These cover the
 * two classes the independent re-attack reproduced against 39049eb: forbidden duplicates of
 * retained structures, and the second picture a JFIF segment can carry.
 */
import { describe, expect, it } from 'vitest';
import { contains, fixture, run } from './harness';
import { readSegments, classify } from '../src/core/jpeg';
import { readChunks } from '../src/core/png';
import { inspectFile } from '../src/core/pipeline';
import { MalformedFileError } from '../src/core/types';

const THUMB = 'FILEPASS_THUMB_7001';
const DUP = 'FILEPASS_DUP_7002';

function noFalseClean(outcome: Awaited<ReturnType<typeof run>>, canary: string) {
  const survives = contains(outcome.output, canary);
  expect(
    survives && outcome.verdict === 'verified',
    `${outcome.file}: verdict=${outcome.verdict} download=${outcome.downloadable} canary=${survives}`,
  ).toBe(false);
}

describe('PNG: retained chunks may not appear more often than the format allows', () => {
  const forbidden = [
    ['f_dup_plte.png', 'two PLTE'],
    ['f_dup_trns.png', 'two tRNS'],
    ['f_dup_gama.png', 'two gAMA'],
    ['f_dup_srgb.png', 'two sRGB'],
    ['f_dup_phys.png', 'two pHYs'],
    ['f_dup_bkgd.png', 'two bKGD'],
    ['f_dup_mixed.png', 'duplicates of two different types at once'],
    ['f_splt_same_name.png', 'two suggested palettes sharing a name'],
    ['b_iccp_equal.png', 'two iCCP'],
  ] as const;

  it.each(forbidden)('%s (%s) is refused', async (file) => {
    await expect(inspectFile(fixture(file)), file).rejects.toBeInstanceOf(MalformedFileError);
    const outcome = await run(file);
    expect(outcome.downloadable, file).toBe(false);
    expect(outcome.verdict, file).toBeUndefined();
  });

  it('a duplicate never rides through a verified copy, even beside an ordinary finding', async () => {
    for (const file of ['f_dup_plte.png', 'f_dup_trns.png', 'f_dup_mixed.png']) {
      expect(contains(fixture(file), DUP), file).toBe(true);
      noFalseClean(await run(file), DUP);
    }
  });

  it('no duplicate is silently dropped to make a file conform', async () => {
    // refusal, not repair: nothing is produced at all
    expect((await run('f_dup_plte.png')).output).toBeUndefined();
  });

  it('legitimately repeatable chunks are still accepted', async () => {
    const outcome = await run('f_splt_repeatable.png');
    expect(outcome.verdict).toBe('verified');
    expect(readChunks(outcome.output!).filter((c) => c.type === 'sPLT')).toHaveLength(2);
  });

  it('ordinary single-instance files are unaffected and keep their chunks', async () => {
    for (const file of ['f_single_ok.png', 'e_fixed_ok.png', 'e_variable_ok.png', 'e_apng_ok.png', 'p_apng.png', 'dirty.png']) {
      const outcome = await run(file);
      expect(outcome.verdict, file).toBe('verified');
    }
    const kept = (bytes: Uint8Array) => readChunks(bytes)
      .filter((c) => ['IHDR', 'PLTE', 'gAMA', 'tRNS', 'sRGB', 'IDAT'].includes(c.type))
      .map((c) => `${c.type}:${Array.from(c.data).join(',')}`);
    const outcome = await run('f_single_ok.png');
    expect(kept(outcome.output!)).toEqual(kept(fixture('f_single_ok.png')));
  });
});

describe('JPEG: a JFIF or Adobe segment may only appear once', () => {
  it.each(['f_jfif_twice.jpg', 'f_app14_twice.jpg'])('%s is refused', async (file) => {
    await expect(inspectFile(fixture(file)), file).rejects.toBeInstanceOf(MalformedFileError);
    const outcome = await run(file);
    expect(outcome.downloadable, file).toBe(false);
    expect(outcome.output, file).toBeUndefined();
  });

  it('a single JFIF and a single Adobe segment are still accepted', async () => {
    for (const file of ['f_jfif_nothumb.jpg', 'a_app14_ok.jpg', 'e_jfif_ok.jpg']) {
      expect((await run(file)).verdict, file).toBe('verified');
    }
  });
});

describe('JPEG: an embedded JFIF thumbnail is disclosed and removed', () => {
  it('a file without a thumbnail reports none', async () => {
    const outcome = await run('f_jfif_nothumb.jpg');
    expect(outcome.findings!.some((f) => f.includes('thumbnail'))).toBe(false);
    expect(outcome.verdict).toBe('verified');
  });

  it.each(['f_jfif_thumb_small.jpg', 'f_jfif_thumb_large.jpg'])(
    '%s: the thumbnail is named, removed and proven absent', async (file) => {
      const outcome = await run(file);
      expect(outcome.findings).toContain('OTHER/Embedded thumbnail image');
      noFalseClean(outcome, THUMB);
      expect(contains(outcome.output, THUMB)).toBe(false);
      expect(outcome.verdict).toBe('verified');

      // the JFIF segment is still there, still valid, and now declares no thumbnail
      const app0 = readSegments(outcome.output!).find((s) => classify(s).name === 'APP0/JFIF')!;
      expect(app0.payload!.length).toBe(14);
      expect(app0.payload![12]).toBe(0);
      expect(app0.payload![13]).toBe(0);
      expect(readSegments(outcome.output!).find((s) => classify(s).name === 'APP0/JFIF')!.padding).toBeUndefined();

      // re-inspecting the cleaned file finds no thumbnail at all
      const reinspected = await inspectFile(outcome.output!);
      expect(reinspected.findings.some((f) => f.container === 'JFIFThumbnail')).toBe(false);
    },
  );

  it('a thumbnail whose declared pixels are missing fails closed', async () => {
    await expect(inspectFile(fixture('f_jfif_thumb_bad.jpg'))).rejects.toBeInstanceOf(MalformedFileError);
    expect((await run('f_jfif_thumb_bad.jpg')).downloadable).toBe(false);
  });

  it('removing the thumbnail never touches the picture itself', async () => {
    for (const file of ['f_jfif_thumb_small.jpg', 'f_jfif_thumb_large.jpg']) {
      const source = fixture(file);
      const outcome = await run(file);
      const scan = (bytes: Uint8Array) => {
        const segment = readSegments(bytes).find((s) => s.isScan)!;
        return Array.from(bytes.subarray(segment.start, segment.end));
      };
      expect(scan(outcome.output!), file).toEqual(scan(source));
    }
  });
});
