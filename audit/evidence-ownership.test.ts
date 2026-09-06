/**
 * The contract the audit suite has to keep about its own artifacts:
 *
 *   tracked evidence = deterministic + stable + single owner
 *   run measurements = ephemeral + ignored (audit/run/)
 *
 * A tracked file two test files write is not evidence. Vitest runs test files in parallel,
 * so the content depends on which one finished last, and the loser's lines vanish with every
 * test still green - which is how audit/evidence-notes.txt and audit/review-attacks.txt each
 * lost recorded observations. This checks the declared ownership against what the sources do,
 * rather than trusting that a future test file will remember the rule.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { EVIDENCE_OWNERS } from './harness';

const sources = readdirSync('audit')
  .filter((name) => /\.test\.tsx?$/.test(name))
  .map((name) => ({ file: `audit/${name}`, text: readFileSync(`audit/${name}`, 'utf8') }));

// Built from parts so this file's own source is not mistaken for a write call.
const anyWrite = () => new RegExp(String.raw`\b(?:write|append)FileSync\s*\(`, 'g');
const literalWrite = () => new RegExp(String.raw`\b(?:write|append)FileSync\s*\(\s*'([^']+)'`, 'g');

/** Every path a test file writes to, as written in its source. */
function writesOf(text: string): string[] {
  return Array.from(text.matchAll(literalWrite()), (m) => m[1]);
}

describe('evidence ownership', () => {
  it('there is at least one test file to check, and the table is not empty', () => {
    expect(sources.length).toBeGreaterThan(10);
    expect(Object.keys(EVIDENCE_OWNERS).length).toBeGreaterThan(10);
  });

  it('every write goes to a path spelled out in the source', () => {
    // A computed path would slip past the check below without this.
    for (const { file, text } of sources) {
      const all = text.match(anyWrite())?.length ?? 0;
      expect(writesOf(text).length, `${file} writes to a path this check cannot read`).toBe(all);
    }
  });

  it('no tracked evidence file has a second writer', () => {
    const writers = new Map<string, string[]>();
    for (const { file, text } of sources) {
      for (const path of writesOf(text)) {
        writers.set(path, [...(writers.get(path) ?? []), file]);
      }
    }
    for (const [path, owners] of writers) {
      expect(Array.from(new Set(owners)), `${path} is written by more than one test file`)
        .toHaveLength(1);
    }
  });

  it('what the sources write is exactly what the table declares', () => {
    const found: Record<string, string> = {};
    for (const { file, text } of sources) {
      for (const path of writesOf(text)) found[path] = file;
    }
    expect(found).toEqual(EVIDENCE_OWNERS);
  });

  it('the harness writes nothing except the ignored run log', () => {
    const harness = readFileSync('audit/harness.ts', 'utf8');
    expect(writesOf(harness)).toEqual(['audit/run/measurements.txt']);
  });
});
