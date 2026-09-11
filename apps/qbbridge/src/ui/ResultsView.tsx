/**
 * Completed games, and getting them onto disk unchanged.
 *
 * The list shows a few fields read out of each document. What is written is the document.
 */

import { useState } from 'react';
import { Button, StatusBadge } from '@qbsheet/ui';
import { resultFileName, resultImportStatus, resultMatchId, resultSummary } from '../model/results';
import type { BridgeApi } from '../model/useBridge';

type ResultFilter = 'all' | 'needs-import' | 'imported';

export default function ResultsView({ bridge }: { bridge: BridgeApi }) {
  const { state } = bridge;
  const [filter, setFilter] = useState<ResultFilter>('all');
  const unsaved = state.results.filter((entry) => !entry.savedPath);
  const described = state.results.map((entry) => ({
    entry,
    summary: resultSummary(entry.qbj),
    importState: resultImportStatus(entry),
    matchId: resultMatchId(entry.qbj),
  }));
  const correctionsByMatch = new Map<string, typeof described>();
  for (const result of described) {
    if (!result.matchId) continue;
    correctionsByMatch.set(result.matchId, [...(correctionsByMatch.get(result.matchId) ?? []), result]);
  }
  for (const corrections of correctionsByMatch.values()) {
    corrections.sort((left, right) => left.entry.receivedAt.localeCompare(right.entry.receivedAt));
  }
  const visible = described
    .filter((result) => filter === 'all' || result.importState === filter)
    .sort((left, right) => right.entry.receivedAt.localeCompare(left.entry.receivedAt));
  const groups = new Map<string, typeof described>();
  for (const result of visible) {
    const key = result.summary.roundName ?? 'Round not identified';
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }

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

      <div className="row" style={{ marginBottom: 'var(--qbs-space-3)' }}>
        <label htmlFor="result-filter">Show</label>
        <select
          id="result-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value as ResultFilter)}
        >
          <option value="all">All results</option>
          <option value="needs-import">Needs import</option>
          <option value="imported">Marked imported</option>
        </select>
        <span className="muted">
          {bridge.needsImportCount} result{bridge.needsImportCount === 1 ? '' : 's'} need YellowFruit import
        </span>
      </div>

      {visible.length === 0 ? (
        <p className="muted">
          {state.results.length === 0
            ? 'No results yet. QBBridge checks the relay every few seconds while this window is open.'
            : 'No results match this filter.'}
        </p>
      ) : (
        [...groups].map(([roundName, results]) => {
          const allInRound = described.filter(
            (result) => (result.summary.roundName ?? 'Round not identified') === roundName,
          );
          const saved = allInRound.filter((result) => result.entry.savedPath).length;
          const roundNeedsImport = allInRound.filter(
            (result) => result.importState === 'needs-import',
          ).length;
          const imported = allInRound.filter((result) => result.importState === 'imported').length;
          return (
            <section className="result-group" key={roundName} aria-label={`Results for ${roundName}`}>
              <div className="result-group__heading">
                <h3>{roundName === 'Round not identified' ? roundName : `Round ${roundName}`}</h3>
                <span className="muted">
                  {saved} saved · {roundNeedsImport} need import · {imported} marked imported
                </span>
              </div>
              {results.map(({ entry, summary, importState, matchId }) => {
                const score =
                  summary.leftPoints !== null && summary.rightPoints !== null
                    ? `${summary.leftName ?? '?'} ${summary.leftPoints}–${summary.rightPoints} ${summary.rightName ?? '?'}`
                    : `${summary.leftName ?? '?'} vs ${summary.rightName ?? '?'}`;
                const corrections = matchId ? (correctionsByMatch.get(matchId) ?? []) : [];
                const correctionIndex = corrections.findIndex(
                  (result) => result.entry.resultId === entry.resultId,
                );
                return (
                  <div className="result" key={entry.resultId}>
                    <div style={{ flex: 1 }}>
                      <div>
                        {summary.location ? `${summary.location} · ` : ''}
                        {score}
                      </div>
                      {corrections.length > 1 ? (
                        <div className="faint">
                          {correctionIndex === 0 ? 'Original result' : `Correction ${correctionIndex}`} ·{' '}
                          {correctionIndex + 1} of {corrections.length} retained finals for this game
                        </div>
                      ) : null}
                      <div className="faint">
                        {entry.savedPath ?? resultFileName(summary, entry.resultId)}
                      </div>
                    </div>
                    <StatusBadge
                      tone={
                        importState === 'imported'
                          ? 'success'
                          : importState === 'needs-import'
                            ? 'warning'
                            : 'info'
                      }
                    >
                      {importState === 'imported'
                        ? 'Marked imported'
                        : importState === 'needs-import'
                          ? 'Needs import'
                          : 'New'}
                    </StatusBadge>
                    {entry.savedPath ? (
                      <Button
                        size="sm"
                        variant="quiet"
                        isDisabled={bridge.resultBusy(entry.resultId)}
                        onPress={() =>
                          importState === 'imported'
                            ? bridge.unmarkResultImported(entry.resultId)
                            : bridge.markResultImported(entry.resultId)
                        }
                      >
                        {importState === 'imported' ? 'Undo imported' : 'Mark imported'}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      isDisabled={bridge.resultBusy(entry.resultId) || !state.resultFolder}
                      onPress={() => void bridge.saveResult(entry.resultId)}
                    >
                      {entry.savedPath ? 'Save again' : 'Save'}
                    </Button>
                  </div>
                );
              })}
            </section>
          );
        })
      )}

      <p className="faint" style={{ marginTop: 'var(--qbs-space-4)' }}>
        Saved results are marked <strong>Needs import</strong> until you confirm that you handled the file in
        YellowFruit &rarr; Import Games Only (Cmd/Ctrl+M). This is a local operator marker, not an automatic
        verification. Each file is the scorer&rsquo;s own QBJ, written out unchanged; QBBridge recalculates
        nothing and merges nothing. A file already in the folder is never replaced by a different result — a
        corrected final arrives under its own name.
      </p>
    </section>
  );
}
