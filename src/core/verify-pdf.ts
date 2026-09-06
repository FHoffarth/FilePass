import { Finding } from './types';

async function loadPdfjs(): Promise<any> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (typeof window !== 'undefined' && typeof Worker === 'function' && !pdfjs.GlobalWorkerOptions.workerSrc) {
    // Bundled with the app, so the second parser never reaches the network either.
    pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/legacy/build/pdf.worker.mjs?url')).default;
  }
  return pdfjs;
}

/**
 * Can the second parser read this file at all? Used on the source as well as the output:
 * a PDF that only pdf-lib can make sense of is repaired, not understood, and FilePass
 * does not claim verified sanitisation of a file the two parsers disagree about.
 */
export async function independentPdfParse(bytes: Uint8Array): Promise<{ ok: boolean; reason?: string }> {
  try {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false }).promise;
    await doc.getMetadata();
    await doc.destroy?.();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error).slice(0, 200) };
  }
}

const XMP_SIGNATURES = ['xmpmeta', '<?xpacket', '/Type /Metadata', '/Type/Metadata'];

/**
 * Byte level backstop. Reachability is what both parsers reason about, so anything that
 * survives as an unreferenced object is invisible to them. This looks at the bytes instead.
 * It is deliberately a veto, never a source of confidence: it can only forbid "verified".
 */
export async function rawMetadataResidue(bytes: Uint8Array, promised: Finding[]): Promise<Finding[]> {
  const text = new TextDecoder('latin1').decode(bytes);
  const hits: Finding[] = [];

  for (const signature of XMP_SIGNATURES) {
    if (text.includes(signature)) {
      hits.push({
        id: 'raw#xmp', category: 'OTHER', label: 'Embedded metadata block',
        value: `The cleaned file still contains ${signature}`,
        container: 'raw', key: 'xmp', removable: false,
      });
      break;
    }
  }

  const candidates = promised
    .map((finding) => ({ finding, needle: finding.rawValue ?? finding.value }))
    .filter(({ needle }) => needle.length >= 6 && /[A-Za-z]/.test(needle) && text.includes(needle));

  if (candidates.length > 0) {
    // A string that is also part of the visible page text is document content, not surviving
    // metadata. If the text cannot be read, every hit counts against the file.
    let visible = '';
    try {
      const pdfjs = await loadPdfjs();
      const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false }).promise;
      for (let page = 1; page <= Math.min(doc.numPages, 25); page++) {
        const content = await (await doc.getPage(page)).getTextContent();
        visible += content.items.map((item: any) => item.str).join(' ');
      }
      await doc.destroy?.();
    } catch {
      visible = '';
    }
    for (const { finding, needle } of candidates) {
      if (visible.includes(needle)) continue;
      hits.push({
        id: `raw#${finding.id}`, category: finding.category,
        label: finding.label, value: `${finding.value} (still present in the cleaned file)`,
        container: 'raw', key: finding.key, removable: false,
      });
    }
  }

  return hits;
}

/**
 * A second opinion on a cleaned PDF, from a parser that shares no code with the cleaner.
 * pdf-lib both writes and reads the file; if it had a blind spot it would hide the same
 * bytes twice. pdf.js is used here for reading only, never for rendering.
 */
export async function independentPdfCheck(bytes: Uint8Array): Promise<{ ok: boolean; leftovers: Finding[]; reason?: string }> {
  let pdfjs: any;
  try {
    pdfjs = await loadPdfjs();
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
