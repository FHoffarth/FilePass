/**
 * Deterministic filename suggestion. No guessing at meaning, no model, no network.
 * Only a fixed list of version and status tokens is dropped, and only from the end.
 */
const NOISE = new Set([
  'final', 'finalfinal', 'draft', 'internal', 'confidential', 'copy', 'new', 'old',
  'latest', 'updated', 'revised', 'temp', 'tmp', 'backup', 'test',
]);

const isVersionToken = (token: string) => /^v?\d+(\.\d+)*$/i.test(token) || /^rev\d*$/i.test(token) || /^\(\d+\)$/.test(token);
const isDateToken = (token: string) => /^\d{4}[-_]?\d{2}[-_]?\d{2}$/.test(token) || /^\d{8}$/.test(token);

export function suggestFilename(original: string): string {
  const lastDot = original.lastIndexOf('.');
  const stem = lastDot > 0 ? original.slice(0, lastDot) : original;
  const extension = lastDot > 0 ? original.slice(lastDot) : '';

  const separator = stem.includes('_') ? '_' : stem.includes('-') ? '-' : ' ';
  const tokens = stem.split(/[\s_-]+/).filter(Boolean);

  const kept = [...tokens];
  while (kept.length > 1) {
    const last = kept[kept.length - 1];
    if (NOISE.has(last.toLowerCase()) || isVersionToken(last) || isDateToken(last)) {
      kept.pop();
      continue;
    }
    break;
  }

  const suggestion = kept.join(separator).trim();
  return (suggestion || stem) + extension;
}

export function cleanedName(name: string): string {
  const lastDot = name.lastIndexOf('.');
  const stem = lastDot > 0 ? name.slice(0, lastDot) : name;
  const extension = lastDot > 0 ? name.slice(lastDot) : '';
  return `${stem}-clean${extension}`;
}
