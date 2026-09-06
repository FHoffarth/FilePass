import { useCallback, useRef, useState } from 'react';
import { cleanAndVerify, groupByCategory, inspectFile } from '../core/pipeline';
import { cleanedName, suggestFilename } from '../core/filename';
import { CleanRun } from '../core/pipeline';
import { Finding, InspectionReport } from '../core/types';

const CATEGORY_TITLES: Record<string, string> = {
  IDENTITY: 'Who it points to',
  LOCATION: 'Where it was taken',
  DEVICE: 'What made it',
  TIME: 'When it happened',
  DOCUMENT: 'Document details',
  OTHER: 'Other hidden data',
};

const FORMAT_NAMES = { jpeg: 'JPEG image', png: 'PNG image', pdf: 'PDF document' } as const;

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} bytes`
    : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

type Stage =
  | { name: 'idle' }
  | { name: 'working'; message: string }
  | { name: 'inspected'; report: InspectionReport; file: FileHandle }
  | { name: 'done'; report: InspectionReport; file: FileHandle; run: CleanRun }
  | { name: 'error'; message: string };

interface FileHandle {
  name: string;
  bytes: Uint8Array;
}

export default function App() {
  const [stage, setStage] = useState<Stage>({ name: 'idle' });
  const [outputName, setOutputName] = useState('');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLButtonElement>(null);
  const downloadRef = useRef<string | null>(null);
  /**
   * Which run the screen belongs to. Reading a file, cleaning it and verifying it are all
   * asynchronous, so a second file - or a reset - can arrive while the first is still going.
   * Whatever finishes for an older run is no longer about the file in front of the user.
   */
  const runRef = useRef(0);

  const handleFile = useCallback(async (file: File) => {
    const run = ++runRef.current;
    setStage({ name: 'working', message: `Looking inside ${file.name}` });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const report = await inspectFile(bytes);
      if (runRef.current !== run) return;
      setOutputName(cleanedName(suggestFilename(file.name)));
      setStage({ name: 'inspected', report, file: { name: file.name, bytes } });
    } catch (error) {
      if (runRef.current !== run) return;
      setStage({ name: 'error', message: error instanceof Error ? error.message : 'This file could not be read.' });
      // a keyboard user should be able to pick another file straight away
      queueMicrotask(() => dropRef.current?.focus());
    }
  }, []);

  const onClean = useCallback(async () => {
    if (stage.name !== 'inspected') return;
    const run = ++runRef.current;
    setStage({ name: 'working', message: 'Making a clean copy and checking it' });
    try {
      const cleaned = await cleanAndVerify(stage.file.bytes, stage.report);
      if (runRef.current !== run) return;
      setStage({ name: 'done', report: stage.report, file: stage.file, run: cleaned });
    } catch (error) {
      if (runRef.current !== run) return;
      setStage({ name: 'error', message: error instanceof Error ? error.message : 'The clean copy could not be made.' });
      queueMicrotask(() => dropRef.current?.focus());
    }
  }, [stage]);

  const onDownload = useCallback(() => {
    if (stage.name !== 'done') return;
    if (downloadRef.current) URL.revokeObjectURL(downloadRef.current);
    const blob = new Blob([stage.run.cleaned.bytes as BlobPart], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    downloadRef.current = url;
    const link = document.createElement('a');
    link.href = url;
    link.download = outputName || cleanedName(stage.file.name);
    link.click();
  }, [stage, outputName]);

  const reset = () => {
    runRef.current += 1;              // anything still running belongs to a file that is gone
    if (downloadRef.current) {
      URL.revokeObjectURL(downloadRef.current);   // the cleaned copy should not outlive the session
      downloadRef.current = null;
    }
    setStage({ name: 'idle' });
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <main className="page">
      <header>
        <h1>FilePass</h1>
        <p className="lede">Check what your file reveals before you share it.</p>
      </header>

      <div className="status" role="status" aria-live="polite">
        {stage.name === 'working' ? `${stage.message}…` : ''}
      </div>

      {(stage.name === 'idle' || stage.name === 'working' || stage.name === 'error') && (
        <section>
          <button
            type="button"
            ref={dropRef}
            className={`dropzone${dragging ? ' dropzone--over' : ''}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file) void handleFile(file);
            }}
          >
            <span className="dropzone__title">Drop a file, or choose one</span>
            <span className="dropzone__hint">JPEG, PNG or PDF, up to 50 MB</span>
          </button>
          <input
            ref={inputRef}
            type="file"
            className="visually-hidden"
            accept="image/jpeg,image/png,application/pdf"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
          />
          <p className="footnote">Processed on this device. Your file is never uploaded.</p>
          {stage.name === 'error' && (
            <p className="notice notice--stop" role="alert">
              <span aria-hidden="true">✕</span> {stage.message}
            </p>
          )}
        </section>
      )}

      {(stage.name === 'inspected' || stage.name === 'done') && (
        <section>
          <dl className="fileline">
            <div><dt>File</dt><dd>{stage.file.name}</dd></div>
            <div><dt>Format</dt><dd>{FORMAT_NAMES[stage.report.format]}</dd></div>
            <div><dt>Size</dt><dd>{formatSize(stage.report.byteLength)}</dd></div>
          </dl>

          <h2>
            {stage.report.findings.length === 0
              ? 'Nothing hidden was found'
              : `What we found (${stage.report.findings.length})`}
          </h2>
          {stage.report.findings.length === 0 && (
            <p>FilePass did not find any hidden metadata it recognises in this file.</p>
          )}
          <Findings findings={stage.report.findings} />

          {stage.report.notes.map((note) => (
            <p className="footnote" key={note}>{note}</p>
          ))}

          {stage.report.blocked && (
            <p className="notice notice--stop" role="alert">
              <span aria-hidden="true">✕</span> <strong>{stage.report.blocked.reason}</strong> {stage.report.blocked.detail}
            </p>
          )}

          {stage.name === 'inspected' && !stage.report.blocked && stage.report.findings.length > 0 && (
            <button type="button" className="primary" onClick={() => void onClean()}>
              Create clean copy
            </button>
          )}

          {stage.name === 'done' && <Result run={stage.run} outputName={outputName} setOutputName={setOutputName} onDownload={onDownload} />}

          <p className="footnote">
            FilePass checks hidden file metadata. It does not remove personal information visible
            inside the document or image.
          </p>
          <button type="button" className="link" onClick={reset}>Inspect another file</button>
        </section>
      )}
    </main>
  );
}

