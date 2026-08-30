import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from 'pdf-lib';
import { Category, CleanResult, Finding, InspectionReport, MalformedFileError } from './types';
import { independentPdfParse } from './verify-pdf';

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

/**
 * Annotation entries that describe who made a comment and when. Removing them does not
 * change what a reader sees: the note text (/Contents, /RC) and the appearance stream stay.
 */
const ANNOT_KEYS: Record<string, { label: string; category: Category }> = {
  T: { label: 'Comment author', category: 'IDENTITY' },
  M: { label: 'Comment modified', category: 'TIME' },
  CreationDate: { label: 'Comment created', category: 'TIME' },
  NM: { label: 'Comment identifier', category: 'OTHER' },
};

function annotationDicts(doc: PDFDocument): { page: number; index: number; dict: PDFDict }[] {
  const out: { page: number; index: number; dict: PDFDict }[] = [];
  doc.getPages().forEach((page, pageIndex) => {
    const annots = page.node.get(PDFName.of('Annots'));
    if (!annots) return;
    const array = doc.context.lookup(annots);
    if (!(array instanceof PDFArray)) return;
    for (let i = 0; i < array.size(); i++) {
      const dict = doc.context.lookup(array.get(i));
      if (!(dict instanceof PDFDict)) continue;
      // Widgets are form fields: their /T is the field name the document depends on,
      // not the name of a person, and removing it would break the form.
      if (dict.get(PDFName.of('Subtype'))?.toString() === '/Widget') continue;
      out.push({ page: pageIndex, index: i, dict });
    }
  });
  return out;
}

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
        rawValue: raw,
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

  for (const { page, index, dict } of annotationDicts(doc)) {
    for (const [name, known] of Object.entries(ANNOT_KEYS)) {
      const value = dict.get(PDFName.of(name));
      if (!value) continue;
      const raw = stripParens(value.toString());
      if (!raw.trim()) continue;
      findings.push({
        id: `Annots#${page}:${index}:${name}`,
        category: known.category,
        label: `${known.label} (page ${page + 1})`,
        value: /^D:\d{4}/.test(raw) ? readableDate(raw) : raw,
        rawValue: raw,
        container: 'Annots',
        key: `${page}:${index}:${name}`,
        removable: true,
      });
    }
  }
  if (annotationDicts(doc).length > 0) {
    notes.push('Comment text stays in the document. Only the name and dates attached to comments are removed.');
  }

  const signature = signatureBlock(doc);
  const report: InspectionReport = { format: 'pdf', byteLength: bytes.length, findings, notes };
  if (signature) {
    report.blocked = {
      reason: 'This PDF is digitally signed.',
      detail: 'Removing metadata rewrites the file, which would break the signature and make the document look altered. FilePass will not do that.',
    };
    return report;
  }

  // A file only one parser can make sense of has been repaired, not understood. What the
  // list above says about it cannot be trusted, so FilePass says so instead of cleaning it.
  const second = await independentPdfParse(bytes);
  if (!second.ok) {
    report.blocked = {
      reason: 'This PDF could not be read the same way twice.',
      detail: 'FilePass checks every PDF with two separate readers. One of them could not open this file, so FilePass cannot tell you what is inside it or promise that a cleaned copy would be complete.',
    };
    return report;
  }

  notes.push('Pages, text and images are copied across unchanged.');
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

  for (const { dict } of annotationDicts(doc)) {
    for (const name of Object.keys(ANNOT_KEYS)) {
      if (dict.get(PDFName.of(name))) { dict.delete(PDFName.of(name)); removedContainers.add('Annots'); }
    }
  }

  // Removing a reference does not remove the bytes: pdf-lib writes back every object it
  // parsed, including ones lifted out of object streams. Drop everything unreachable.
  const orphans = dropUnreachableObjects(doc);

  // useObjectStreams:false keeps the output flat, so verification can read every object back.
  const out = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });

  const promisedRemovedIds = report.findings
    .filter((f) => f.removable && removedContainers.has(f.container))
    .map((f) => f.id);

  const notes = ['Earlier saved versions inside the file are dropped when the clean copy is written.'];
  if (orphans > 0) {
    notes.push(`${orphans} leftover ${orphans === 1 ? 'object' : 'objects'} that nothing in the document pointed to were dropped as well.`);
  }

  return { bytes: out, promisedRemovedIds, notes };
}

/** Deletes every indirect object that cannot be reached from the document catalog. */
function dropUnreachableObjects(doc: PDFDocument): number {
  const context = doc.context;
  const reachable = new Set<string>();
  const queue: unknown[] = [context.trailerInfo.Root, doc.catalog];

  while (queue.length > 0) {
    const node = queue.pop();
    if (!node) continue;
    if (node instanceof PDFRef) {
      if (reachable.has(node.tag)) continue;
      reachable.add(node.tag);
      queue.push(context.lookup(node));
      continue;
    }
    if (node instanceof PDFArray) {
      for (let i = 0; i < node.size(); i++) queue.push(node.get(i));
      continue;
    }
    if (node instanceof PDFDict) {
      for (const [, value] of node.entries()) queue.push(value);
      continue;
    }
    const stream = (node as { dict?: unknown }).dict;
    if (stream instanceof PDFDict) queue.push(stream);
  }

  let dropped = 0;
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reachable.has(ref.tag)) { context.delete(ref); dropped += 1; }
  }
  return dropped;
}
