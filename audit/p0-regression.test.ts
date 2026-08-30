/**
 * The four release blockers from the adversarial audit, written as the behaviour the
 * product contract requires. These fail on d257089 and must pass after the fix.
 * The fixtures and their canaries are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { CANARIES, contains, fixture, run } from './harness';

describe('P0-1 JPEG post-SOS and trailing data', () => {
  it('j_trailing.jpg: appended bytes are reported, removed and proven absent', async () => {
    const outcome = await run('j_trailing.jpg');
    expect(contains(fixture('j_trailing.jpg'), CANARIES.trailing)).toBe(true);
    expect(outcome.findings!.length).toBeGreaterThan(0);          // no longer "nothing found"
    expect(contains(outcome.output, CANARIES.trailing)).toBe(false);
    expect(outcome.verdict).toBe('verified');
  });

  it('j_trailing_dirty.jpg: verified output cannot contain the appended secret', async () => {
    const outcome = await run('j_trailing_dirty.jpg');
    if (outcome.verdict === 'verified') {
      expect(contains(outcome.output, CANARIES.trailing)).toBe(false);
    }
    expect(outcome.downloadable).toBe(true);
    expect(contains(outcome.output, CANARIES.trailing)).toBe(false);
  });

  it('j_com_after_sos.jpg: a COM segment after the scan is seen and removed', async () => {
    const outcome = await run('j_com_after_sos.jpg');
    expect(outcome.findings!.length).toBeGreaterThan(0);
    expect(contains(outcome.output, CANARIES.trailing)).toBe(false);
  });
});

describe('P0-2 / P0-3 PDF orphaned and object-stream objects', () => {
  it('d_multi_meta.pdf: the page level XMP is gone from the bytes, not just from the page dictionary', async () => {
    const outcome = await run('d_multi_meta.pdf');
    expect(contains(outcome.output, CANARIES.author)).toBe(false);
    expect(outcome.verdict).toBe('verified');
  });

  it('d_objstm.pdf: object stream members do not survive as loose objects', async () => {
    const outcome = await run('d_objstm.pdf');
    expect(contains(outcome.output, CANARIES.objstm)).toBe(false);
    expect(outcome.verdict).toBe('verified');
  });

  it('no cleaned PDF output contains an XMP packet', async () => {
    for (const file of ['dirty.pdf', 'd_multi_meta.pdf', 'd_incremental.pdf']) {
      const outcome = await run(file);
      const text = new TextDecoder('latin1').decode(outcome.output!);
      expect(text, file).not.toContain('xmpmeta');
      expect(text, file).not.toContain('/Type /Metadata');
    }
  });
});

describe('P0-4 PDF annotation metadata', () => {
  it('d_annotation.pdf: the comment author is never presented as "nothing hidden"', async () => {
    const outcome = await run('d_annotation.pdf');
    expect(outcome.findings!.length).toBeGreaterThan(0);
    expect(contains(outcome.output, CANARIES.author) && outcome.verdict === 'verified').toBe(false);
  });

  it('d_annot_plus_info.pdf: verified output cannot keep the annotation author', async () => {
    const outcome = await run('d_annot_plus_info.pdf');
    if (outcome.verdict === 'verified') {
      expect(contains(outcome.output, CANARIES.author)).toBe(false);
    }
    expect(outcome.findings!.some((f) => f.startsWith('IDENTITY'))).toBe(true);
  });

  it('visible annotation content is preserved', async () => {
    const outcome = await run('d_annot_plus_info.pdf');
    const text = new TextDecoder('latin1').decode(outcome.output!);
    expect(text).toContain('internal note');  // the comment body is document content, not metadata
    expect(text).toContain('/Annot');
  });
});

describe('P2(b) detected but unproven removal', () => {
  it('a finding still present in the output can never yield verified', async () => {
    const { inspectFile, verifyClean } = await import('../src/core/pipeline');
    const source = fixture('dirty.png');
    const report = await inspectFile(source);
    // cleaner promises nothing and changes nothing: everything is still detected
    const result = await verifyClean(report, { bytes: source, promisedRemovedIds: [], notes: [] });
    expect(result.remainingFindings.length).toBeGreaterThan(0);
    expect(result.verdict).not.toBe('verified');
  });
});

describe('P2(a) source side independent parse', () => {
  it('d_truncated.pdf: a source the independent parser rejects cannot be verified', async () => {
    const outcome = await run('d_truncated.pdf');
    expect(outcome.verdict).not.toBe('verified');
    expect(outcome.downloadable).toBe(false);
    expect(outcome.blocked).toBeTruthy();   // refused outright, not silently reported as clean
  });
});
