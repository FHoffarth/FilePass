// @vitest-environment jsdom
/**
 * The remaining V0.1 items, as behaviour. Against 2287d689: several EXIF blocks produced no
 * finding at all, a slow file finishing after a fast one overwrote the newer result, and an
 * error left focus on a hidden input.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import App from '../src/ui/App';
import { fixture, run } from './harness';
import { readSegments, classify } from '../src/core/jpeg';
import { inspectFile } from '../src/core/pipeline';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetModules(); });

const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };
const file = (name: string) => new File([fixture(name)], name, { type: MIME[name.split('.').pop()!] });
const input = () => document.querySelector('input[type=file]') as HTMLInputElement;
const exifBlocks = (bytes: Uint8Array) => readSegments(bytes).filter((s) => classify(s).name === 'APP1/EXIF');

describe('A: more than one EXIF block', () => {
  it('is reported, cleaned to a supported state, and keeps the orientation', async () => {
    const source = fixture('v01_three_exif.jpg');
    expect(exifBlocks(source).length).toBe(3);

    const report = await inspectFile(source);
    expect(report.findings.map((f) => f.label)).toContain('More than one block of camera data');

    const outcome = await run('v01_three_exif.jpg');
    expect(outcome.verdict).toBe('verified');
    const after = exifBlocks(outcome.output!);
    expect(after.length, 'one supported block remains').toBe(1);
    expect(after[0].payload!.length, 'the orientation-only block FilePass writes').toBe(32);

    const exifr = (await import('exifr')).default;
    const parsed: any = await exifr.parse(outcome.output! as any, { ifd0: true, mergeOutput: false, translateKeys: false, translateValues: false } as any);
    expect(parsed?.ifd0?.['274'], 'orientation survives').toBe(6);
    expect((await inspectFile(outcome.output!)).findings).toEqual([]);
  });

  it('a single ordinary EXIF block is untouched by the rule', async () => {
    const report = await inspectFile(fixture('x_exif_readable.jpg'));
    expect(report.findings.map((f) => f.label)).not.toContain('More than one block of camera data');
    expect((await run('x_exif_readable.jpg')).verdict).toBe('verified');
  });

  it('the interface offers the clean copy instead of calling the file clean', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.upload(input(), file('v01_three_exif.jpg'));
    await screen.findByText(/What we found/);
    expect(document.body.textContent).not.toMatch(/Nothing hidden was found/);
    await user.click(screen.getByRole('button', { name: /create clean copy/i }));
    await screen.findByText(/Ready to share/);
  });
});

describe('B: a second file while the first is still working', () => {
  /**
   * Every run the mocked pipeline starts, with a promise that settles when that run has
   * genuinely finished - returned or thrown. These tests used to assert at a fixed point on
   * the wall clock instead, which is a guess about how long the work takes: on an idle machine
   * it left about 400 ms of slack, and a machine under memory pressure can spend that on a
   * garbage collection pause. Waiting for the work itself is both stabler and stricter, because
   * a wall-clock wait that expires early does not fail - it quietly stops testing the race.
   */
  const tracker = () => {
    const runs: Promise<unknown>[] = [];
    return {
      track: <T,>(work: Promise<T>): Promise<T> => { runs.push(work.catch(() => undefined)); return work; },
      finished: () => Promise.all(runs),
    };
  };

  /**
   * Inspection that finishes in the order the test chooses, not the order it was called. The
   * delay can be keyed on the format or on which call it is, and the second matters: a test
   * where the abandoned run happens to finish first proves nothing, because the newer result
   * lands last and covers the older one whether or not anything guards against it.
   */
  const withDelays = async (delays: Record<string, number> | ((format: string, call: number) => number)) => {
    const runs = tracker();
    let calls = 0;
    const real = await vi.importActual<typeof import('../src/core/pipeline')>('../src/core/pipeline');
    vi.doMock('../src/core/pipeline', () => ({
      ...real,
      inspectFile: (bytes: Uint8Array) => runs.track((async () => {
        const call = calls++;
        const report = await real.inspectFile(bytes);
        const wait = typeof delays === 'function' ? delays(report.format, call) : delays[report.format] ?? 0;
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        return report;
      })()),
    }));
    return { App: (await import('../src/ui/App')).default, runs };
  };

  it('the slower first file cannot overwrite the newer one', async () => {
    const { App: Fresh, runs } = await withDelays({ jpeg: 500, png: 0 });
    const user = userEvent.setup();
    render(<Fresh />);
    await user.upload(input(), file('dirty.jpg'));     // slow
    await user.upload(input(), file('dirty.png'));     // fast, and chosen second
    await runs.finished();                             // including the slow one, which lost

    await waitFor(() => expect(screen.getByText('dirty.png')).toBeInTheDocument());
    expect(document.body.textContent).not.toContain('dirty.jpg');
    expect(screen.getByText('PNG image')).toBeInTheDocument();
  });

  it('a reset during processing is not undone when the old run finishes', async () => {
    // Both files are JPEGs, so a delay keyed on the format would slow them equally and the
    // abandoned run would finish first - which is no test at all. The first call is the slow one.
    const { App: Fresh, runs } = await withDelays((_format, call) => (call === 0 ? 500 : 0));
    const user = userEvent.setup();
    render(<Fresh />);
    await user.upload(input(), file('dirty.jpg'));
    // Starting over is what a user can actually do here: the reset button lives on the result
    // screen, but the drop zone stays available while a file is being read. A click on it used
    // to sit here as well - it asserted nothing, opened nothing under jsdom, and was where the
    // test failed under load, so it is gone rather than made tolerant.
    await user.upload(input(), file('clean.jpg'));
    await runs.finished();

    await waitFor(() => expect(screen.getByText('clean.jpg')).toBeInTheDocument());
    expect(document.body.textContent).not.toContain('dirty.jpg');
  });

  it('an older run that fails cannot replace the newer result with an error', async () => {
    const runs = tracker();
    const real = await vi.importActual<typeof import('../src/core/pipeline')>('../src/core/pipeline');
    vi.doMock('../src/core/pipeline', () => ({
      ...real,
      inspectFile: (bytes: Uint8Array) => runs.track((async () => {
        const report = await real.inspectFile(bytes);
        if (report.format === 'jpeg') {
          await new Promise((resolve) => setTimeout(resolve, 500));
          throw new Error('the older run failed late');
        }
        return report;
      })()),
    }));
    const Fresh = (await import('../src/ui/App')).default;
    const user = userEvent.setup();
    render(<Fresh />);
    await user.upload(input(), file('dirty.jpg'));
    await user.upload(input(), file('dirty.png'));
    await runs.finished();                             // including the one that threw

    await waitFor(() => expect(screen.getByText('dirty.png')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a file chosen during cleaning wins over the finishing clean', async () => {
    const runs = tracker();
    const real = await vi.importActual<typeof import('../src/core/pipeline')>('../src/core/pipeline');
    vi.doMock('../src/core/pipeline', () => ({
      ...real,
      cleanAndVerify: (bytes: Uint8Array, report: any) => runs.track((async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return real.cleanAndVerify(bytes, report);
      })()),
    }));
    const Fresh = (await import('../src/ui/App')).default;
    const user = userEvent.setup();
    render(<Fresh />);
    await user.upload(input(), file('dirty.jpg'));
    await user.click(await screen.findByRole('button', { name: /create clean copy/i }));
    await user.upload(input(), file('dirty.png'));      // arrives while the clean is running
    await runs.finished();                              // the clean really did finish, and lost

    await waitFor(() => expect(screen.getByText('dirty.png')).toBeInTheDocument());
    expect(document.body.textContent).not.toMatch(/Ready to share/);
    expect(screen.queryByRole('button', { name: /download clean copy/i })).not.toBeInTheDocument();
  });
});

describe('D: focus after a refusal', () => {
  it('lands on the drop zone so the next file is one keystroke away', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.upload(input(), new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'notes.pdf', { type: 'application/pdf' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/JPEG, PNG and PDF/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole('button', { name: /drop a file/i })).toHaveFocus();
  });
});
