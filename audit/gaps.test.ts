import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { CANARIES, contains, fixture, run } from './harness';

// This file owns audit/gaps-notes.txt and nothing else. The same observations used to be
// appended to audit/evidence-notes.txt, which evidence.test.ts truncates and rewrites: with
// vitest running test files in parallel, whichever finished last decided what the tracked
// file ended up holding, and four lines of evidence disappeared whenever the owner won.
const notes: string[] = [];
const note = (line: string) => { notes.push(line); };

describe('annotation metadata coverage', () => {
  it('PDF annotation metadata (comment author, timestamps) is inspected and removed', async () => {
    const outcome = await run('d_annotation.pdf');
    note(`d_annotation.pdf findings=${JSON.stringify(outcome.findings)} verdict=${outcome.verdict}` +
      ` canaryInSource=${contains(fixture('d_annotation.pdf'), CANARIES.author)}` +
      ` canaryInOutput=${contains(outcome.output, CANARIES.author)}`);
    expect(contains(fixture('d_annotation.pdf'), CANARIES.author)).toBe(true);
    expect(outcome.findings).toContain('IDENTITY/Comment author (page 1)');
    expect(contains(outcome.output, CANARIES.author)).toBe(false);
    expect(outcome.verdict).toBe('verified');
  });
});

describe('the combined case', () => {
  it('a PDF with both Info metadata and an annotation author is only verified once both are gone', async () => {
    const outcome = await run('d_annot_plus_info.pdf');
    note(`d_annot_plus_info.pdf findings=${JSON.stringify(outcome.findings)} verdict=${outcome.verdict}` +
      ` downloadable=${outcome.downloadable} canaryInOutput=${contains(outcome.output, CANARIES.author)}`);
    expect(outcome.verdict).toBe('verified');
    expect(outcome.downloadable).toBe(true);
    expect(contains(outcome.output, CANARIES.author)).toBe(false);
  });
});

describe('entropy stream walking', () => {
  it('progressive and restart-marker JPEGs survive the new scan walker intact', async () => {
    const { readSegments } = await import('../src/core/jpeg');
    for (const file of ['j_progressive.jpg', 'j_restart.jpg']) {
      const source = fixture(file);
      const outcome = await run(file);
      note(`${file}: scans=${readSegments(source).filter((s) => s.isScan).length} findings=${outcome.findings?.length} verdict=${outcome.verdict}`);
      expect(outcome.verdict, file).toBe('verified');
      expect(outcome.findings!.length).toBeGreaterThan(0);
      const a = readSegments(source).filter((s) => s.isScan);
      const b = readSegments(outcome.output!).filter((s) => s.isScan);
      expect(b.length, file).toBe(a.length);
      for (let i = 0; i < a.length; i++) {
        expect(Array.from(outcome.output!.subarray(b[i].start, b[i].end)), file)
          .toEqual(Array.from(source.subarray(a[i].start, a[i].end)));
      }
    }
  });
});

describe('write notes', () => {
  it('dumps observations', () => {
    writeFileSync('audit/gaps-notes.txt', notes.join('\n'));
    expect(notes.length).toBeGreaterThan(0);
  });
});
