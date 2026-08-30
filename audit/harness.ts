import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanAndVerify, inspectFile } from '../src/core/pipeline';
import { InspectionReport, VerificationResult } from '../src/core/types';

export const CANARIES = {
  author: 'FILEPASS_SECRET_AUTHOR_7391',
  oldRevision: 'FILEPASS_OLD_REVISION_SECRET_4827',
  trailing: 'FILEPASS_TRAILING_SECRET_9284',
  unknownApp: 'FILEPASS_UNKNOWN_APP_5512',
  unknownChunk: 'FILEPASS_UNKNOWN_CHUNK_3140',
  objstm: 'FILEPASS_OBJSTM_SECRET_6620',
};

export function fixture(name: string): Uint8Array {
  for (const dir of ['audit/fixtures', 'fixtures']) {
    const path = resolve(process.cwd(), dir, name);
    if (existsSync(path)) return new Uint8Array(readFileSync(path));
  }
  throw new Error(`fixture not found: ${name}`);
}

export interface Outcome {
  file: string;
  ok: boolean;
  stage: 'inspect' | 'clean' | 'verify' | 'complete';
  error?: string;
  errorType?: string;
  format?: string;
  findings?: string[];
  blocked?: string;
  notes?: string[];
  verdict?: string;
  promised?: number;
  removed?: number;
  surviving?: string[];
  introduced?: string[];
  downloadable?: boolean;
  output?: Uint8Array;
  report?: InspectionReport;
  verification?: VerificationResult;
}

/** Runs the exact product pipeline a user would trigger, and records where it stopped. */
export async function run(file: string): Promise<Outcome> {
  let report: InspectionReport;
  try {
    report = await inspectFile(fixture(file));
  } catch (error) {
    return {
      file, ok: false, stage: 'inspect', downloadable: false,
      error: error instanceof Error ? error.message : String(error),
      errorType: (error as Error)?.constructor?.name,
    };
  }

  const base = {
    file,
    format: report.format,
    findings: report.findings.map((f) => `${f.category}/${f.label}`),
    blocked: report.blocked?.reason,
    notes: report.notes,
    report,
  };

  if (report.blocked) {
    return { ...base, ok: true, stage: 'inspect', verdict: 'refused', downloadable: false };
  }

  try {
    const { cleaned, verification } = await cleanAndVerify(fixture(file), report);
    return {
      ...base,
      ok: true,
      stage: 'complete',
      verdict: verification.verdict,
      promised: cleaned.promisedRemovedIds.length,
      removed: verification.removedIds.length,
      surviving: verification.survivingFindings.map((f) => f.label),
      introduced: verification.introducedFindings.map((f) => f.label),
      downloadable: verification.verdict === 'verified',
      output: cleaned.bytes,
      verification,
    };
  } catch (error) {
    return {
      ...base, ok: false, stage: 'clean', verdict: 'error', downloadable: false,
      error: error instanceof Error ? error.message : String(error),
      errorType: (error as Error)?.constructor?.name,
    };
  }
}

export const contains = (bytes: Uint8Array | undefined, needle: string): boolean =>
  bytes ? new TextDecoder('latin1').decode(bytes).includes(needle) : false;

export const row = (o: Outcome) =>
  [
    o.file,
    o.format ?? '-',
    o.findings ? String(o.findings.length) : '-',
    o.verdict ?? (o.error ? 'error' : '-'),
    o.downloadable ? 'YES' : 'no',
    o.error ?? o.blocked ?? '',
  ].join(' | ');
