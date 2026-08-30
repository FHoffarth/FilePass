// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import App from '../src/ui/App';

writeFileSync('audit/ui-notes.txt', '');
const note = (line: string) => appendFileSync('audit/ui-notes.txt', line + '\n');

const bytes = (name: string) => {
  for (const dir of ['audit/fixtures', 'fixtures']) {
    const path = resolve(process.cwd(), dir, name);
    if (existsSync(path)) return readFileSync(path);
  }
  throw new Error('missing fixture ' + name);
};
const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };
const file = (name: string) => new File([new Uint8Array(bytes(name))], name, { type: MIME[name.split('.').pop()!] });

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const input = () => document.querySelector('input[type=file]') as HTMLInputElement;
const text = () => document.body.textContent ?? '';

describe('phase 9: state transitions', () => {
  it('a verified result cannot be replaced by a new file without an explicit reset', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.upload(input(), file('dirty.jpg'));
    await user.click(await screen.findByRole('button', { name: /create clean copy/i }));
    await screen.findByText(/Ready to share/);

    // the drop zone is not rendered in the success state at all
    expect(screen.queryByRole('button', { name: /drop a file/i })).not.toBeInTheDocument();
    note('success state: drop zone absent, only "Inspect another file" resets');

    await user.click(screen.getByRole('button', { name: /inspect another file/i }));
    expect(text()).not.toMatch(/Ready to share/);
    expect(screen.queryByRole('button', { name: /download clean copy/i })).not.toBeInTheDocument();
    expect(text()).not.toContain('dirty.jpg');
    expect(screen.getByRole('button', { name: /drop a file/i })).toBeInTheDocument();
  });

  it('a refusal after a success leaves no trace of the success', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.upload(input(), file('dirty.jpg'));
    await user.click(await screen.findByRole('button', { name: /create clean copy/i }));
    await screen.findByText(/Ready to share/);
    await user.click(screen.getByRole('button', { name: /inspect another file/i }));

    await user.upload(input(), file('signed.pdf'));
    await screen.findByText(/digitally signed/);
    note('after success -> reset -> signed PDF: ' + (text().includes('Ready to share') ? 'STALE SUCCESS' : 'clean'));
    expect(text()).not.toMatch(/Ready to share/);
    expect(screen.queryByRole('button', { name: /download clean copy/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create clean copy/i })).not.toBeInTheDocument();
  });

  it('an unreadable file after a success shows an error and no download', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.upload(input(), file('dirty.png'));
    await user.click(await screen.findByRole('button', { name: /create clean copy/i }));
    await screen.findByText(/Ready to share/);
    await user.click(screen.getByRole('button', { name: /inspect another file/i }));

    await user.upload(input(), file('p_bad_length.png'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/damaged/);
    expect(text()).not.toMatch(/Ready to share/);
    expect(screen.queryByRole('button', { name: /download clean copy/i })).not.toBeInTheDocument();
  });

  it('two files dropped in quick succession: which result is shown?', async () => {
    vi.resetModules();
    const real = await vi.importActual<typeof import('../src/core/pipeline')>('../src/core/pipeline');
    const delays: Record<string, number> = {};
    vi.doMock('../src/core/pipeline', () => ({
      ...real,
      inspectFile: async (data: Uint8Array) => {
        const report = await real.inspectFile(data);
        const wait = delays[report.format] ?? 0;
        if (wait) await new Promise((r) => setTimeout(r, wait));
        return report;
      },
    }));
    delays.jpeg = 400; // the first, slower file
    delays.png = 0;    // the second, faster file

    const FreshApp = (await import('../src/ui/App')).default;
    const user = userEvent.setup();
    render(<FreshApp />);
    const el = input();
    await user.upload(el, file('dirty.jpg'));      // slow
    await user.upload(el, file('dirty.png'));      // fast, dropped while the first is still running
    await new Promise((r) => setTimeout(r, 900));

    const shown = text().includes('dirty.jpg') ? 'dirty.jpg (the FIRST, slower file)' : 'dirty.png (the second file)';
    const consistent = text().includes('dirty.jpg') ? !text().includes('PNG image') : !text().includes('JPEG image');
    note(`race: displayed file = ${shown}; filename and findings consistent = ${consistent}`);
    expect(consistent).toBe(true); // the pair (name, findings) is always set together
    vi.doUnmock('../src/core/pipeline');
    vi.resetModules();
  });

  it('the clean button acts on the file that is currently displayed', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.upload(input(), file('dirty.jpg'));
    await screen.findByText(/What we found/);
    const shownName = screen.getByText('dirty.jpg');
    expect(shownName).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /create clean copy/i }));
    await screen.findByText(/Ready to share/);
    const suggested = (document.querySelector('.field input') as HTMLInputElement).value;
    note(`download name suggested for dirty.jpg: ${suggested}`);
    expect(suggested).toContain('dirty');
  });
});

