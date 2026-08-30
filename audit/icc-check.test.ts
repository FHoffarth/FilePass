import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { contains, fixture, run } from './harness';

describe('kept-for-rendering containers', () => {
  it('a canary inside the JPEG ICC profile', async () => {
    const outcome = await run('j_icc_canary.jpg');
    const line = `j_icc_canary.jpg | findings=${outcome.findings?.length} | verdict=${outcome.verdict} | download=${outcome.downloadable} | canary in output=${contains(outcome.output, 'FILEPASS_REVIEW_ICCJPEG_1007') ? 'SURVIVES' : 'gone'}`;
    appendFileSync('audit/review-attacks.txt', '\n' + line + '\n');
    expect(contains(fixture('j_icc_canary.jpg'), 'FILEPASS_REVIEW_ICCJPEG_1007')).toBe(true);
    expect(outcome.output).toBeTruthy();
  });
});
