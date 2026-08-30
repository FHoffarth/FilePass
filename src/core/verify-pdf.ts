import { Finding } from './types';

/**
 * A second opinion on a cleaned PDF, from a parser that shares no code with the cleaner.
 * pdf-lib both writes and reads the file; if it had a blind spot it would hide the same
 * bytes twice. pdf.js is used here for reading only, never for rendering.
 */
export async function independentPdfCheck(bytes: Uint8Array): Promise<{ ok: boolean; leftovers: Finding[]; reason?: string }> {
  let pdfjs: any;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    if (typeof window !== 'undefined' && typeof Worker === 'function' && !pdfjs.GlobalWorkerOptions.workerSrc) {
      // Bundled with the app, so the second parser never reaches the network either.
      pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/legacy/build/pdf.worker.mjs?url')).default;
    }
  } catch (error) {
    // No second opinion means no verified claim.
    return { ok: false, leftovers: [], reason: `loader: ${String(error)}` };
  }

  const IDENTITY_KEYS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate'];
  try {
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false });
    const doc = await task.promise;
    const { info, metadata } = await doc.getMetadata();
    const leftovers: Finding[] = [];

    for (const key of IDENTITY_KEYS) {
      const value = info?.[key];
      if (typeof value === 'string' && value.trim()) {
        leftovers.push({
          id: `Info#${key}`, category: 'OTHER', label: key, value: value.trim(),
          container: 'Info', key, removable: true,
        });
      }
    }
    if (metadata) {
      leftovers.push({
        id: 'XMP#catalog', category: 'OTHER', label: 'XMP metadata block',
        value: 'Still present according to the second check', container: 'XMP', key: 'catalog', removable: true,
      });
    }
    await doc.destroy?.();
    return { ok: leftovers.length === 0, leftovers };
  } catch (error) {
    return { ok: false, leftovers: [], reason: `parser: ${String(error)}` };
  }
}
