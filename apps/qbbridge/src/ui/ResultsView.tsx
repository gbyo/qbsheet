/**
 * Completed games, and getting them onto disk unchanged.
 *
 * The list shows a few fields read out of each document. What is written is the document.
 */

import { resultFileName, resultSummary } from '../model/results';
import type { BridgeApi } from '../model/useBridge';

export default function ResultsView({ bridge }: { bridge: BridgeApi }) {
  const { state } = bridge;
  const unsaved = state.results.filter((entry) => !entry.savedPath);
  const ordered = [...state.results].sort((left, right) =>
    left.receivedAt < right.receivedAt ? 1 : left.receivedAt > right.receivedAt ? -1 : 0,
  );

  return (
    <section className="panel">
      <h2>Results</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <button type="button" onClick={() => void bridge.chooseFolder()}>
          Choose Result Folder
        </button>
        <span className="muted">{state.resultFolder ?? 'No folder chosen'}</span>
        <button
          className="primary"
          type="button"
          style={{ marginLeft: 'auto' }}
          disabled={bridge.busy || unsaved.length === 0 || !state.resultFolder}
          onClick={() => void bridge.saveNewResults()}
        >
          Save New Results{unsaved.length > 0 ? ` (${unsaved.length})` : ''}
        </button>
      </div>

      {ordered.length === 0 ? (
        <p className="muted">
          No results yet. QBBridge checks the relay every few seconds while this window is open.
        </p>
      ) : (
        ordered.map((entry) => {
          const summary = resultSummary(entry.qbj);
          const score =
            summary.leftPoints !== null && summary.rightPoints !== null
              ? `${summary.leftName ?? '?'} ${summary.leftPoints}–${summary.rightPoints} ${summary.rightName ?? '?'}`
              : `${summary.leftName ?? '?'} vs ${summary.rightName ?? '?'}`;
          return (
            <div className="result" key={entry.resultId}>
              <span className={`dot${entry.savedPath ? ' saved' : ''}`}>{entry.savedPath ? '✓' : '●'}</span>
              <div style={{ flex: 1 }}>
                <div>
                  {summary.roundName ? `R${summary.roundName} · ` : ''}
                  {summary.location ? `${summary.location} · ` : ''}
                  {score}
                </div>
                <div className="muted status">
                  {entry.savedPath ? `Saved · ${entry.savedPath}` : 'New'} ·{' '}
                  {resultFileName(summary, entry.resultId)}
                </div>
              </div>
              <button
                type="button"
                disabled={!state.resultFolder}
                onClick={() => void bridge.saveResult(entry.resultId)}
              >
                {entry.savedPath ? 'Save again' : 'Save'}
              </button>
            </div>
          );
        })
      )}

      <p className="muted" style={{ marginTop: 12 }}>
        Saved results are ready for YellowFruit &rarr; Import Games Only (Cmd/Ctrl+M). Each file is the
        scorer&rsquo;s own QBJ, written out unchanged; QBBridge recalculates nothing and merges nothing. The
        relay keeps its copy of every result as a second backup.
      </p>
    </section>
  );
}
