import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
  return runBytes(fixture(file), file);
}

/** The same, for bytes a test builds rather than a fixture on disk. */
export async function runBytes(bytes: Uint8Array, file = '(in memory)'): Promise<Outcome> {
  const source = () => bytes;
  let report: InspectionReport;
  try {
    report = await inspectFile(source());
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
    const { cleaned, verification } = await cleanAndVerify(source(), report);
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
  ].join(' | ').replace(/ \| $/, '');   // no dangling separator when there is no message

/**
 * How long a run took and how much heap it cost is a fact about the machine that ran it, not
 * about FilePass. Recording it next to the evidence made the suite rewrite a tracked file on
 * every run, which is exactly the kind of unexplained change the evidence chain exists to
 * catch. Measurements go to an untracked run directory instead; the tracked notes keep the
 * outcome, which is reproducible.
 */
export function measurement(line: string): void {
  mkdirSync('audit/run', { recursive: true });
  appendFileSync('audit/run/measurements.txt', line + '\n');
}

/**
 * Which test file owns which tracked evidence artifact.
 *
 * One artifact, one writer. A file two test files write is not evidence: vitest runs test
 * files in parallel, so what the file ends up holding depends on which of them finished
 * last. That is not a theoretical worry - running gaps.test.ts and then evidence.test.ts
 * used to destroy four recorded lines, and icc-check.test.ts then review-attacks.test.ts
 * destroyed two more, silently and with every test still passing.
 *
 * Volatile run data - timings, heap deltas - is not evidence and does not belong here; it
 * goes to audit/run/ via measurement(), which is not tracked.
 *
 * evidence-ownership.test.ts checks this table against what the sources actually do.
 */
export const EVIDENCE_OWNERS: Record<string, string> = {
  'audit/chunks-png.txt': 'audit/matrix.test.ts',
  'audit/evidence-notes.txt': 'audit/evidence.test.ts',
  'audit/gaps-notes.txt': 'audit/gaps.test.ts',
  'audit/icc-notes.txt': 'audit/icc-check.test.ts',
  'audit/matrix-jpeg.txt': 'audit/matrix.test.ts',
  'audit/matrix-pdf.txt': 'audit/matrix.test.ts',
  'audit/matrix-png.txt': 'audit/matrix.test.ts',
  'audit/matrix.json': 'audit/matrix.test.ts',
  'audit/parsers.txt': 'audit/parsers.test.ts',
  'audit/review-attacks.txt': 'audit/review-attacks.test.ts',
  'audit/sabotage-notes.txt': 'audit/sabotage.test.ts',
  'audit/segments-jpeg.txt': 'audit/matrix.test.ts',
  'audit/ui-notes.txt': 'audit/ui.test.tsx',
};
