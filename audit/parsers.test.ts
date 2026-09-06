import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { fixture, run } from './harness';

const PDFS = ['dirty.pdf', 'no_metadata.pdf', 'signed.pdf', 'd_visible_only.pdf', 'd_multi_meta.pdf',
  'd_custom_keys.pdf', 'd_truncated.pdf', 'd_trailing.pdf', 'd_incremental.pdf', 'd_objstm.pdf'];

describe('phase 4/6: do the two parsers agree about the SOURCE file?', () => {
  it('compares pdf-lib findings with pdf.js metadata on every PDF fixture', async () => {
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const rows: string[] = [];
    for (const file of PDFS) {
      const outcome = await run(file);
      const ours = (outcome.findings ?? []).map((f) => f.split('/')[1]).sort();
      let theirs: string[] = [];
      let xmp = 'none';
      try {
        const doc = await pdfjs.getDocument({ data: new Uint8Array(fixture(file)), isEvalSupported: false }).promise;
        const md = await doc.getMetadata();
        theirs = Object.entries(md.info ?? {})
          .filter(([k, v]) => typeof v === 'string' && v && !['PDFFormatVersion', 'EncryptFilterName'].includes(k))
          .map(([k]) => k).sort();
        xmp = md.metadata ? `${md.metadata.getRaw?.()?.length ?? 0} bytes` : 'none';
      } catch (error) {
        theirs = [`ERROR: ${(error as Error).message.slice(0, 40)}`];
      }
      rows.push(`${file}\n  pdf-lib: ${ours.join(', ') || '-'}\n  pdf.js : ${theirs.join(', ') || '-'} | xmp ${xmp}`);
    }
    writeFileSync('audit/parsers.txt', rows.join('\n'));
    expect(rows.length).toBe(PDFS.length);
  });
});
