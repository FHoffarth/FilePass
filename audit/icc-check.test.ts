import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { contains, fixture, run } from './harness';

describe('kept-for-rendering containers', () => {
  it('a canary inside the JPEG ICC profile', async () => {
    const outcome = await run('j_icc_canary.jpg');
    const line = `j_icc_canary.jpg | findings=${outcome.findings?.length} | verdict=${outcome.verdict} | download=${outcome.downloadable} | canary in output=${contains(outcome.output, 'FILEPASS_REVIEW_ICCJPEG_1007') ? 'SURVIVES' : 'gone'}`;
    // audit/review-attacks.txt belongs to review-attacks.test.ts, which rewrites it whole.
    // Appending to it from here made the result depend on which file vitest finished last.
    writeFileSync('audit/icc-notes.txt', line + '\n');
    expect(contains(fixture('j_icc_canary.jpg'), 'FILEPASS_REVIEW_ICCJPEG_1007')).toBe(true);
    expect(outcome.output).toBeTruthy();
  });
});
