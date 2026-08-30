// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import App from './App';

const bytes = (name: string) => readFileSync(resolve(process.cwd(), 'fixtures', name));

const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };
const fileFor = (name: string) =>
  new File([new Uint8Array(bytes(name))], name, { type: MIME[name.split('.').pop()!] });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function drop(name: string) {
  const user = userEvent.setup();
  render(<App />);
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  await user.upload(input, fileFor(name));
  return user;
}

describe('the interface only claims what verification confirms', () => {
  it('shows findings in plain language after a drop', async () => {
    await drop('dirty.jpg');
    expect(await screen.findByText(/What we found/)).toBeInTheDocument();
    expect(screen.getByText('GPS location')).toBeInTheDocument();
    expect(screen.getByText('49.8728, 8.6511')).toBeInTheDocument();
    expect(screen.getByText('Who it points to')).toBeInTheDocument();
    expect(screen.queryByText(/Ready to share/)).not.toBeInTheDocument();
  });

  it('reaches READY TO SHARE only after cleaning and verifying', async () => {
    const user = await drop('dirty.jpg');
    await user.click(await screen.findByRole('button', { name: /create clean copy/i }));
    const banner = await screen.findByText(/Ready to share/);
    expect(banner).toBeInTheDocument();
    expect(screen.getByText(/removed and verified/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download clean copy/i })).toBeInTheDocument();
  });

  it('explains a signed PDF instead of offering to clean it', async () => {
    await drop('signed.pdf');
    expect(await screen.findByText(/digitally signed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create clean copy/i })).not.toBeInTheDocument();
  });

  it('rejects an unsupported file with a readable message', async () => {
    const user = userEvent.setup();
    render(<App />);
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    // a ZIP based document renamed to .pdf: the extension is never trusted
    await user.upload(input, new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'notes.pdf', { type: 'application/pdf' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/JPEG, PNG and PDF/);
  });

  it('reads a file by its content, not by its name', async () => {
    await drop('fake.png');
    expect(await screen.findByText('JPEG image')).toBeInTheDocument();
    expect(screen.getByText('fake.png')).toBeInTheDocument();
  });

  it('says nothing was found rather than inventing findings', async () => {
    await drop('clean.png');
    expect(await screen.findByText(/Nothing hidden was found/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create clean copy/i })).not.toBeInTheDocument();
  });

  it('renders metadata as text, never as markup', async () => {
    await drop('dirty.png');
    await screen.findByText(/What we found/);
    expect(document.querySelector('script[data-injected]')).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
  });

  it('never promises more than metadata removal', async () => {
    await drop('dirty.jpg');
    await screen.findByText(/What we found/);
    const page = document.body.textContent ?? '';
    expect(page).toContain('It does not remove personal information visible inside the document or image.');
    for (const overclaim of ['100% anonymous', 'completely safe', 'all personal information removed', 'no identifying information remains']) {
      expect(page.toLowerCase()).not.toContain(overclaim.toLowerCase());
    }
  });
});

describe('accessibility basics', () => {
  it('opens the file picker from the keyboard', async () => {
    const user = userEvent.setup();
    render(<App />);
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    await user.tab();
    expect(screen.getByRole('button', { name: /drop a file/i })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(click).toHaveBeenCalled();
  });

  it('announces progress in a live region and states results in words', async () => {
    render(<App />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    cleanup();
    const user = await drop('dirty.jpg');
    await user.click(await screen.findByRole('button', { name: /create clean copy/i }));
    // the success state is readable without seeing any colour
    expect(await screen.findByText(/Ready to share/)).toBeInTheDocument();
  });
});
