import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanAndVerify, inspectFile } from './pipeline';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url))));

afterEach(() => vi.unstubAllGlobals());

describe('the whole pipeline is offline', () => {
  it.each(['dirty.jpg', 'dirty.png', 'dirty.pdf'])('handles %s without touching the network', async (name) => {
    const calls: string[] = [];
    const trap = (label: string) => (...args: unknown[]) => {
      calls.push(`${label}(${String(args[0]).slice(0, 80)})`);
      throw new Error(`FilePass attempted ${label}`);
    };
    vi.stubGlobal('fetch', trap('fetch'));
    vi.stubGlobal('XMLHttpRequest', class { open = trap('open'); send = trap('send'); });
    vi.stubGlobal('WebSocket', class { constructor(url: string) { trap('WebSocket')(url); } });

    const bytes = fixture(name);
    const report = await inspectFile(bytes);
    const { verification } = await cleanAndVerify(bytes, report);

    expect(verification.verdict).toBe('verified');
    expect(calls).toEqual([]);
  });
});
