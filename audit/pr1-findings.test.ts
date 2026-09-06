/**
 * PR #1 independent review findings, investigated against the code rather than the report.
 * Written first as reproduction, then kept as the mechanism-level regression for both.
 */
import { describe, expect, it, vi } from 'vitest';
import { fixture, run } from './harness';
import { inspectFile, verifyClean } from '../src/core/pipeline';
import { readChunks } from '../src/core/png';
import { MalformedFileError } from '../src/core/types';
import { Finding, InspectionReport } from '../src/core/types';

describe('Finding A: what the kept-finding exemption actually allows', () => {
  it('a kept finding whose content changed keeps the same id and must not be exempt', async () => {
    // Both files carry an ICC profile, so both reports contain APP2/ICC#profile, kept,
    // with a stated reason. The profiles are completely different.
    const sourceReport = await inspectFile(fixture('j_icc.jpg'));
    const swappedOutput = (await run('j_icc_multichunk.jpg')).output!;

    const sourceKept = sourceReport.findings.find((f) => f.id === 'APP2/ICC#profile')!;
    const outputKept = (await inspectFile(swappedOutput)).findings.find((f) => f.id === 'APP2/ICC#profile')!;
    expect(sourceKept.removable).toBe(false);
    expect(outputKept.removable).toBe(false);
    expect(outputKept.value).not.toBe(sourceKept.value);   // different profile entirely

    const result = await verifyClean(sourceReport, { bytes: swappedOutput, promisedRemovedIds: [], notes: [] });
    expect(result.verdict).not.toBe('verified');
  });

  it('a kept finding with no stated reason must not be exempt', async () => {
    vi.resetModules();
    const real = await vi.importActual<typeof import('../src/core/jpeg')>('../src/core/jpeg');
    const undisclosedKept: Finding = {
      id: 'APP2/ICC#profile', category: 'OTHER', label: 'Colour profile',
      value: 'kept without saying why', container: 'APP2/ICC', key: 'profile',
      removable: false,   // no keptReason
    };
    vi.doMock('../src/core/jpeg', () => ({
      ...real,
      inspect: async (bytes: Uint8Array): Promise<InspectionReport> => ({
        format: 'jpeg', byteLength: bytes.length, findings: [undisclosedKept], notes: [],
      }),
    }));
    const pipeline = await import('../src/core/pipeline');
    const source: InspectionReport = {
      format: 'jpeg', byteLength: 10, notes: [],
      findings: [{ ...undisclosedKept, keptReason: 'Needed to display the image with the right colours' }],
    };
    const result = await pipeline.verifyClean(source, { bytes: fixture('clean.jpg'), promisedRemovedIds: [], notes: [] });
    expect(result.verdict).not.toBe('verified');
    vi.doUnmock('../src/core/jpeg');
    vi.resetModules();
  });

  it('the legitimate case still passes: unchanged, disclosed, with a reason', async () => {
    for (const file of ['j_icc.jpg', 'p_iccp_name.png', 'p_full.png']) {
      const outcome = await run(file);
      expect(outcome.verdict, file).toBe('verified');
      const kept = outcome.verification!.outputReport.findings.filter((f) => !f.removable);
      expect(kept.length, file).toBeGreaterThan(0);
      for (const finding of kept) {
        expect(finding.keptReason, `${file}: ${finding.label}`).toBeTruthy();
        const original = outcome.report!.findings.find((f) => f.id === finding.id)!;
        expect(original, `${file}: ${finding.id} missing from the source report`).toBeTruthy();
        expect(finding.value, `${file}: ${finding.id} value changed`).toBe(original.value);
      }
    }
  });
});

describe('Finding B: malformed PNG colour profile structures', () => {
  const malformed = [
    ['p_iccp_no_nul.png', 'no profile name terminator'],
    ['p_iccp_no_method.png', 'no compression method byte'],
    ['p_iccp_bad_method.png', 'unsupported compression method'],
    ['p_iccp_no_payload.png', 'no compressed profile data'],
    ['p_iccp_empty_name.png', 'empty profile name'],
  ] as const;

  it.each(malformed)('%s (%s) fails closed', async (file) => {
    await expect(inspectFile(fixture(file))).rejects.toBeInstanceOf(MalformedFileError);
    const outcome = await run(file);
    expect(outcome.downloadable).toBe(false);
    expect(outcome.verdict).toBeUndefined();
  });

  it('a well formed profile is still accepted and rebuilt correctly', async () => {
    const outcome = await run('p_iccp_ok.png');
    expect(outcome.verdict).toBe('verified');
    const before = readChunks(fixture('p_iccp_ok.png')).find((c) => c.type === 'iCCP')!;
    const after = readChunks(outcome.output!).find((c) => c.type === 'iCCP')!;
    // name 'sRGB' is not the label, so it is normalised; everything after the NUL is untouched
    const tail = (data: Uint8Array) => Array.from(data.subarray(data.indexOf(0) + 1));
    expect(tail(after.data)).toEqual(tail(before.data));
    expect(new TextDecoder().decode(after.data.subarray(0, after.data.indexOf(0)))).toBe('ICC profile');
  });

  it('a rebuilt profile chunk is never left without a method byte or payload', async () => {
    for (const file of ['p_iccp_name.png', 'p_iccp_ok.png', 'p_full.png']) {
      const outcome = await run(file);
      const iccp = readChunks(outcome.output!).find((c) => c.type === 'iCCP');
      if (!iccp) continue;
      const nul = iccp.data.indexOf(0);
      expect(nul, `${file}: rebuilt chunk lost its terminator`).toBeGreaterThan(0);
      expect(iccp.data.length - nul - 1, `${file}: rebuilt chunk has no method byte and payload`).toBeGreaterThan(1);
      expect(iccp.data[nul + 1], `${file}: compression method changed`).toBe(0);
    }
  });
});
