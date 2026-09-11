/**
 * Completed games, and getting them onto disk unchanged.
 *
 * The list shows a few fields read out of each document. What is written is the document.
 */

import { Button, StatusBadge } from '@qbsheet/ui';
import { resultFileName, resultFileSuffix, resultSummary, type ResultSummary } from '../model/results';
import type { BridgeApi } from '../model/useBridge';

function resultSaveAccessibleName(summary: ResultSummary, resultId: string, saved: boolean): string {
  const context = [
    summary.roundName ? `Round ${summary.roundName}` : null,
    summary.location,
    summary.leftName || summary.rightName
      ? `${summary.leftName ?? 'Unknown team'} vs ${summary.rightName ?? 'Unknown team'}`
      : null,
  ].filter((part): part is string => part !== null);
  const action = saved ? 'Save result again' : 'Save result';
  const identity = `result ${resultFileSuffix(resultId)}`;
  return `${action} — ${context.length > 0 ? `${context.join(', ')}, ` : ''}${identity}`;
}

export default function ResultsView({ bridge }: { bridge: BridgeApi }) {
  const { state } = bridge;
  const unsaved = state.results.filter((entry) => !entry.savedPath);
  const ordered = [...state.results].sort((left, right) =>
    left.receivedAt < right.receivedAt ? 1 : left.receivedAt > right.receivedAt ? -1 : 0,
  );

  return (
    <section className="panel">
      <h2>Results</h2>
      <div className="row" style={{ marginBottom: 'var(--qbs-space-3)' }}>
        <Button onPress={() => void bridge.chooseFolder()}>Choose Result Folder</Button>
        <span className="muted">{state.resultFolder ?? 'No folder chosen'}</span>
        <Button
          variant="primary"
          style={{ marginLeft: 'auto' }}
          isDisabled={bridge.busy || bridge.savingResults || unsaved.length === 0 || !state.resultFolder}
          onPress={() => void bridge.saveNewResults()}
        >
          Save New Results{unsaved.length > 0 ? ` (${unsaved.length})` : ''}
        </Button>
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
              <div style={{ flex: 1 }}>
                <div>
                  {summary.roundName ? `R${summary.roundName} · ` : ''}
                  {summary.location ? `${summary.location} · ` : ''}
                  {score}
                </div>
                <div className="faint">{entry.savedPath ?? resultFileName(summary, entry.resultId)}</div>
              </div>
              <StatusBadge tone={entry.savedPath ? 'success' : 'info'}>
                {entry.savedPath ? 'Saved' : 'New'}
              </StatusBadge>
              <Button
                size="sm"
                aria-label={resultSaveAccessibleName(summary, entry.resultId, Boolean(entry.savedPath))}
                isDisabled={bridge.resultBusy(entry.resultId) || !state.resultFolder}
                onPress={() => void bridge.saveResult(entry.resultId)}
              >
                {entry.savedPath ? 'Save again' : 'Save'}
              </Button>
            </div>
          );
        })
      )}

      <p className="faint" style={{ marginTop: 'var(--qbs-space-4)' }}>
        Saved results are ready for YellowFruit &rarr; Import Games Only (Cmd/Ctrl+M). Each file is the
        scorer&rsquo;s own QBJ, written out unchanged; QBBridge recalculates nothing and merges nothing. A
        file already in the folder is never replaced by a different result — a corrected final arrives under
        its own name.
      </p>
    </section>
  );
}
