// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import App from './App';

/**
 * A cleaner that returns the untouched file while claiming it removed the author and the
 * location. This is exactly the failure the product must never paper over.
 */
vi.mock('../core/jpeg', async (importOriginal) => {
  const original = await importOriginal<typeof import('../core/jpeg')>();
  return {
    ...original,
    clean: async (bytes: Uint8Array) => ({
      bytes,
      promisedRemovedIds: ['APP1/EXIF#ifd0:315', 'APP1/EXIF#gps:position'],
      notes: [],
    }),
  };
});

describe('a cleaner that lies', () => {
  it('produces a warning, no success wording and no download', async () => {
    const user = userEvent.setup();
    render(<App />);
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const bytes = new Uint8Array(readFileSync(resolve(process.cwd(), 'fixtures', 'dirty.jpg')));
    await user.upload(input, new File([bytes], 'dirty.jpg', { type: 'image/jpeg' }));

    await user.click(await screen.findByRole('button', { name: /create clean copy/i }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Could not fully verify this file/)).toBeInTheDocument();
    expect(within(alert).getByText(/Author/)).toBeInTheDocument();
    expect(within(alert).getByText(/GPS location/)).toBeInTheDocument();
    expect(screen.queryByText(/Ready to share/)).not.toBeInTheDocument();
    expect(screen.queryByText(/removed and verified/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download clean copy/i })).not.toBeInTheDocument();
  });
});
