import { useMemo, useState } from 'react';
import type { DirectorState, ProtestScoreAdjustment, TeamGameScore } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, FormField, StateLabel } from '../components/Controls';
import { PageHeader } from '../components/PageHeader';
import type { SectionId } from '../app/navigation';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { useNavigationHighlight } from '../app/useNavigationHighlight';
import { describeWarning } from '../transfers/ingest';

export function ResultsView({
  state,
  controller,
  onNavigate,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
  state: DirectorState;
  controller: DirectorController;
  onNavigate?: (section: SectionId) => void;
  onAnnounce: (message: string) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const [filter, setFilter] = useState<'all' | 'review' | 'accepted' | 'rejected'>('all');
  const [showManual, setShowManual] = useState(false);
  const submissions = useMemo(() => {
    const targetSubmissionId =
      navigationTarget?.section === 'results' && navigationTarget.entityType === 'submission'
        ? navigationTarget.entityId
        : undefined;
    return state.submissions.filter(
      (submission) =>
        submission.id === targetSubmissionId ||
        filter === 'all' ||
        (filter === 'review'
          ? submission.status === 'review' || submission.status === 'received'
          : submission.status === filter),
    );
  }, [filter, navigationTarget, state.submissions]);
  const reviewCount = state.submissions.filter(
    (submission) => submission.status === 'review' || submission.status === 'received',
  ).length;
  // Protests sit below the schedule, which at a large tournament is a long way below the fold.
  // The count belongs where a director already looks for what still needs them.
  const openProtestCount = state.protests.filter((protest) => protest.status === 'open').length;
  return (
    <>
      <PageHeader
        eyebrow="Run"
        title="Results"
        description={`${reviewCount} result${reviewCount === 1 ? '' : 's'} need${reviewCount === 1 ? 's' : ''} review · ${openProtestCount} open protest${openProtestCount === 1 ? '' : 's'} · raw submissions are retained`}
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
            onSuccess={() => setShowManual(false)}
            onAnnounce={onAnnounce}
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
              {filter !== 'all' && (
                <button type="button" className="director-inline-action" onClick={() => setFilter('all')}>
                  Show all results
                </button>
              )}
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
                      navigationTarget={navigationTarget}
                      onClearNavigationTarget={onClearNavigationTarget}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {state.scheduledGames.some((game) => !game.bye) && (
          <ScheduledGamesPanel
            state={state}
            controller={controller}
            onAnnounce={onAnnounce}
            navigationTarget={navigationTarget}
            onClearNavigationTarget={onClearNavigationTarget}
          />
        )}
        {state.protests.length > 0 && (
          <ProtestsPanel state={state} controller={controller} onAnnounce={onAnnounce} />
        )}
      </div>
    </>
  );
}

function ScheduledGamesPanel({
  state,
  controller,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (message: string) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  /*
   * By default, the games that still want something from a director.
   *
   * This panel used to list every scheduled game for the whole tournament, so by the afternoon the
   * three rooms that had not reported were somewhere in a table of two hundred rows that had. The
   * settled ones are not lost: `Show all scheduled games` puts them back, and a cross-page
   * navigation to a particular game still finds it whichever mode the panel is in.
   */
  const [showAll, setShowAll] = useState(false);
  const targetGameId =
    navigationTarget?.section === 'results' && navigationTarget.entityType === 'game'
      ? navigationTarget.entityId
      : undefined;
  /*
   * The settled game a search or a cross-page link sent somebody to, kept after the arrow that
   * pointed at it has gone.
   *
   * `useNavigationHighlight` is a one-shot: it focuses the destination and then calls
   * `onClearNavigationTarget`, which is a render later. Filtering on `navigationTarget` alone meant
   * an accepted or cancelled game appeared, took focus, and was removed from the table in the same
   * gesture -- the destination vanishing on arrival, with the keyboard focus that had just landed
   * on it going with it. So the reveal is latched here instead, and released when the director
   * changes what the panel is showing.
   */
  const [revealed, setRevealed] = useState<{ from?: string; id?: string }>({});
  /*
   * Adjusted during the render that first sees the target rather than from an effect, so the row is
   * already in the table on the render the highlight hook goes looking for it. `from` records which
   * target the latch came from, so releasing the latch cannot immediately re-latch the same one.
   */
  if (targetGameId !== undefined && revealed.from !== targetGameId) {
    setRevealed({ from: targetGameId, id: targetGameId });
  }
  const settled = (game: DirectorState['scheduledGames'][number]) =>
    game.status === 'accepted' || game.status === 'cancelled';
  const scheduled = state.scheduledGames.filter((game) => !game.bye);
  const unresolvedCount = scheduled.filter((game) => !settled(game)).length;
  const games = showAll ? scheduled : scheduled.filter((game) => !settled(game) || game.id === revealed.id);
  /*
   * Whether the table currently holds anything beyond the unresolved games, which is what the one
   * control has to offer to undo. A latched destination counts: leaving the button reading "Show
   * all" while a settled row is on screen would describe a state the panel is not in.
   */
  const showingSettled = showAll || games.some(settled);
  const toggleShowAll = () => {
    if (showingSettled) {
      setShowAll(false);
      // `from` is kept: releasing the latch must not re-latch the target it came from.
      setRevealed((current) => ({ ...current, id: undefined }));
      return;
    }
    setShowAll(true);
  };
  return (
    <section className="director-panel">
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Schedule</p>
          <h2>Scheduled games</h2>
        </div>
        <div className="director-row-actions">
          <span className="director-muted">
            {unresolvedCount} unresolved of {scheduled.length}
          </span>
          <Button variant="quiet" onClick={toggleShowAll}>
            {showingSettled ? 'Show only unresolved' : 'Show all scheduled games'}
          </Button>
        </div>
      </div>
      {games.length === 0 ? (
        // Deliberately not a live region: the page already has one (the announcement toast), and a
        // second one competing with it would announce this panel's own filter over a director's
        // confirmation that a result was saved.
        <div className="director-panel-body director-panel-empty-body">
          <p className="director-empty-copy">
            Every scheduled game has been accepted or cancelled. Nothing needs attention here.
          </p>
        </div>
      ) : (
        <div className="director-table-wrap">
          <table className="director-table">
            <thead>
              <tr>
                <th scope="col">Game</th>
                <th scope="col">Round</th>
                <th scope="col">Room</th>
                <th scope="col">Status</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {games.map((game) => (
                <ScheduledGameRow
                  key={game.id}
                  state={state}
                  game={game}
                  controller={controller}
                  onAnnounce={onAnnounce}
                  navigationTarget={navigationTarget}
                  onClearNavigationTarget={onClearNavigationTarget}
                  confirming={confirmCancelId === game.id}
                  onConfirmCancel={() => setConfirmCancelId(null)}
                  onRequestCancel={() => setConfirmCancelId(game.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ScheduledGameRow({
  state,
  game,
  controller,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
  confirming,
  onConfirmCancel,
  onRequestCancel,
}: {
  state: DirectorState;
  game: DirectorState['scheduledGames'][number];
  controller: DirectorController;
  onAnnounce: (message: string) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
  confirming: boolean;
  onConfirmCancel: () => void;
  onRequestCancel: () => void;
}) {
  const round = state.rounds.find((entry) => entry.id === game.roundId);
  const room = game.roomId ? state.rooms.find((entry) => entry.id === game.roomId) : undefined;
  const gameNavigation = useNavigationHighlight(
    navigationTarget,
    'results',
    'game',
    game.id,
    onClearNavigationTarget,
  );
  const canCancel = !['accepted', 'cancelled'].includes(game.status);
  return (
    <tr
      tabIndex={-1}
      className={gameNavigation ? 'is-navigation-target' : undefined}
      data-director-navigation-id={game.id}
    >
      <td>
        <span data-director-navigation-focus tabIndex={-1}>
          <strong>
            {teamLabel(state, game.leftTeamId)} · {teamLabel(state, game.rightTeamId)}
          </strong>
          <small className="director-table-subtext">{game.id}</small>
        </span>
      </td>
      <td>{round?.name ?? 'Unknown round'}</td>
      <td>{room?.name ?? 'Unassigned'}</td>
      <td>
        <StateLabel state={game.status} label={game.status} />
      </td>
      <td>
        {canCancel && (
          <div className="director-row-actions">
            {confirming ? (
              <>
                <Button
                  variant="danger"
                  onClick={() => {
                    const cancelled = controller.cancelScheduledGame(game.id);
                    if (cancelled) {
                      onConfirmCancel();
                      onAnnounce('Scheduled game cancelled; the round can now close without it.');
                    } else {
                      onAnnounce('The game was not cancelled; review the Director error.');
                    }
                  }}
                >
                  Confirm cancel
                </Button>
                <Button variant="quiet" onClick={onConfirmCancel}>
                  Keep game
                </Button>
              </>
            ) : (
              <Button variant="quiet" onClick={onRequestCancel}>
                Cancel game
              </Button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

function ResultRow({
  state,
  submission,
  controller,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
  state: DirectorState;
  submission: DirectorState['submissions'][number];
  controller: DirectorController;
  onAnnounce: (message: string) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const submissionNavigation = useNavigationHighlight(
    navigationTarget,
    'results',
    'submission',
    submission.id,
    onClearNavigationTarget,
  );
  const [action, setAction] = useState<'associate' | 'edit' | 'protest' | 'reject' | null>(null);
  /*
   * Why rejecting takes two presses.
   *
   * Reject sat beside Accept as a single-click action on a row a director is scanning quickly, and
   * it is the destructive one of the pair: it reopens the scheduled game, hands the room back, and
   * writes a reason into the audit history that nobody chose. The controller has always taken an
   * optional reason and never had anywhere to get one from. A small inline panel is a cheap
   * confirmation -- one extra press, no modal, the row stays where it is -- and it is the only
   * place a director can say *why*, which is what the team standing at HQ is going to ask.
   */
  const [rejectionReason, setRejectionReason] = useState('');
  const game = state.games.find((entry) => entry.id === submission.gameId);
  const scheduled = game
    ? state.scheduledGames.find((entry) => entry.id === game.scheduledGameId)
    : undefined;
  const left = scheduled
    ? (state.teams.find((team) => team.id === scheduled.leftTeamId)?.displayName ?? 'Unknown')
    : 'Unmatched result';
  const right = scheduled?.rightTeamId
    ? (state.teams.find((team) => team.id === scheduled.rightTeamId)?.displayName ?? 'Unknown')
    : 'Bye';
  const score = game
    ? scheduled
      ? [scheduled.leftTeamId, scheduled.rightTeamId]
          .map((teamId) => game.scores.find((entry) => entry.teamId === teamId)?.score ?? '—')
          .join('–')
      : game.scores.map((entry) => entry.score).join('–') || '—'
    : '—';
  const reviewWarnings = submission.warnings ?? [];
  const cancelledGame = scheduled?.status === 'cancelled' || game?.status === 'cancelled';
  return (
    <tr
      tabIndex={-1}
      className={submissionNavigation ? 'is-navigation-target' : undefined}
      data-director-navigation-id={submission.id}
    >
      <td>
        <span data-director-navigation-focus tabIndex={-1}>
          {formatTime(submission.receivedAt)}
        </span>
      </td>
      <td>
        <strong>{scheduled ? `${left} · ${right}` : left}</strong>
        <small className="director-table-subtext">
          {scheduled
            ? (state.rounds.find((round) => round.id === scheduled.roundId)?.name ?? 'Scheduled game')
            : (submission.reason ?? 'Choose the scheduled game returned by this result.')}
        </small>
        {reviewWarnings.length > 0 && (
          <small className="director-table-subtext">{reviewWarnings.map(describeWarning).join(' ')}</small>
        )}
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
              {cancelledGame ? (
                <span className="director-muted">Cancelled game · accept disabled</span>
              ) : (
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
              )}
              <Button
                variant={action === 'reject' ? 'secondary' : 'quiet'}
                onClick={() => setAction((current) => (current === 'reject' ? null : 'reject'))}
              >
                Reject
              </Button>
              {!scheduled && (
                <Button
                  variant={action === 'associate' ? 'secondary' : 'quiet'}
                  icon="clipboard"
                  onClick={() => setAction((current) => (current === 'associate' ? null : 'associate'))}
                >
                  Associate
                </Button>
              )}
            </>
          )}
          {submission.status === 'accepted' && game && scheduled && (
            <>
              <Button
                variant={action === 'edit' ? 'secondary' : 'quiet'}
                icon="edit"
                onClick={() => setAction((current) => (current === 'edit' ? null : 'edit'))}
              >
                Correct result
              </Button>
              {scheduled.rightTeamId && (
                <Button
                  variant={action === 'protest' ? 'secondary' : 'quiet'}
                  icon="alert"
                  onClick={() => setAction((current) => (current === 'protest' ? null : 'protest'))}
                >
                  Open protest
                </Button>
              )}
            </>
          )}
        </div>
        {action === 'reject' && (submission.status === 'received' || submission.status === 'review') && (
          <div className="director-result-action-panel">
            <p className="director-eyebrow">Reject this result</p>
            <p className="director-empty-copy">
              The submission is retained and the scheduled game reopens so the room can send it again.
            </p>
            <FormField label="Reason" hint="Optional. Stored on the submission and in the audit history.">
              <textarea
                className="director-textarea"
                rows={2}
                value={rejectionReason}
                onChange={(event) => setRejectionReason(event.target.value)}
                placeholder="Scores transposed; room is re-entering"
              />
            </FormField>
            <div className="director-row-actions">
              <Button
                variant="primary"
                onClick={() => {
                  // An empty reason keeps the controller's own default, which is what the audit
                  // history has always recorded for a rejection nobody explained.
                  const reason = rejectionReason.trim();
                  const rejected = controller.rejectSubmission(
                    submission.id,
                    reason === '' ? undefined : reason,
                  );
                  onAnnounce(
                    rejected
                      ? `${left} result rejected.`
                      : `${left} result could not be rejected; review the current state.`,
                  );
                  if (rejected) setRejectionReason('');
                  setAction(null);
                }}
              >
                Reject result
              </Button>
              <Button variant="quiet" onClick={() => setAction(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {!scheduled && action === 'associate' && game && (
          <AssociateResult
            state={state}
            submission={submission}
            controller={controller}
            onCancel={() => setAction(null)}
            onSuccess={() => setAction(null)}
            onAnnounce={onAnnounce}
          />
        )}
        {submission.status === 'accepted' && action === 'edit' && game && scheduled && (
          <AcceptedResultEditor
            state={state}
            game={game}
            scheduled={scheduled}
            onCancel={() => setAction(null)}
            onSuccess={() => setAction(null)}
            onAnnounce={onAnnounce}
            controller={controller}
          />
        )}
        {submission.status === 'accepted' && action === 'protest' && game && scheduled?.rightTeamId && (
          <ProtestCreator
            game={game}
            controller={controller}
            onCancel={() => setAction(null)}
            onSuccess={() => setAction(null)}
            onAnnounce={onAnnounce}
          />
        )}
      </td>
    </tr>
  );
}

function AssociateResult({
  state,
  submission,
  controller,
  onCancel,
  onSuccess,
  onAnnounce,
  navigationTarget: _navigationTarget,
  onClearNavigationTarget: _onClearNavigationTarget,
}: {
  state: DirectorState;
  submission: DirectorState['submissions'][number];
  controller: DirectorController;
  onCancel: () => void;
  onSuccess: () => void;
  onAnnounce: (message: string) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const choices = state.scheduledGames.filter(
    (game) => !game.bye && game.status !== 'accepted' && game.status !== 'cancelled',
  );
  const [scheduledGameId, setScheduledGameId] = useState(choices[0]?.id ?? '');
  const effectiveScheduledGameId = choices.some((game) => game.id === scheduledGameId)
    ? scheduledGameId
    : (choices[0]?.id ?? '');
  const associate = () => {
    if (!effectiveScheduledGameId) {
      onAnnounce('Choose the scheduled game before associating this result.');
      return;
    }
    if (!controller.associateSubmission(submission.id, effectiveScheduledGameId)) return;
    onSuccess();
    onAnnounce('Result associated with the selected game and kept in review. Verify it before accepting.');
  };
  return (
    <form
      className="director-result-action-panel"
      onSubmit={(event) => {
        event.preventDefault();
        associate();
      }}
    >
      <p className="director-eyebrow">Director association</p>
      {choices.length === 0 ? (
        <p className="director-empty-copy">No unresolved scheduled game is available for this result.</p>
      ) : (
        <FormField
          label="Scheduled game"
          hint="Association does not accept the result. Review the score and warnings, then accept it separately."
        >
          <select
            value={effectiveScheduledGameId}
            onChange={(event) => setScheduledGameId(event.target.value)}
          >
            {choices.map((game) => {
              const round = state.rounds.find((entry) => entry.id === game.roundId);
              return (
                <option key={game.id} value={game.id}>
                  {round?.name ?? 'Scheduled game'} · {teamLabel(state, game.leftTeamId)} ·{' '}
                  {teamLabel(state, game.rightTeamId)}
                </option>
              );
            })}
          </select>
        </FormField>
      )}
      <div className="director-row-actions">
        <Button variant="primary" type="submit" disabled={choices.length === 0}>
          Associate result
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AcceptedResultEditor({
  state,
  game,
  scheduled,
  controller,
  onCancel,
  onSuccess,
  onAnnounce,
  navigationTarget: _navigationTarget,
  onClearNavigationTarget: _onClearNavigationTarget,
}: {
  state: DirectorState;
  game: DirectorState['games'][number];
  scheduled: DirectorState['scheduledGames'][number];
  controller: DirectorController;
  onCancel: () => void;
  onSuccess: () => void;
  onAnnounce: (message: string) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const leftScore = game.scores.find((entry) => entry.teamId === scheduled.leftTeamId);
  const rightScore = scheduled.rightTeamId
    ? game.scores.find((entry) => entry.teamId === scheduled.rightTeamId)
    : undefined;
  const [left, setLeft] = useState(String(leftScore?.score ?? ''));
  const [right, setRight] = useState(String(rightScore?.score ?? ''));
  const [note, setNote] = useState('');
  const save = () => {
    const nextLeft = Number(left);
    const nextRight = Number(right);
    if (!left.trim() || !right.trim() || !Number.isInteger(nextLeft) || !Number.isInteger(nextRight)) {
      onAnnounce('Corrected scores must be finite whole numbers.');
      return;
    }
    const scores = game.scores.map((entry) =>
      entry.teamId === scheduled.leftTeamId
        ? { ...entry, score: nextLeft }
        : entry.teamId === scheduled.rightTeamId
          ? { ...entry, score: nextRight }
          : entry,
    );
    if (!controller.editAcceptedResult(game.id, scores, note.trim() || undefined)) return;
    onSuccess();
    onAnnounce('Accepted result corrected; the prior result remains in audit history.');
  };
  return (
    <form
      className="director-result-action-panel"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <p className="director-eyebrow">Audited correction</p>
      <div className="director-form-grid director-form-grid-two">
        <FormField label={teamLabel(state, scheduled.leftTeamId)}>
          <input type="number" step="1" value={left} onChange={(event) => setLeft(event.target.value)} />
        </FormField>
        <FormField label={teamLabel(state, scheduled.rightTeamId)}>
          <input type="number" step="1" value={right} onChange={(event) => setRight(event.target.value)} />
        </FormField>
      </div>
      <FormField label="Correction note">
        <textarea
          className="director-textarea"
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Why is the accepted score changing?"
        />
      </FormField>
      <div className="director-row-actions">
        <Button variant="primary" type="submit">
          Save correction
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ProtestCreator({
  game,
  controller,
  onCancel,
  onSuccess,
  onAnnounce,
  navigationTarget: _navigationTarget,
  onClearNavigationTarget: _onClearNavigationTarget,
}: {
  game: DirectorState['games'][number];
  controller: DirectorController;
  onCancel: () => void;
  onSuccess: () => void;
  onAnnounce: (message: string) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const [category, setCategory] = useState<'tossup' | 'bonus' | 'procedure' | 'other'>('other');
  const [description, setDescription] = useState('');
  const save = () => {
    if (!description.trim()) {
      onAnnounce('Describe the protest before saving it.');
      return;
    }
    if (!controller.addProtest(game.id, description, category)) return;
    onSuccess();
    onAnnounce('Protest opened and retained with the accepted result.');
  };
  return (
    <form
      className="director-result-action-panel"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <p className="director-eyebrow">New protest</p>
      <div className="director-form-grid director-form-grid-two">
        <FormField label="Category">
          <select value={category} onChange={(event) => setCategory(event.target.value as typeof category)}>
            <option value="tossup">Tossup</option>
            <option value="bonus">Bonus</option>
            <option value="procedure">Procedure</option>
            <option value="other">Other</option>
          </select>
        </FormField>
        <FormField label="Description">
          <textarea
            className="director-textarea"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What needs review?"
          />
        </FormField>
      </div>
      <div className="director-row-actions">
        <Button variant="primary" type="submit">
          Open protest
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ProtestsPanel({
  state,
  controller,
  onAnnounce,
  navigationTarget: _navigationTarget,
  onClearNavigationTarget: _onClearNavigationTarget,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (message: string) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  return (
    <section className="director-panel">
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Audit</p>
          <h2>Protests</h2>
        </div>
        <span className="director-muted">
          {state.protests.filter((protest) => protest.status === 'open').length} open
        </span>
      </div>
      <div className="director-panel-body director-panel-body-list">
        <ul className="director-list director-protest-list">
          {state.protests.map((protest) => {
            const game = state.games.find((entry) => entry.id === protest.gameId);
            const scheduled = game
              ? state.scheduledGames.find((entry) => entry.id === game.scheduledGameId)
              : undefined;
            return (
              <li key={protest.id} className="director-protest-row">
                <div>
                  <strong>
                    {scheduled
                      ? `${teamLabel(state, scheduled.leftTeamId)} · ${teamLabel(state, scheduled.rightTeamId)}`
                      : 'Unmatched game'}
                  </strong>
                  <span>
                    {categoryLabel(protest.category)} · {protest.description}
                  </span>
                  {protest.ruling && <small>Ruling: {protest.ruling}</small>}
                  {protest.scoreAdjustment && (
                    <small>
                      Score correction: {teamLabel(state, protest.scoreAdjustment.teamId)}{' '}
                      {formatDelta(protest.scoreAdjustment.delta)}
                    </small>
                  )}
                </div>
                <StateLabel state={protest.status} label={protest.status} />
                {protest.status === 'open' && game && (
                  <ProtestRuling
                    protest={protest}
                    state={state}
                    controller={controller}
                    onAnnounce={onAnnounce}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function ProtestRuling({
  protest,
  state,
  controller,
  onAnnounce,
  navigationTarget: _navigationTarget,
  onClearNavigationTarget: _onClearNavigationTarget,
}: {
  protest: DirectorState['protests'][number];
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (message: string) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const game = state.games.find((entry) => entry.id === protest.gameId);
  const scheduled = game
    ? state.scheduledGames.find((entry) => entry.id === game.scheduledGameId)
    : undefined;
  const [ruling, setRuling] = useState('');
  const [teamId, setTeamId] = useState('');
  const [delta, setDelta] = useState('');
  if (!game || !scheduled || !scheduled.rightTeamId) return null;
  const save = () => {
    if (!ruling.trim()) {
      onAnnounce('Enter the protest ruling first.');
      return;
    }
    let adjustment: ProtestScoreAdjustment | undefined;
    if (teamId || delta.trim()) {
      const parsedDelta = Number(delta);
      if (!teamId || !Number.isInteger(parsedDelta) || parsedDelta === 0) {
        onAnnounce('A score correction needs a team and a non-zero whole-number adjustment.');
        return;
      }
      adjustment = { teamId, delta: parsedDelta };
    }
    if (!controller.ruleProtest(protest.id, ruling, adjustment)) return;
    onAnnounce('Protest ruled and retained in the audit history.');
  };
  return (
    <form
      className="director-result-action-panel director-protest-ruling"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <FormField label="Ruling">
        <textarea
          className="director-textarea"
          rows={2}
          value={ruling}
          onChange={(event) => setRuling(event.target.value)}
          placeholder="How was the protest resolved?"
        />
      </FormField>
      <div className="director-form-grid director-form-grid-two">
        <FormField label="Score correction team">
          <select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
            <option value="">No score change</option>
            <option value={scheduled.leftTeamId}>{teamLabel(state, scheduled.leftTeamId)}</option>
            <option value={scheduled.rightTeamId}>{teamLabel(state, scheduled.rightTeamId)}</option>
          </select>
        </FormField>
        <FormField label="Point adjustment" hint="Use a positive or negative whole number.">
          <input
            type="number"
            step="1"
            value={delta}
            onChange={(event) => setDelta(event.target.value)}
            placeholder="Optional"
          />
        </FormField>
      </div>
      <Button variant="primary" type="submit">
        Rule protest
      </Button>
    </form>
  );
}

function ManualResult({
  state,
  controller,
  onSuccess,
  onAnnounce,
  navigationTarget: _navigationTarget,
  onClearNavigationTarget: _onClearNavigationTarget,
}: {
  state: DirectorState;
  controller: DirectorController;
  onSuccess: () => void;
  onAnnounce: (message: string) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const choices = state.scheduledGames.filter(
    (game) => !game.bye && !['accepted', 'cancelled'].includes(game.status),
  );
  const [gameId, setGameId] = useState(choices[0]?.id ?? '');
  const effectiveGameId = choices.some((game) => game.id === gameId) ? gameId : (choices[0]?.id ?? '');
  const selected = choices.find((game) => game.id === effectiveGameId);
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
      onSuccess();
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
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div className="director-panel-body">
            <div className="director-form-grid">
              <FormField label="Scheduled game">
                <select
                  value={effectiveGameId}
                  onChange={(event) => {
                    setGameId(event.target.value);
                    setLeftScore('');
                    setRightScore('');
                    setValidationError(null);
                  }}
                >
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
            <Button variant="primary" type="submit">
              Accept manual result
            </Button>
          </div>
        </form>
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

function categoryLabel(category: DirectorState['protests'][number]['category']): string {
  return category === 'tossup'
    ? 'Tossup'
    : category === 'bonus'
      ? 'Bonus'
      : category === 'procedure'
        ? 'Procedure'
        : 'Other';
}

function formatDelta(delta: number): string {
  return `${delta > 0 ? '+' : ''}${delta}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
