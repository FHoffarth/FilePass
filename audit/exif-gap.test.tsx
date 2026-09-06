// @vitest-environment jsdom
/**
 * A recognised EXIF container that yields no decoded tags is not a clean file.
 * Against f223bea this JPEG produced zero findings, so the interface said "Nothing hidden
 * was found" and never offered to clean it, leaving the segment in the file the user shares.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import App from '../src/ui/App';
import { contains, fixture, run } from './harness';
import { readSegments, classify } from '../src/core/jpeg';
import { inspectFile } from '../src/core/pipeline';

const CANARY = 'FILEPASS_EXIFGAP_9001';

afterEach(cleanup);

const upload = async (name: string) => {
  const user = userEvent.setup();
  render(<App />);
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  const bytes = fixture(name);
  await user.upload(input, new File([bytes], name, { type: 'image/jpeg' }));
  return user;
};

describe('an EXIF container FilePass cannot read', () => {
  it('is recognised structurally even though no tag decodes', async () => {
    const source = fixture('x_exif_unparsable.jpg');
    expect(readSegments(source).map((s) => classify(s).name)).toContain('APP1/EXIF');
    const { decodeTags } = await import('../src/core/decode');
    expect(await decodeTags(source), 'the premise: nothing can be decoded').toEqual([]);
  });

  it('produces a finding rather than silence', async () => {
    const report = await inspectFile(fixture('x_exif_unparsable.jpg'));
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings.map((f) => f.label)).toContain('Embedded camera data');
    expect(report.findings.every((f) => f.container === 'APP1/EXIF')).toBe(true);
  });

  it('can be cleaned, and the segment is gone from the output', async () => {
    const outcome = await run('x_exif_unparsable.jpg');
    expect(outcome.verdict).toBe('verified');
    expect(outcome.downloadable).toBe(true);
    expect(readSegments(outcome.output!).map((s) => classify(s).name)).not.toContain('APP1/EXIF');
    expect(contains(fixture('x_exif_unparsable.jpg'), CANARY)).toBe(true);
    expect(contains(outcome.output, CANARY)).toBe(false);
    expect(outcome.verification!.outputReport.findings).toEqual([]);
  });

  it('the interface never calls it clean, and offers the copy', async () => {
    const user = await upload('x_exif_unparsable.jpg');
    await screen.findByText(/What we found/);
    expect(document.body.textContent).not.toMatch(/Nothing hidden was found/);
    expect(screen.getByText('Embedded camera data')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /create clean copy/i }));
    await screen.findByText(/Ready to share/);
    expect(screen.getByRole('button', { name: /download clean copy/i })).toBeInTheDocument();
  });

  it('ordinary decodable EXIF is unchanged: named tags, no generic stand-in', async () => {
    const report = await inspectFile(fixture('x_exif_readable.jpg'));
    expect(report.findings.map((f) => f.label)).toEqual(expect.arrayContaining(['Author', 'Camera model']));
    expect(report.findings.map((f) => f.label)).not.toContain('Embedded camera data');
    const outcome = await run('x_exif_readable.jpg');
    expect(outcome.verdict).toBe('verified');
    expect(readSegments(outcome.output!).map((s) => classify(s).name)).not.toContain('APP1/EXIF');
  });

  it('a file with genuinely nothing hidden still says so', async () => {
    await upload('clean.jpg');
    expect(await screen.findByText(/Nothing hidden was found/)).toBeInTheDocument();
  });
});