function Findings({ findings }: { findings: Finding[] }) {
  const groups = groupByCategory(findings);
  return (
    <>
      {groups.map(([category, items]) => (
        <section key={category} className="group">
          <h3>{CATEGORY_TITLES[category] ?? category}</h3>
          <dl className="findings">
            {items.map((finding) => (
              <div key={finding.id}>
                <dt>{finding.label}</dt>
                <dd>
                  {finding.value}
                  {!finding.removable && <span className="tag"> kept: {finding.keptReason}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </>
  );
}

function Result({
  run, outputName, setOutputName, onDownload,
}: {
  run: CleanRun;
  outputName: string;
  setOutputName: (name: string) => void;
  onDownload: () => void;
}) {
  const { verification } = run;
  const removed = verification.removedIds.length;

  if (verification.verdict !== 'verified') {
    return (
      <div className="notice notice--warn" role="alert">
        <p>
          <span aria-hidden="true">!</span> <strong>Could not fully verify this file.</strong>
        </p>
        <p>
          {removed > 0
            ? `${removed} ${removed === 1 ? 'item was' : 'items were'} removed and checked, but this metadata is still detected in the copy:`
            : 'FilePass could not confirm that anything was removed. This metadata is still detected in the copy:'}
        </p>
        <ul>
          {verification.survivingFindings.map((f) => <li key={f.id}>{f.label}: {f.value}</li>)}
          {verification.remainingFindings.map((f) => <li key={`kept-${f.id}`}>{f.label}: {f.value}</li>)}
          {verification.missingRetained.map((f) => <li key={`lost-${f.id}`}>{f.label} is no longer in the copy</li>)}
          {verification.introducedFindings.map((f) => <li key={`new-${f.id}`}>{f.label} (new in the copy)</li>)}
          {verification.survivingFindings.length === 0 && verification.remainingFindings.length === 0
            && verification.introducedFindings.length === 0 && verification.missingRetained.length === 0 && (
            <li>The second check on this file did not complete, so nothing is being claimed.</li>
          )}
        </ul>
        <p>The clean copy is not offered, because FilePass cannot stand behind it.</p>
      </div>
    );
  }

  return (
    <div className="notice notice--ok">
      <p><span aria-hidden="true">✓</span> <strong>Ready to share</strong></p>
      <p>{removed} hidden {removed === 1 ? 'field' : 'fields'} removed and verified.</p>
      {run.cleaned.notes.map((note) => <p className="footnote" key={note}>{note}</p>)}
      {verification.remainingFindings.length > 0 && (
        <p className="footnote">
          Kept on purpose: {verification.remainingFindings.map((f) => f.label).join(', ')}.
        </p>
      )}
      <label className="field">
        <span>File name for the copy</span>
        <input value={outputName} onChange={(e) => setOutputName(e.target.value)} spellCheck={false} />
      </label>
      <button type="button" className="primary" onClick={onDownload}>Download clean copy</button>
    </div>
  );
}
