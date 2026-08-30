import * as jpeg from './jpeg';
import * as png from './png';
import * as pdf from './pdf';
import { independentPdfCheck, independentPdfParse, rawMetadataResidue } from './verify-pdf';
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
  sourceBytes?: Uint8Array,
): Promise<VerificationResult> {
  const outputReport = await inspectFile(cleaned.bytes);
  const outputIds = new Set(outputReport.findings.map((f) => f.id));
  const sourceIds = new Set(sourceReport.findings.map((f) => f.id));
  const promised = new Set(cleaned.promisedRemovedIds);

  const survivingFindings = outputReport.findings.filter((f) => promised.has(f.id));
  const introducedFindings = outputReport.findings.filter((f) => !sourceIds.has(f.id));
  const remainingFindings = outputReport.findings.filter((f) => sourceIds.has(f.id) && !promised.has(f.id));
  const removedIds = [...promised].filter((id) => !outputIds.has(id));

  // Detected but not proven removed is the same thing as not removed. Anything the inspector
  // can still see in the output forbids "verified" unless FilePass deliberately kept it and
  // said so: a finding marked as kept, already present in the source, is a disclosed choice
  // rather than surviving metadata. Everything else, promised or not, blocks success.
  const sourceById = new Map(sourceReport.findings.map((f) => [f.id, f] as const));
  const disclosedKept = (finding: Finding): boolean => {
    if (finding.removable || !finding.keptReason) return false;      // kept on purpose, and said so
    const original = sourceById.get(finding.id);                     // the source disclosed the same thing
    return original !== undefined && !original.removable && original.value === finding.value;
  };
  const undisclosed = outputReport.findings.filter((f) => !disclosedKept(f));
  let verdict: VerificationResult['verdict'] =
    undisclosed.length === 0 && introducedFindings.length === 0 ? 'verified' : 'partial';
  let unresolved = false;

  if (sourceReport.format === 'pdf') {
    if (sourceBytes) {
      const source = await independentPdfParse(sourceBytes);
      // pdf-lib is lenient enough to repair a file the second parser cannot read at all.
      // FilePass does not claim verified sanitisation of a document the two disagree about.
      if (!source.ok) unresolved = true;
    }

    const second = await independentPdfCheck(cleaned.bytes);
    if (!second.ok) {
      if (second.leftovers.length > 0) survivingFindings.push(...second.leftovers);
      else unresolved = true;
    }

    // Byte level backstop: both parsers reason about reachable objects, so neither of them
    // can see metadata that survives as an orphan. This can only ever forbid success.
    const residue = await rawMetadataResidue(cleaned.bytes, sourceReport.findings.filter((f) => promised.has(f.id)));
    survivingFindings.push(...residue);
  }

  if (survivingFindings.length > 0) verdict = 'partial';
  else if (unresolved && verdict === 'verified') verdict = 'unverified';

  return { verdict, removedIds, survivingFindings, introducedFindings, remainingFindings, outputReport };
}

export interface CleanRun {
  cleaned: CleanResult;
  verification: VerificationResult;
}

export async function cleanAndVerify(bytes: Uint8Array, report: InspectionReport): Promise<CleanRun> {
  const cleaned = await cleanFile(bytes, report);
  const verification = await verifyClean(report, cleaned, bytes);
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
