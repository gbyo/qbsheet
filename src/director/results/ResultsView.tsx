import { useMemo, useState } from 'react';
import type { DirectorState, TeamGameScore } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, EmptyState, FormField, StateLabel } from '../components/Controls';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';

export function ResultsView({
  state,
  controller,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
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
          <Button variant="primary" icon="plus" onClick={() => setShowManual((value) => !value)}>
            Enter result
          </Button>
        }
      />
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
        <div className="director-filter-tabs" role="tablist" aria-label="Result status">
          <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>
            All <span>{state.submissions.length}</span>
          </FilterButton>
          <FilterButton active={filter === 'review'} onClick={() => setFilter('review')}>
            Review <span>{reviewCount}</span>
          </FilterButton>
          <FilterButton active={filter === 'accepted'} onClick={() => setFilter('accepted')}>
            Accepted{' '}
            <span>{state.submissions.filter((submission) => submission.status === 'accepted').length}</span>
          </FilterButton>
          <FilterButton active={filter === 'rejected'} onClick={() => setFilter('rejected')}>
            Rejected{' '}
            <span>{state.submissions.filter((submission) => submission.status === 'rejected').length}</span>
          </FilterButton>
        </div>
        {submissions.length === 0 ? (
          <EmptyState
            title="No submissions in this view"
            description="Electronic QBTCP submissions and paper/manual results will appear here."
          />
        ) : (
          <div className="director-table-wrap">
            <table className="director-table">
              <thead>
                <tr>
                  <th>Received</th>
                  <th>Game</th>
                  <th>Score</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
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
      <td className="director-score-cell">{score}</td>
      <td>{game?.source ?? 'QBTCP'}</td>
      <td>
        <StateLabel
          state={
            submission.status === 'accepted'
              ? 'finished'
              : submission.status === 'rejected'
                ? 'offline'
                : 'help'
          }
          label={submission.status === 'received' ? 'Review' : submission.status}
        />
      </td>
      <td>
        <div className="director-row-actions">
          {(submission.status === 'received' || submission.status === 'review') && (
            <>
              <Button
                variant="primary"
                onClick={() => {
                  controller.acceptSubmission(submission.id);
                  onAnnounce(`${left} result accepted.`);
                }}
              >
                Accept
              </Button>
              <Button
                variant="quiet"
                onClick={() => {
                  controller.rejectSubmission(submission.id);
                  onAnnounce(`${left} result rejected.`);
                }}
              >
                Reject
              </Button>
            </>
          )}
          {submission.status === 'accepted' && (
            <button
              type="button"
              className="director-icon-button"
              aria-label={`Open actions for ${left} and ${right}`}
              onClick={() =>
                onAnnounce('Accepted result is retained in the audit history for correction workflows.')
              }
            >
              <Icon name="more" size={16} />
            </button>
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
  const [leftScore, setLeftScore] = useState('0');
  const [rightScore, setRightScore] = useState('0');
  const save = () => {
    if (!selected || !selected.rightTeamId) {
      onAnnounce('Generate a non-bye scheduled game first.');
      return;
    }
    const score = (teamId: string, value: string): TeamGameScore => ({
      teamId,
      score: Number(value) || 0,
      powers: 0,
      gets: 0,
      negs: 0,
      bonuses: 0,
      bonusPoints: 0,
      bouncebacks: 0,
    });
    controller.addManualResult({
      scheduledGameId: selected.id,
      scores: [score(selected.leftTeamId, leftScore), score(selected.rightTeamId, rightScore)],
    });
    onAnnounce('Manual result saved and standings updated.');
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
        <p className="director-empty-copy">
          There are no unresolved scheduled games available for manual entry.
        </p>
      ) : (
        <>
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
                min="0"
                value={leftScore}
                onChange={(event) => setLeftScore(event.target.value)}
              />
            </FormField>
            <FormField label={selected ? teamLabel(state, selected.rightTeamId) : 'Right score'}>
              <input
                type="number"
                min="0"
                value={rightScore}
                onChange={(event) => setRightScore(event.target.value)}
              />
            </FormField>
          </div>
          <div className="director-form-actions">
            <Button variant="primary" onClick={save}>
              Accept manual result
            </Button>
          </div>
        </>
      )}
    </section>
  );
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
