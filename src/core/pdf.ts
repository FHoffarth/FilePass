import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { Category, CleanResult, Finding, InspectionReport, MalformedFileError } from './types';

/** Info dictionary keys FilePass understands. Unknown keys are still reported, as OTHER. */
const INFO_KEYS: Record<string, { label: string; category: Category }> = {
  Title: { label: 'Title', category: 'DOCUMENT' },
  Subject: { label: 'Subject', category: 'DOCUMENT' },
  Keywords: { label: 'Keywords', category: 'DOCUMENT' },
  Author: { label: 'Author', category: 'IDENTITY' },
  Company: { label: 'Company', category: 'IDENTITY' },
  Creator: { label: 'Created with', category: 'DEVICE' },
  Producer: { label: 'Produced by', category: 'DEVICE' },
  CreationDate: { label: 'Created', category: 'TIME' },
  ModDate: { label: 'Modified', category: 'TIME' },
};

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/encrypt/i.test(message)) {
      throw new MalformedFileError('This PDF is password protected. FilePass does not open protected files.');
    }
    throw new MalformedFileError('This PDF could not be read safely, so FilePass will not change it.');
  }
}

/** Cleaning rewrites the whole document, which would break a digital signature. */
function signatureBlock(doc: PDFDocument): string | undefined {
  const acroForm = doc.catalog.get(PDFName.of('AcroForm'));
  if (acroForm) {
    const dict = doc.context.lookup(acroForm);
    if (dict instanceof PDFDict) {
      if (dict.get(PDFName.of('SigFlags'))) return 'signature-flags';
      const fields = dict.get(PDFName.of('Fields'));
      if (fields && /\/FT\s*\/Sig/.test(doc.context.lookup(fields)?.toString() ?? '')) return 'signature-field';
    }
  }
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && object.get(PDFName.of('ByteRange')) && object.get(PDFName.of('Contents'))) {
      return 'signature-object';
    }
  }
  return undefined;
}

function readXmp(doc: PDFDocument): { length: number; text: string } | undefined {
  const ref = doc.catalog.get(PDFName.of('Metadata'));
  if (!ref) return undefined;
  const stream = doc.context.lookup(ref);
  if (!(stream instanceof PDFRawStream)) return { length: 0, text: '' };
  const bytes = stream.getContents();
  return { length: bytes.length, text: new TextDecoder('utf-8', { fatal: false }).decode(bytes) };
}

const stripParens = (s: string) => s.replace(/^\((.*)\)$/s, '$1').replace(/\\([()\\])/g, '$1');

/** Turns a PDF date string (D:20260814101500+02'00') into something a person can read. */
function readableDate(raw: string): string {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(raw);
  if (!m) return raw;
  const [, y, mo = '01', d = '01', h, min] = m;
  const date = `${d}.${mo}.${y}`;
  return h ? `${date}, ${h}:${min ?? '00'}` : date;
}

export async function inspect(bytes: Uint8Array): Promise<InspectionReport> {
  try {
    return await inspectDocument(bytes);
  } catch (error) {
    if (error instanceof MalformedFileError) throw error;
    // Any parser surprise is a refusal, never a partial reading of an unclear file.
    throw new MalformedFileError('This PDF could not be read safely, so FilePass will not change it.');
  }
}

async function inspectDocument(bytes: Uint8Array): Promise<InspectionReport> {
  const doc = await load(bytes);
  const findings: Finding[] = [];
  const notes: string[] = [];

  const infoRef = doc.context.trailerInfo.Info;
  const info = infoRef ? doc.context.lookup(infoRef) : undefined;
  if (info instanceof PDFDict) {
    for (const [key, value] of info.entries()) {
      const name = key.asString().replace(/^\//, '');
      const known = INFO_KEYS[name];
      const raw = stripParens(value.toString());
      if (!raw.trim()) continue;
      findings.push({
        id: `Info#${name}`,
        category: known?.category ?? 'OTHER',
        label: known?.label ?? name,
        value: /^D:\d{4}/.test(raw) ? readableDate(raw) : raw,
        container: 'Info',
        key: name,
        removable: true,
      });
    }
  }

  const xmp = readXmp(doc);
  if (xmp) {
    findings.push({
      id: 'XMP#catalog',
      category: 'OTHER',
      label: 'XMP metadata block',
      value: `${xmp.length} bytes of embedded XMP, which often repeats the author, the title and the tool used`,
      container: 'XMP',
      key: 'catalog',
      removable: true,
    });
  }

  doc.getPages().forEach((page, index) => {
    if (page.node.get(PDFName.of('Metadata'))) {
      findings.push({
        id: `PageXMP#${index}`, category: 'OTHER', label: `XMP metadata on page ${index + 1}`,
        value: 'Extra metadata attached to a single page', container: 'PageXMP', key: String(index), removable: true,
      });
    }
    if (page.node.get(PDFName.of('PieceInfo'))) {
      findings.push({
        id: `PieceInfo#${index}`, category: 'OTHER', label: `Editing data on page ${index + 1}`,
        value: 'Private data left behind by the program that made this page', container: 'PieceInfo', key: String(index), removable: true,
      });
    }
  });

  const signature = signatureBlock(doc);
  const report: InspectionReport = { format: 'pdf', byteLength: bytes.length, findings, notes };
  if (signature) {
    report.blocked = {
      reason: 'This PDF is digitally signed.',
      detail: 'Removing metadata rewrites the file, which would break the signature and make the document look altered. FilePass will not do that.',
    };
  } else {
    notes.push('Pages, text and images are copied across unchanged.');
  }
  return report;
}

export async function clean(bytes: Uint8Array, report: InspectionReport): Promise<CleanResult> {
  if (report.blocked) throw new MalformedFileError(report.blocked.reason);
  const doc = await load(bytes);
  const context = doc.context;
  const removedContainers = new Set<string>();

  const infoRef = context.trailerInfo.Info;
  if (infoRef) {
    try { context.delete(infoRef as any); } catch { /* already gone */ }
    context.trailerInfo.Info = undefined as any;
    removedContainers.add('Info');
  }

  const metadataRef = doc.catalog.get(PDFName.of('Metadata'));
  if (metadataRef) {
    doc.catalog.delete(PDFName.of('Metadata'));
    try { context.delete(metadataRef as any); } catch { /* inline stream */ }
    removedContainers.add('XMP');
  }

  for (const page of doc.getPages()) {
    if (page.node.get(PDFName.of('Metadata'))) { page.node.delete(PDFName.of('Metadata')); removedContainers.add('PageXMP'); }
    if (page.node.get(PDFName.of('PieceInfo'))) { page.node.delete(PDFName.of('PieceInfo')); removedContainers.add('PieceInfo'); }
  }

  // useObjectStreams:false keeps the output flat, so verification can read every object back.
  const out = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });

  const promisedRemovedIds = report.findings
    .filter((f) => f.removable && removedContainers.has(f.container))
    .map((f) => f.id);

  return {
    bytes: out,
    promisedRemovedIds,
    notes: ['Earlier saved versions inside the file are dropped when the clean copy is written.'],
  };
}
