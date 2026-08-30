export type Format = 'jpeg' | 'png' | 'pdf';

export type Category = 'IDENTITY' | 'LOCATION' | 'DEVICE' | 'TIME' | 'DOCUMENT' | 'OTHER';

/** One thing FilePass found inside the file. Never invented: every finding maps to bytes we saw. */
export interface Finding {
  /** Stable across inspections of source and cleaned output: `${container}#${key}`. */
  id: string;
  category: Category;
  /** Plain-language name, e.g. "Author". */
  label: string;
  /** Plain-language value, already decoded. Rendered as text, never as HTML. */
  value: string;
  /** Where it lives, for the details view and for verification. */
  container: string;
  /** Raw key inside that container, e.g. "ifd0:315" or "tEXt:Author". */
  key: string;
  /** True when FilePass knows how to remove it. Nothing else is ever promised. */
  removable: boolean;
  /** Set when FilePass keeps a finding on purpose (rendering data). */
  keptReason?: string;
}

export interface Blocked {
  reason: string;
  detail: string;
}

export interface InspectionReport {
  format: Format;
  byteLength: number;
  findings: Finding[];
  /** Things the user should know that are not findings, e.g. orientation handling. */
  notes: string[];
  /** Present when FilePass refuses to clean this file. Fail closed. */
  blocked?: Blocked;
}

export interface CleanResult {
  bytes: Uint8Array;
  /** Finding ids the cleaner claims to have removed. Claims are never trusted; they are verified. */
  promisedRemovedIds: string[];
  notes: string[];
}

export type Verdict = 'verified' | 'partial' | 'unverified';

export interface VerificationResult {
  verdict: Verdict;
  /** Promised and confirmed absent from the output. */
  removedIds: string[];
  /** Promised but still detected in the output. */
  survivingFindings: Finding[];
  /** Detected in the output but not in the source. Anything here forces a non-verified verdict. */
  introducedFindings: Finding[];
  /** Present in source and output, never promised (kept on purpose or not removable). */
  remainingFindings: Finding[];
  outputReport: InspectionReport;
}

export class UnsupportedFileError extends Error {}
export class MalformedFileError extends Error {}
export class FileTooLargeError extends Error {}
