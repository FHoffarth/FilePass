/**
 * A recognised EXIF block that parses in part is not an accounted-for EXIF block.
 * Against 389e68e both of these reached zero findings, because a valid Orientation tag was
 * enough for the decoder to return an object and the readability signal asked no more.
 */
import { describe, expect, it } from 'vitest';
import { contains, fixture, run } from './harness';
import { readSegments, classify } from '../src/core/jpeg';
import { inspectFile } from '../src/core/pipeline';
import { decodeTags } from '../src/core/decode';

const CANARY = 'FILEPASS_EXIFPART_9101';
const exifSegments = (bytes: Uint8Array) =>
  readSegments(bytes).filter((s) => classify(s).name === 'APP1/EXIF');

describe('EXIF that parses in part', () => {
  it.each(['x_exif_bad_pointer.jpg', 'x_exif_unreferenced.jpg'])(
    '%s: the premise — recognised container, nothing reportable decoded', async (file) => {
      const source = fixture(file);
      expect(exifSegments(source)).toHaveLength(1);
      expect(await decodeTags(source), 'no reportable tag comes out of it').toEqual([]);
    },
  );

  it.each(['x_exif_bad_pointer.jpg', 'x_exif_unreferenced.jpg'])(
    '%s: is reported rather than passed off as clean', async (file) => {
      const report = await inspectFile(fixture(file));
      expect(report.findings.length, 'a recognised block FilePass cannot account for').toBeGreaterThan(0);
      expect(report.findings.map((f) => f.label)).toContain('Embedded camera data');
    },
  );

  it.each(['x_exif_bad_pointer.jpg', 'x_exif_unreferenced.jpg'])(
    '%s: cleans, drops the original block and re-inspects clean', async (file) => {
      const outcome = await run(file);
      expect(outcome.verdict, file).toBe('verified');
      expect(outcome.downloadable, file).toBe(true);
      // the malformed block is gone; what remains is at most the orientation-only block
      // FilePass writes itself, which is 32 bytes and accounted for
      const after = exifSegments(outcome.output!);
      expect(after.length, file).toBeLessThanOrEqual(1);
      for (const segment of after) expect(segment.payload!.length, file).toBe(32);
      expect(outcome.verification!.outputReport.findings, file).toEqual([]);
    },
  );

  it('the unreferenced payload does not survive the clean copy', async () => {
    expect(contains(fixture('x_exif_unreferenced.jpg'), CANARY)).toBe(true);
    const outcome = await run('x_exif_unreferenced.jpg');
    expect(contains(outcome.output, CANARY)).toBe(false);
  });

  it('a well formed orientation-only block stays legitimate and unreported', async () => {
    const report = await inspectFile(fixture('x_exif_orientation_only.jpg'));
    expect(report.findings).toEqual([]);
    expect(report.notes.join(' ')).toMatch(/right way up/);
    const outcome = await run('x_exif_orientation_only.jpg');
    expect(outcome.verdict).toBe('verified');
  });

  it('ordinary reportable EXIF is unchanged, and FilePass own output stays clean', async () => {
    const report = await inspectFile(fixture('x_exif_readable.jpg'));
    expect(report.findings.map((f) => f.label)).toEqual(expect.arrayContaining(['Author', 'Camera model']));
    expect(report.findings.map((f) => f.label)).not.toContain('Embedded camera data');

    // the orientation-only block FilePass writes itself must never be flagged
    const cleaned = (await run('dirty.jpg')).output!;
    expect(exifSegments(cleaned)).toHaveLength(1);
    expect((await inspectFile(cleaned)).findings).toEqual([]);
  });

  it('a fully unreadable block still gets the generic finding', async () => {
    const report = await inspectFile(fixture('x_exif_unparsable.jpg'));
    expect(report.findings.map((f) => f.label)).toContain('Embedded camera data');
  });
});
