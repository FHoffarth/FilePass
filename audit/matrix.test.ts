import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { CANARIES, Outcome, contains, fixture, row, run } from './harness';
import { readSegments, classify } from '../src/core/jpeg';
import { readChunks } from '../src/core/png';

const JPEG_CASES = [
  'dirty.jpg', 'clean.jpg', 'j_orient1.jpg', 'j_orient6.jpg', 'j_orient8.jpg', 'j_icc.jpg',
  'j_cmyk.jpg', 'j_unicode.jpg', 'j_script.jpg', 'j_multi_app1.jpg', 'j_unknown_app.jpg',
  'j_late_exif.jpg', 'j_com_after_sos.jpg', 'j_trailing.jpg', 'j_trailing_dirty.jpg',
  'j_truncated_app.jpg', 'j_truncated_file.jpg', 'fake.png',
];

const PNG_CASES = [
  'dirty.png', 'clean.png', 'p_full.png', 'p_text_after_idat.png', 'p_unknown_chunk.png',
  'p_trailing.png', 'p_palette_trns.png', 'p_apng.png', 'p_bad_length.png', 'p_truncated.png',
];

const PDF_CASES = [
  'dirty.pdf', 'no_metadata.pdf', 'signed.pdf', 'malformed.pdf', 'empty.pdf',
  'd_visible_only.pdf', 'd_multi_meta.pdf', 'd_custom_keys.pdf', 'd_truncated.pdf',
  'd_encrypted.pdf', 'd_leading_junk.pdf', 'd_trailing.pdf', 'd_incremental.pdf', 'd_objstm.pdf',
];

const report: Record<string, Outcome[]> = {};

async function matrix(name: string, cases: string[]) {
  const outcomes: Outcome[] = [];
  for (const file of cases) outcomes.push(await run(file));
  report[name] = outcomes;
  return outcomes;
}

describe('adversarial matrix', () => {
  it('JPEG corpus', async () => {
    const outcomes = await matrix('jpeg', JPEG_CASES);
    const lines = outcomes.map(row);
    writeFileSync('audit/matrix-jpeg.txt', lines.join('\n'));
    expect(outcomes.length).toBe(JPEG_CASES.length);
  });

  it('PNG corpus', async () => {
    const outcomes = await matrix('png', PNG_CASES);
    writeFileSync('audit/matrix-png.txt', outcomes.map(row).join('\n'));
    expect(outcomes.length).toBe(PNG_CASES.length);
  });

  it('PDF corpus', async () => {
    const outcomes = await matrix('pdf', PDF_CASES);
    writeFileSync('audit/matrix-pdf.txt', outcomes.map(row).join('\n'));
    expect(outcomes.length).toBe(PDF_CASES.length);
  });

  it('writes the detail dump', () => {
    const detail = Object.entries(report).flatMap(([group, outcomes]) =>
      outcomes.map((o) => ({
        group,
        file: o.file,
        stage: o.stage,
        verdict: o.verdict,
        downloadable: o.downloadable,
        error: o.error,
        errorType: o.errorType,
        blocked: o.blocked,
        findings: o.findings,
        notes: o.notes,
        promised: o.promised,
        removed: o.removed,
        surviving: o.surviving,
        introduced: o.introduced,
        outputBytes: o.output?.length,
        canaries: o.output
          ? Object.entries(CANARIES).filter(([, v]) => contains(o.output, v)).map(([k]) => k)
          : undefined,
      })),
    );
    writeFileSync('audit/matrix.json', JSON.stringify(detail, null, 1));
    expect(detail.length).toBeGreaterThan(0);
  });
});

describe('structural evidence', () => {
  it('records JPEG segment layout before and after cleaning', async () => {
    const lines: string[] = [];
    for (const file of JPEG_CASES) {
      let before: string[] = [];
      let after: string[] = [];
      try { before = readSegments(fixture(file)).map((s) => classify(s).name); } catch (e) { before = ['ERR']; }
      const outcome = await run(file);
      if (outcome.output) {
        try { after = readSegments(outcome.output).map((s) => classify(s).name); } catch { after = ['ERR']; }
      }
      lines.push(`${file}\n  before: ${before.join(', ')}\n  after:  ${after.join(', ') || '-'}`);
    }
    writeFileSync('audit/segments-jpeg.txt', lines.join('\n'));
    expect(lines.length).toBe(JPEG_CASES.length);
  });

  it('records PNG chunk layout before and after cleaning', async () => {
    const lines: string[] = [];
    for (const file of PNG_CASES) {
      let before: string[] = [];
      let after: string[] = [];
      try { before = readChunks(fixture(file)).map((c) => c.type); } catch { before = ['ERR']; }
      const outcome = await run(file);
      if (outcome.output) {
        try { after = readChunks(outcome.output).map((c) => c.type); } catch { after = ['ERR']; }
      }
      lines.push(`${file}\n  before: ${before.join(', ')}\n  after:  ${after.join(', ') || '-'}`);
    }
    writeFileSync('audit/chunks-png.txt', lines.join('\n'));
    expect(lines.length).toBe(PNG_CASES.length);
  });
});
