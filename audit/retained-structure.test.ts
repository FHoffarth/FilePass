/**
 * Retained structure must be accounted for by the same rule that decides to retain it.
 * These cover the two classes the independent re-review reproduced against 36bbe4d:
 * a JPEG APP0 that only looks like JFIF, and PNG chunks kept without a payload boundary.
 * Every case asserts the final verdict, not just what the parser reported.
 */
import { describe, expect, it } from 'vitest';
import { contains, fixture, run } from './harness';
import { readSegments, classify } from '../src/core/jpeg';
import { readChunks } from '../src/core/png';
import { inspectFile, verifyClean } from '../src/core/pipeline';
import { MalformedFileError } from '../src/core/types';

const JFIF = 'FILEPASS_RETAINED_JFIF_4001';
const CHUNK = 'FILEPASS_RETAINED_CHUNK_4002';

/** The whole point: a verified, downloadable copy may not carry unaccounted bytes. */
function noFalseClean(outcome: Awaited<ReturnType<typeof run>>, canary: string) {
  const survives = contains(outcome.output, canary);
  expect(
    survives && outcome.verdict === 'verified',
    `${outcome.file}: verdict=${outcome.verdict} download=${outcome.downloadable} canary=${survives}`,
  ).toBe(false);
}

describe('P0-1: only a real JFIF identifier reaches the retained JFIF path', () => {
  it('J1: a valid JFIF is retained and verifies', async () => {
    const outcome = await run('e_jfif_ok.jpg');
    expect(outcome.verdict).toBe('verified');
    expect(readSegments(outcome.output!).map((s) => classify(s).name)).toContain('APP0/JFIF');
  });

  it('J2: a valid JFIF keeps its header while its thumbnail is disclosed and removed', async () => {
    const outcome = await run('a_jfif_thumb.jpg');
    const app0 = (bytes: Uint8Array) => readSegments(bytes).find((s) => classify(s).name === 'APP0/JFIF')!.payload!;
    expect(Array.from(app0(outcome.output!).subarray(0, 12)))
      .toEqual(Array.from(app0(fixture('a_jfif_thumb.jpg')).subarray(0, 12)));
    expect(outcome.findings).toContain('OTHER/Embedded thumbnail image');
    expect(outcome.verdict).toBe('verified');
  });

  it.each(['e_jfif_x.jpg', 'e_jfif_alt.jpg'])(
    '%s: an APP0 that only looks like JFIF is not retained as one', async (file) => {
      expect(contains(fixture(file), JFIF)).toBe(true);
      const outcome = await run(file);
      noFalseClean(outcome, JFIF);
      // it must be classified outside the trusted structure, and therefore reported
      expect(readSegments(fixture(file)).map((s) => classify(s).name)).not.toContain('APP0/JFIF');
      expect(outcome.findings).not.toEqual([]);
      expect(contains(outcome.output, JFIF)).toBe(false);
    },
  );

  it('J5: a short JFIF-like prefix is not retained either', async () => {
    const outcome = await run('e_jfif_short.jpg');
    noFalseClean(outcome, JFIF);
    expect(contains(outcome.output, JFIF)).toBe(false);
  });

  it('J6/J7: appended payload is accounted for, a missing declared thumbnail fails closed', async () => {
    const padded = await run('a_jfif_pad.jpg');
    noFalseClean(padded, 'FILEPASS_FINAL_JFIF_2001');
    expect(padded.findings).toContain('OTHER/Extra bytes inside a picture data block');
    await expect(inspectFile(fixture('a_jfif_thumb_missing.jpg'))).rejects.toBeInstanceOf(MalformedFileError);
  });

  it('no retained JPEG segment in any cleaned output carries unaccounted bytes', async () => {
    for (const file of ['e_jfif_ok.jpg', 'a_jfif_thumb.jpg', 'dirty.jpg', 'j_icc.jpg', 'j_cmyk.jpg']) {
      const outcome = await run(file);
      for (const segment of readSegments(outcome.output!)) {
        expect(segment.padding, `${file}: ${classify(segment).name}`).toBeUndefined();
      }
    }
  });
});