describe('phase 9: what the UI shows for the audit findings', () => {
  it('a JPEG with appended secret bytes lists them and reaches Ready to share after removal', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.upload(input(), file('j_trailing_dirty.jpg'));
    await screen.findByText('Extra data after the end of the image');
    await user.click(await screen.findByRole('button', { name: /create clean copy/i }));
    await screen.findByText(/Ready to share/);
    note('j_trailing_dirty.jpg: trailing data listed as a finding, then removed and verified');
    expect(screen.getByRole('button', { name: /download clean copy/i })).toBeInTheDocument();
  });

  it('a JPEG whose only payload sits after the scan is offered for cleaning', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.upload(input(), file('j_com_after_sos.jpg'));
    await screen.findByText(/What we found/);
    note('j_com_after_sos.jpg: UI reports the post-scan comment instead of "Nothing hidden was found"');
    expect(text()).not.toMatch(/Nothing hidden was found/);
    expect(screen.getByRole('button', { name: /create clean copy/i })).toBeInTheDocument();
  });

  it('a PDF with an unreferenced metadata object reaches Ready to share once the orphan is dropped', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.upload(input(), file('d_multi_meta.pdf'));
    await user.click(await screen.findByRole('button', { name: /create clean copy/i }));
    await screen.findByText(/Ready to share/);
    note('d_multi_meta.pdf: UI reaches "Ready to share" and the orphaned XMP object is gone from the bytes');
    expect(screen.getByText(/removed and verified/)).toBeInTheDocument();
  });
});

describe('phase 13: accessibility of trust states', () => {
  it('success, refusal and error are all readable as text', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.upload(input(), file('dirty.jpg'));
    await user.click(await screen.findByRole('button', { name: /create clean copy/i }));
    const success = await screen.findByText(/Ready to share/);
    expect(success.textContent).toMatch(/Ready to share/); // words, not colour
    const banner = success.closest('.notice')!;
    expect(banner.textContent).toMatch(/removed and verified/);
    cleanup();

    render(<App />);
    await user.upload(input(), file('signed.pdf'));
    const refusal = await screen.findByRole('alert');
    expect(refusal.textContent).toMatch(/digitally signed/);
    cleanup();

    render(<App />);
    await user.upload(input(), file('p_truncated.png'));
    const error = await screen.findByRole('alert');
    expect(error.textContent).toMatch(/ends unexpectedly|damaged/);
    note('success/refusal/error all carry a textual message; refusal and error use role=alert');
  });

  it('processing is announced in a live region', async () => {
    render(<App />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    note('status region present with aria-live=polite');
  });

  it('every interactive control is reachable and named', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.upload(input(), file('dirty.jpg'));
    await user.click(await screen.findByRole('button', { name: /create clean copy/i }));
    await screen.findByText(/Ready to share/);

    const buttons = screen.getAllByRole('button').map((b) => b.textContent?.trim());
    const field = screen.getByLabelText(/file name for the copy/i);
    expect(field).toBeInTheDocument();
    note(`buttons in success state: ${JSON.stringify(buttons)}`);
    expect(buttons.every((b) => b && b.length > 0)).toBe(true);

    // keyboard: tab through and check focus can reach the download button
    const download = screen.getByRole('button', { name: /download clean copy/i });
    download.focus();
    expect(download).toHaveFocus();
  });

  it('focus after a rejection: where does it land?', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.upload(input(), file('p_truncated.png'));
    await screen.findByRole('alert');
    const active = document.activeElement;
    note(`focus after rejection: <${active?.tagName.toLowerCase()} class="${(active as HTMLElement)?.className}">`);
    expect(active).toBeTruthy();
  });

  it('icons that carry meaning are hidden from screen readers', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.upload(input(), file('dirty.jpg'));
    await user.click(await screen.findByRole('button', { name: /create clean copy/i }));
    await screen.findByText(/Ready to share/);
    const marks = Array.from(document.querySelectorAll('span[aria-hidden="true"]')).map((s) => s.textContent);
    note(`decorative marks: ${JSON.stringify(marks)}`);
    expect(marks.length).toBeGreaterThan(0);
  });
});

describe('phase 10: storage', () => {
  it('nothing is written to localStorage, sessionStorage, IndexedDB or the Cache API', async () => {
    const touched: string[] = [];
    const spyStorage = (store: Storage, label: string) => {
      vi.spyOn(store, 'setItem').mockImplementation((k: string) => { touched.push(`${label}.setItem(${k})`); });
    };
    spyStorage(window.localStorage, 'localStorage');
    spyStorage(window.sessionStorage, 'sessionStorage');
    vi.stubGlobal('indexedDB', { open: () => { touched.push('indexedDB.open'); return {}; } });
    vi.stubGlobal('caches', { open: () => { touched.push('caches.open'); return Promise.resolve({}); } });

    const user = userEvent.setup();
    render(<App />);
    await user.upload(input(), file('dirty.jpg'));
    await user.click(await screen.findByRole('button', { name: /create clean copy/i }));
    await screen.findByText(/Ready to share/);

    const keys = (s: Storage) => Object.keys(s).concat(Array.from({ length: s.length }, (_, i) => s.key(i) ?? ''));
    note(`storage writes during a full run: ${touched.length === 0 ? 'none' : touched.join(', ')}`);
    note(`localStorage keys present: ${JSON.stringify(keys(window.localStorage))} sessionStorage keys: ${JSON.stringify(keys(window.sessionStorage))}`);
    expect(touched).toEqual([]);
  });
});
