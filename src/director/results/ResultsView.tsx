import { useMemo, useState } from 'react';
import type { DirectorState, TeamGameScore } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, FormField, StateLabel } from '../components/Controls';
import { PageHeader } from '../components/PageHeader';
import type { SectionId } from '../app/navigation';

export function ResultsView({
  state,
  controller,
  onNavigate,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  onNavigate?: (section: SectionId) => void;
  onAnnounce: (message: string) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'review' | 'accepted' | 'rejected'>('all');
  const [showManual, setShowManual] = useState(false);
  const submissions = useMemo(
    () =>
      state.submissions.filter(
        (submission) =>
          filter === 'all' ||
          (filter === 'review'
            ? submission.status === 'review' || submission.status === 'received'
            : submission.status === filter),
      ),
    [filter, state.submissions],
  );
  const reviewCount = state.submissions.filter(
    (submission) => submission.status === 'review' || submission.status === 'received',
  ).length;
  return (
    <>
      <PageHeader
        eyebrow="Run"
        title="Results"
        description={`${reviewCount} result${reviewCount === 1 ? '' : 's'} need${reviewCount === 1 ? 's' : ''} review · raw submissions are retained`}
        actions={
          <>
            {onNavigate && (
              <Button variant="secondary" icon="upload" onClick={() => onNavigate('transfers')}>
                Import result files
              </Button>
            )}
            <Button variant="primary" icon="plus" onClick={() => setShowManual((value) => !value)}>
              Enter result
            </Button>
          </>
        }
      />
      <div className="director-page-stack">
        {showManual && (
          <ManualResult
            state={state}
            controller={controller}
            onAnnounce={(message) => {
              setShowManual(false);
              onAnnounce(message);
            }}
          />
        )}
        <section className="director-panel">
          <div className="director-panel-body director-panel-filter">
            <div className="director-filter-tabs" role="tablist" aria-label="Result status">
              <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>
                All <span>{state.submissions.length}</span>
              </FilterButton>
              <FilterButton active={filter === 'review'} onClick={() => setFilter('review')}>
                Review <span>{reviewCount}</span>
              </FilterButton>
              <FilterButton active={filter === 'accepted'} onClick={() => setFilter('accepted')}>
                Accepted{' '}
                <span>
                  {state.submissions.filter((submission) => submission.status === 'accepted').length}
                </span>
              </FilterButton>
              <FilterButton active={filter === 'rejected'} onClick={() => setFilter('rejected')}>
                Rejected{' '}
                <span>
                  {state.submissions.filter((submission) => submission.status === 'rejected').length}
                </span>
              </FilterButton>
            </div>
          </div>
          {submissions.length === 0 ? (
            <div className="director-panel-body director-panel-empty-body" role="status">
              <p className="director-empty-copy">
                No submissions in this view. Electronic QBTCP submissions and paper/manual results will appear
                here.
              </p>
            </div>
          ) : (
            <div className="director-table-wrap">
              <table className="director-table">
                <thead>
                  <tr>
                    <th scope="col">Received</th>
                    <th scope="col">Game</th>
                    <th scope="col">Score</th>
                    <th scope="col">Source</th>
                    <th scope="col">Status</th>
                    <th scope="col" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {submissions.map((submission) => (
                    <ResultRow
                      key={submission.id}
                      state={state}
                      submission={submission}
                      controller={controller}
                      onAnnounce={onAnnounce}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function ResultRow({
  state,
  submission,
  controller,
  onAnnounce,
}: {
  state: DirectorState;
  submission: DirectorState['submissions'][number];
  controller: DirectorController;
  onAnnounce: (message: string) => void;
}) {
  const game = state.games.find((entry) => entry.id === submission.gameId);
  const scheduled = game
    ? state.scheduledGames.find((entry) => entry.id === game.scheduledGameId)
    : undefined;
  const left = scheduled
    ? (state.teams.find((team) => team.id === scheduled.leftTeamId)?.displayName ?? 'Unknown')
    : 'Unknown';
  const right = scheduled?.rightTeamId
    ? (state.teams.find((team) => team.id === scheduled.rightTeamId)?.displayName ?? 'Unknown')
    : 'Bye';
  const score = game?.scores.map((entry) => entry.score).join('–') ?? '—';
  return (
    <tr>
      <td>{formatTime(submission.receivedAt)}</td>
      <td>
        <strong>
          {left} · {right}
        </strong>
        <small className="director-table-subtext">
          {scheduled
            ? (state.rounds.find((round) => round.id === scheduled.roundId)?.name ?? 'Scheduled game')
            : 'Unmatched game'}
        </small>
      </td>
      <td className="director-score-cell">
        {score}
        {game?.detailedStats && game.detailedStats !== 'complete' && (
          <small className="director-table-subtext">
            {game.detailedStats === 'unknown' ? 'Detailed stats not recorded' : 'Detailed stats incomplete'}
          </small>
        )}
      </td>
      <td>{game?.source ?? 'QBTCP'}</td>
      <td>
        <StateLabel
          state={submissionState(submission.status)}
          label={
            submission.status === 'received'
              ? 'Review'
              : submission.status === 'superseded'
                ? 'Superseded'
                : submission.status
          }
        />
      </td>
      <td>
        <div className="director-row-actions">
          {(submission.status === 'received' || submission.status === 'review') && (
            <>
              <Button
                variant="primary"
                onClick={() => {
                  const accepted = controller.acceptSubmission(submission.id);
                  onAnnounce(
                    accepted
                      ? `${left} result accepted.`
                      : `${left} result remains in review; it was not accepted.`,
                  );
                }}
              >
                Accept
              </Button>
              <Button
                variant="quiet"
                onClick={() => {
                  const rejected = controller.rejectSubmission(submission.id);
                  onAnnounce(
                    rejected
                      ? `${left} result rejected.`
                      : `${left} result could not be rejected; review the current state.`,
                  );
                }}
              >
                Reject
              </Button>
            </>
          )}
          {submission.status === 'accepted' && (
            <Button
              variant="quiet"
              icon="history"
              onClick={() =>
                onAnnounce('Accepted result is retained in the audit history for correction workflows.')
              }
            >
              Audit note
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

function ManualResult({
  state,
  controller,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (message: string) => void;
}) {
  const choices = state.scheduledGames.filter(
    (game) => !game.bye && !['accepted', 'cancelled'].includes(game.status),
  );
  const [gameId, setGameId] = useState(choices[0]?.id ?? '');
  const selected = choices.find((game) => game.id === gameId);
  const [leftScore, setLeftScore] = useState('');
  const [rightScore, setRightScore] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const save = () => {
    if (!selected || !selected.rightTeamId) {
      setValidationError('Generate a non-bye scheduled game first.');
      return;
    }
    if (!leftScore.trim() || !rightScore.trim()) {
      setValidationError('Enter both final team scores.');
      return;
    }
    const parsedLeft = Number(leftScore);
    const parsedRight = Number(rightScore);
    if (!Number.isInteger(parsedLeft) || !Number.isInteger(parsedRight)) {
      setValidationError('Final team scores must be finite whole numbers; negative totals are allowed.');
      return;
    }
    setValidationError(null);
    const score = (teamId: string, value: string): TeamGameScore => ({
      teamId,
      score: Number(value),
      powers: 0,
      gets: 0,
      negs: 0,
      bonuses: 0,
      bonusPoints: 0,
      bouncebacks: 0,
    });
    const accepted = controller.addManualResult({
      scheduledGameId: selected.id,
      scores: [score(selected.leftTeamId, leftScore), score(selected.rightTeamId, rightScore)],
    });
    if (accepted) {
      setLeftScore('');
      setRightScore('');
    }
    onAnnounce(
      accepted
        ? 'Manual result accepted locally; standings updated and saving now.'
        : 'Manual result was not accepted; review the Director error and current game state.',
    );
  };
  return (
    <section className="director-panel director-form-panel">
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Paper or offline game</p>
          <h2>Enter a result</h2>
        </div>
      </div>
      {choices.length === 0 ? (
        <div className="director-panel-body director-panel-empty-body" role="status">
          <p className="director-empty-copy">
            There are no unresolved scheduled games available for manual entry.
          </p>
        </div>
      ) : (
        <>
          <div className="director-panel-body">
            <div className="director-form-grid">
              <FormField label="Scheduled game">
                <select value={gameId} onChange={(event) => setGameId(event.target.value)}>
                  {choices.map((game) => (
                    <option key={game.id} value={game.id}>
                      {teamLabel(state, game.leftTeamId)} · {teamLabel(state, game.rightTeamId)}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label={selected ? teamLabel(state, selected.leftTeamId) : 'Left score'}>
                <input
                  type="number"
                  step="1"
                  aria-invalid={validationError ? true : undefined}
                  value={leftScore}
                  onChange={(event) => setLeftScore(event.target.value)}
                />
              </FormField>
              <FormField label={selected ? teamLabel(state, selected.rightTeamId) : 'Right score'}>
                <input
                  type="number"
                  step="1"
                  aria-invalid={validationError ? true : undefined}
                  value={rightScore}
                  onChange={(event) => setRightScore(event.target.value)}
                />
              </FormField>
            </div>
          </div>
          {validationError && (
            <div className="director-panel-body">
              <p className="director-error-copy" role="alert">
                {validationError}
              </p>
            </div>
          )}
          <div className="director-panel-footer">
            <Button variant="primary" onClick={save}>
              Accept manual result
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function submissionState(status: DirectorState['submissions'][number]['status']): string {
  return status === 'accepted'
    ? 'accepted'
    : status === 'rejected'
      ? 'rejected'
      : status === 'duplicate'
        ? 'warning'
        : status === 'superseded'
          ? 'warning'
          : 'review';
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`director-filter-tab ${active ? 'is-active' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function teamLabel(state: DirectorState, id: string | null): string {
  return id ? (state.teams.find((team) => team.id === id)?.displayName ?? 'Unknown team') : 'Bye';
}
function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