describe('P0-2: every retained PNG chunk accounts for its own payload', () => {
  const malformed = [
    ['e_gama_long.png', 'gAMA with appended bytes'],
    ['e_gama_short.png', 'gAMA too short'],
    ['e_phys_long.png', 'pHYs with appended bytes'],
    ['e_chrm_short.png', 'cHRM too short'],
    ['e_srgb_long.png', 'sRGB with appended bytes'],
    ['e_cicp_long.png', 'cICP with appended bytes'],
    ['e_actl_long.png', 'acTL with appended bytes'],
    ['e_fctl_short.png', 'fcTL too short'],
    ['e_fdat_short.png', 'fdAT without a sequence number'],
    ['e_trns_long.png', 'tRNS longer than the palette'],
    ['e_sbit_wrong.png', 'sBIT of the wrong width for the colour type'],
    ['e_bkgd_long.png', 'bKGD with appended bytes'],
    ['e_hist_wrong.png', 'hIST that does not match the palette'],
    ['e_splt_pad.png', 'sPLT with trailing bytes'],
    ['e_plte_bad.png', 'PLTE that is not a whole number of entries'],
  ] as const;

  it.each(malformed)('%s (%s) is refused', async (file) => {
    await expect(inspectFile(fixture(file)), file).rejects.toBeInstanceOf(MalformedFileError);
    const outcome = await run(file);
    expect(outcome.downloadable, file).toBe(false);
    expect(outcome.verdict, file).toBeUndefined();
  });

  it('a canary appended to a retained chunk never survives a verified copy', async () => {
    for (const file of ['e_gama_long.png', 'e_phys_long.png', 'e_srgb_long.png', 'e_bkgd_long.png', 'e_splt_pad.png', 'e_actl_long.png']) {
      expect(contains(fixture(file), CHUNK), file).toBe(true);
      noFalseClean(await run(file), CHUNK);
    }
  });

  it.each(['e_fixed_ok.png', 'e_variable_ok.png', 'e_apng_ok.png'])(
    '%s: legitimate retained chunks verify and survive byte for byte', async (file) => {
      const outcome = await run(file);
      expect(outcome.verdict, file).toBe('verified');
      // the profile name is deliberately normalised, so iCCP is compared by its profile body
      const kept = (bytes: Uint8Array) => readChunks(bytes)
        .filter((c) => c.type !== 'IEND' && c.type !== 'iCCP')
        .map((c) => `${c.type}:${Array.from(c.data).join(',')}`);
      expect(kept(outcome.output!), file).toEqual(kept(fixture(file)));
      const profile = (bytes: Uint8Array) => {
        const chunk = readChunks(bytes).find((c) => c.type === 'iCCP');
        return chunk ? Array.from(chunk.data.subarray(chunk.data.indexOf(0) + 1)) : null;
      };
      expect(profile(outcome.output!), file).toEqual(profile(fixture(file)));
    },
  );

  it('APNG ordering and frame data are unchanged', async () => {
    const outcome = await run('e_apng_ok.png');
    expect(readChunks(outcome.output!).map((c) => c.type))
      .toEqual(['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'IEND']);
    const frames = (bytes: Uint8Array) => readChunks(bytes)
      .filter((c) => c.type === 'IDAT' || c.type === 'fdAT')
      .map((c) => Array.from(c.data));
    expect(frames(outcome.output!)).toEqual(frames(fixture('e_apng_ok.png')));
  });
});

describe('retained evidence that disappears cannot be verified', () => {
  it('a cleaner that drops the colour profile does not reach verified', async () => {
    const source = await inspectFile(fixture('e_profile_present.png'));
    expect(source.findings.some((f) => !f.removable)).toBe(true);
    const result = await verifyClean(source, {
      bytes: fixture('e_profile_absent.png'), promisedRemovedIds: [], notes: [],
    });
    expect(result.missingRetained.map((f) => f.label)).toContain('Colour profile');
    expect(result.verdict).not.toBe('verified');
  });

  it('a cleaner that swaps the profile for a different one does not reach verified', async () => {
    const source = await inspectFile(fixture('e_profile_present.png'));
    const other = (await run('c_iccp_valid.png')).output!;
    const result = await verifyClean(source, { bytes: other, promisedRemovedIds: [], notes: [] });
    expect(result.verdict).not.toBe('verified');
  });

  it('the ordinary retained case is unaffected', async () => {
    const outcome = await run('e_profile_present.png');
    expect(outcome.verdict).toBe('verified');
    expect(outcome.verification!.missingRetained).toEqual([]);
    expect(outcome.verification!.remainingFindings.map((f) => f.label)).toContain('Colour profile');
  });
});
