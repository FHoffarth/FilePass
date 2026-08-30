// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import App from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const load = (name: string) => new Uint8Array(readFileSync(resolve(process.cwd(), 'fixtures', name)));
const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

/** Anything that could carry bytes off the device fails the test the moment it is touched. */
function trapNetwork() {
  const calls: string[] = [];
  const trap = (label: string) => (...args: unknown[]) => {
    calls.push(`${label}(${String(args[0]).slice(0, 80)})`);
    throw new Error(`FilePass attempted ${label}`);
  };
  vi.stubGlobal('fetch', trap('fetch'));
  vi.stubGlobal('XMLHttpRequest', class { open = trap('XMLHttpRequest.open'); send = trap('XMLHttpRequest.send'); setRequestHeader() {} });
  vi.stubGlobal('WebSocket', class { constructor(url: string) { trap('WebSocket')(url); } });
  vi.stubGlobal('EventSource', class { constructor(url: string) { trap('EventSource')(url); } });
  Object.defineProperty(navigator, 'sendBeacon', { value: trap('sendBeacon'), configurable: true });
  return calls;
}

describe('nothing leaves the device', () => {
  // PDFs are covered by the same check at pipeline level in local-only.node.test.ts, because
  // the second PDF parser needs a real worker that jsdom does not provide.
  it.each(['dirty.jpg', 'dirty.png'])('inspects and cleans %s without any network call', async (name) => {
    const calls = trapNetwork();
    const user = userEvent.setup();
    render(<App />);

    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File([load(name)], name, { type: MIME[name.split('.').pop()!] }));
    await user.click(await screen.findByRole('button', { name: /create clean copy/i }));
    expect(await screen.findByText(/Ready to share/)).toBeInTheDocument();

    expect(calls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('ships no upload endpoint or telemetry call in its own source', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const path = resolve(dir, entry);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });

    const sources = walk(resolve(process.cwd(), 'src')).filter((p) => /\.tsx?$/.test(p) && !p.includes('.test.'));
    for (const path of sources) {
      const code = readFileSync(path, 'utf8');
      expect(code, path).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|new WebSocket|https?:\/\/(?!ns\.adobe\.com)/);
    }
  });
});
