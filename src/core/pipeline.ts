import * as jpeg from './jpeg';
import * as png from './png';
import * as pdf from './pdf';
import { independentPdfCheck } from './verify-pdf';
import { sniffFormat, MAX_BYTES } from './sniff';
import {
  CleanResult, FileTooLargeError, Finding, Format, InspectionReport, VerificationResult,
} from './types';

const modules = { jpeg, png, pdf } as const;

export async function inspectFile(bytes: Uint8Array): Promise<InspectionReport> {
  if (bytes.length > MAX_BYTES) {
    throw new FileTooLargeError('This file is larger than 50 MB. FilePass keeps everything in memory on your device, so it works with smaller files.');
  }
  const format: Format = sniffFormat(bytes);
  return modules[format].inspect(bytes);
}

export async function cleanFile(bytes: Uint8Array, report: InspectionReport): Promise<CleanResult> {
  return modules[report.format].clean(bytes, report);
}

/**
 * The heart of the trust model: the cleaner's own report is ignored.
 * The output bytes are re-opened and re-inspected by the same inspector, and for PDFs
 * by a second, independently written parser as well.
 */
export async function verifyClean(
  sourceReport: InspectionReport,
  cleaned: CleanResult,
): Promise<VerificationResult> {
  const outputReport = await inspectFile(cleaned.bytes);
  const outputIds = new Set(outputReport.findings.map((f) => f.id));
  const sourceIds = new Set(sourceReport.findings.map((f) => f.id));
  const promised = new Set(cleaned.promisedRemovedIds);

  const survivingFindings = outputReport.findings.filter((f) => promised.has(f.id));
  const introducedFindings = outputReport.findings.filter((f) => !sourceIds.has(f.id));
  const remainingFindings = outputReport.findings.filter((f) => sourceIds.has(f.id) && !promised.has(f.id));
  const removedIds = [...promised].filter((id) => !outputIds.has(id));

  let verdict: VerificationResult['verdict'] =
    survivingFindings.length === 0 && introducedFindings.length === 0 ? 'verified' : 'partial';

  if (sourceReport.format === 'pdf') {
    const second = await independentPdfCheck(cleaned.bytes);
    if (!second.ok) {
      // A second opinion that disagrees, or that could not be obtained, is never reported as success.
      verdict = second.leftovers.length > 0 ? 'partial' : 'unverified';
      for (const leftover of second.leftovers) {
        survivingFindings.push(leftover);
      }
    }
  }

  return { verdict, removedIds, survivingFindings, introducedFindings, remainingFindings, outputReport };
}

export interface CleanRun {
  cleaned: CleanResult;
  verification: VerificationResult;
}

export async function cleanAndVerify(bytes: Uint8Array, report: InspectionReport): Promise<CleanRun> {
  const cleaned = await cleanFile(bytes, report);
  const verification = await verifyClean(report, cleaned);
  return { cleaned, verification };
}

export function countRemoved(verification: VerificationResult): number {
  return verification.removedIds.length;
}

export function groupByCategory(findings: Finding[]): [string, Finding[]][] {
  const order = ['IDENTITY', 'LOCATION', 'DEVICE', 'TIME', 'DOCUMENT', 'OTHER'];
  const map = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = map.get(finding.category) ?? [];
    list.push(finding);
    map.set(finding.category, list);
  }
  return order.filter((c) => map.has(c)).map((c) => [c, map.get(c)!]);
}
