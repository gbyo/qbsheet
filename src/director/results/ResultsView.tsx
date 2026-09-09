import { useCallback, useMemo, useState } from 'react';
import {
  resultDecisionIssue,
  type DirectorState,
  type ProtestScoreAdjustment,
  type TeamGameScore,
} from '../domain';
import type { AdministrativeResultReplacement, DirectorController } from '../state/useDirectorController';
import {
  ActionMenu,
  Button,
  Callout,
  Diagnostics,
  Dialog,
  DialogSection,
  EmptyState,
  Field,
  FieldGrid,
  MenuItem,
  NumberInput,
  Page,
  PageHeader,
  Segmented,
  Select,
  StateLabel,
  SummaryItem,
  SummaryList,
  TextArea,
  useConfirm,
} from '../components';
import type { SectionId } from '../app/navigation';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { useNavigationHighlight } from '../app/useNavigationHighlight';
import { describeWarning } from '../transfers/ingest';
import { errorNotice, type AnnounceInput } from '../notices';

type ResultsViewMode = 'review' | 'games' | 'protests' | 'history';
type SubmissionAction = 'reject' | 'associate' | 'edit' | 'correct-forfeit' | 'protest';

export function resultsViewForTarget(
  state: DirectorState,
  target: DirectorNavigationTarget | null | undefined,
): ResultsViewMode | null {
  if (target?.section !== 'results') return null;
  if (target.entityType === 'game') return 'games';
  if (target.entityType !== 'submission') return null;

  const submission = state.submissions.find((entry) => entry.id === target.entityId);
  return submission && ['received', 'review'].includes(submission.status) ? 'review' : 'history';
}

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
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const reviewCount = state.submissions.filter(
    (submission) => submission.status === 'review' || submission.status === 'received',
  ).length;
  const openProtestCount = state.protests.filter((protest) => protest.status === 'open').length;
  const unresolvedGameCount = state.scheduledGames.filter(
    (game) => !game.bye && !['accepted', 'cancelled'].includes(game.status),
  ).length;
  const targetView = resultsViewForTarget(state, navigationTarget);
  const [view, setView] = useState<ResultsViewMode>(
    () => targetView ?? (reviewCount > 0 ? 'review' : openProtestCount > 0 ? 'protests' : 'games'),
  );
  const [roundFilter, setRoundFilter] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const targetedRoundId =
    navigationTarget?.section === 'results' && navigationTarget.entityType === 'round'
      ? navigationTarget.entityId
      : undefined;
  const roundId = targetedRoundId ?? roundFilter;

  // Render the target's queue immediately. The resolved view is committed to
  // local state when the one-shot highlight clears the target, so navigation
  // does not depend on a render-phase state update or an effect-driven flash.
  const selectedView = targetView ?? view;
  const clearTargetAfterNavigation = useCallback(() => {
    if (targetView) setView(targetView);
    onClearNavigationTarget?.();
  }, [onClearNavigationTarget, targetView]);

  const switchView = (next: ResultsViewMode) => {
    setView(next);
    if (navigationTarget?.section === 'results' && navigationTarget.entityType !== 'round')
      onClearNavigationTarget?.();
  };

  return (
    <Page>
      <PageHeader
        title="Results"
        description={`${reviewCount} need review · ${unresolvedGameCount} unresolved game${unresolvedGameCount === 1 ? '' : 's'} · ${openProtestCount} open protest${openProtestCount === 1 ? '' : 's'}`}
        actions={
          <>
            {onNavigate && (
              <Button variant="secondary" icon="upload" onClick={() => onNavigate('transfers')}>
                Import via Transfers
              </Button>
            )}
            <Button variant="primary" icon="plus" onClick={() => setManualOpen(true)}>
              Enter result
            </Button>
          </>
        }
      />

      <div className="director-results-toolbar">
        <Segmented<ResultsViewMode>
          value={selectedView}
          onChange={switchView}
          ariaLabel="Results view"
          options={[
            { value: 'review', label: `Needs review ${reviewCount}` },
            { value: 'games', label: `Games ${unresolvedGameCount}` },
            { value: 'protests', label: `Protests ${openProtestCount}` },
            { value: 'history', label: 'History' },
          ]}
        />
        <Field
          label="Round"
          render={({ id, labelId, describedBy }) => (
            <Select
              id={id}
              ariaLabelledBy={labelId}
              ariaDescribedBy={describedBy}
              value={roundId}
              options={[
                { value: '', label: 'All rounds' },
                ...state.rounds.map((round) => ({ value: round.id, label: round.name })),
              ]}
              onChange={(value) => {
                setRoundFilter(value);
                clearTargetAfterNavigation();
              }}
            />
          )}
        />
      </div>

      {selectedView === 'review' && (
        <SubmissionQueue
          state={state}
          controller={controller}
          roundId={roundId}
          history={false}
          onAnnounce={onAnnounce}
          navigationTarget={navigationTarget}
          onClearNavigationTarget={clearTargetAfterNavigation}
        />
      )}
      {selectedView === 'history' && (
        <SubmissionQueue
          state={state}
          controller={controller}
          roundId={roundId}
          history
          onAnnounce={onAnnounce}
          navigationTarget={navigationTarget}
          onClearNavigationTarget={clearTargetAfterNavigation}
        />
      )}
      {selectedView === 'games' && (
        <GamesQueue
          state={state}
          controller={controller}
          roundId={roundId}
          onAnnounce={onAnnounce}
          navigationTarget={navigationTarget}
          onClearNavigationTarget={clearTargetAfterNavigation}
        />
      )}
      {selectedView === 'protests' && (
        <ProtestsQueue state={state} controller={controller} onAnnounce={onAnnounce} />
      )}

      {manualOpen && (
        <ManualResultDialog
          roundId={roundId}
          state={state}
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setManualOpen(false)}
        />
      )}
    </Page>
  );
}

function SubmissionQueue({
  state,
  controller,
  roundId,
  history,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
  state: DirectorState;
  controller: DirectorController;
  roundId?: string;
  history: boolean;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const targetSubmissionId =
    navigationTarget?.section === 'results' && navigationTarget.entityType === 'submission'
      ? navigationTarget.entityId
      : undefined;
  const submissions = useMemo(() => {
    return state.submissions
      .filter((submission) => {
        if (submission.id === targetSubmissionId) return true;
        const inRound =
          !roundId || state.games.some((game) => game.id === submission.gameId && game.roundId === roundId);
        const review = submission.status === 'review' || submission.status === 'received';
        return inRound && (history ? !review : review);
      })
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
  }, [history, roundId, state.games, state.submissions, targetSubmissionId]);

  if (!submissions.length) {
    return (
      <EmptyState
        title={history ? 'No result history in this view' : 'Nothing needs review'}
        description={
          history
            ? 'Accepted, rejected, duplicate, and superseded submissions appear here.'
            : 'New QBTCP and imported submissions will appear here when they need a decision.'
        }
      />
    );
  }
  return (
    <SummaryList ariaLabel={history ? 'Result history' : 'Results needing review'}>
      {submissions.map((submission) => (
        <SubmissionItem
          key={submission.id}
          state={state}
          submission={submission}
          controller={controller}
          onAnnounce={onAnnounce}
          navigationTarget={navigationTarget}
          onClearNavigationTarget={onClearNavigationTarget}
        />
      ))}
    </SummaryList>
  );
}

function SubmissionItem({
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
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const highlighted = useNavigationHighlight(
    navigationTarget,
    'results',
    'submission',
    submission.id,
    onClearNavigationTarget,
  );
  const [action, setAction] = useState<SubmissionAction | null>(null);
  const game = state.games.find((entry) => entry.id === submission.gameId);
  const scheduled = game
    ? state.scheduledGames.find((entry) => entry.id === game.scheduledGameId)
    : undefined;
  const left = scheduled ? teamLabel(state, scheduled.leftTeamId) : 'Unmatched result';
  const right = scheduled ? teamLabel(state, scheduled.rightTeamId) : '';
  const score = game
    ? scheduled
      ? [scheduled.leftTeamId, scheduled.rightTeamId]
          .map((teamId) => game.scores.find((entry) => entry.teamId === teamId)?.score ?? '—')
          .join('–')
      : game.scores.map((entry) => entry.score).join('–') || '—'
    : '—';
  const review = submission.status === 'received' || submission.status === 'review';
  const cancelledGame = scheduled?.status === 'cancelled' || game?.status === 'cancelled';
  const warnings = submission.warnings ?? [];
  const round = scheduled ? state.rounds.find((entry) => entry.id === scheduled.roundId) : undefined;

  return (
    <SummaryItem
      className={highlighted ? 'is-navigation-target' : ''}
      title={
        <strong data-director-navigation-id={submission.id} data-director-navigation-focus tabIndex={-1}>
          {scheduled ? `${left} vs ${right}` : left}
        </strong>
      }
      status={
        <StateLabel
          state={submissionState(submission.status)}
          label={submissionStatusLabel(submission.status)}
        />
      }
      summary={`${score} · ${round?.name ?? 'Unmatched'} · Received ${formatTime(submission.receivedAt)}${game?.source ? ` · ${game.source}` : ''}`}
      actions={
        <div className="director-actions">
          {review && !cancelledGame && (
            <Button
              variant="primary"
              onClick={() => {
                const accepted = controller.acceptSubmission(submission.id);
                onAnnounce(
                  accepted
                    ? `${left} result accepted.`
                    : errorNotice(`${left} result remains in review; it was not accepted.`),
                );
              }}
            >
              Accept
            </Button>
          )}
          {(review || submission.status === 'accepted') && (
            <ActionMenu label={`${left} result actions`} triggerLabel={`${left} result actions`}>
              {(close) => (
                <>
                  {review && (
                    <MenuItem
                      icon="x"
                      tone="danger"
                      onSelect={() => {
                        close();
                        setAction('reject');
                      }}
                    >
                      Reject result…
                    </MenuItem>
                  )}
                  {review && !scheduled && game && (
                    <MenuItem
                      icon="link"
                      onSelect={() => {
                        close();
                        setAction('associate');
                      }}
                    >
                      Associate with scheduled game…
                    </MenuItem>
                  )}
                  {submission.status === 'accepted' && game?.status === 'forfeit' && scheduled && (
                    <MenuItem
                      icon="edit"
                      onSelect={() => {
                        close();
                        setAction('correct-forfeit');
                      }}
                    >
                      Correct forfeit…
                    </MenuItem>
                  )}
                  {submission.status === 'accepted' && game && game.status !== 'forfeit' && scheduled && (
                    <MenuItem
                      icon="edit"
                      onSelect={() => {
                        close();
                        setAction('edit');
                      }}
                    >
                      Correct accepted result…
                    </MenuItem>
                  )}
                  {submission.status === 'accepted' && game && scheduled?.rightTeamId && (
                    <MenuItem
                      icon="flag"
                      onSelect={() => {
                        close();
                        setAction('protest');
                      }}
                    >
                      Open protest…
                    </MenuItem>
                  )}
                </>
              )}
            </ActionMenu>
          )}
        </div>
      }
    >
      {cancelledGame && review && (
        <Callout tone="warning">
          This game is cancelled, so the submission cannot be accepted unless the game state is repaired
          first.
        </Callout>
      )}
      {warnings.length > 0 && (
        <Callout tone="warning" title="Submission warnings">
          {warnings.map(describeWarning).join(' ')}
        </Callout>
      )}
      {game?.detailedStats && game.detailedStats !== 'complete' && (
        <p className="director-text-meta">
          {game.detailedStats === 'unknown' ? 'Detailed stats not recorded.' : 'Detailed stats incomplete.'}
        </p>
      )}
      <Diagnostics
        label="Submission details"
        standalone={false}
        items={[
          { term: 'Submission ID', value: submission.id, mono: true },
          ...(submission.reason ? [{ term: 'Reason', value: submission.reason }] : []),
        ]}
      />
      {action && game && (
        <SubmissionActionDialog
          mode={action}
          state={state}
          submission={submission}
          game={game}
          scheduled={scheduled}
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setAction(null)}
        />
      )}
    </SummaryItem>
  );
}

function SubmissionActionDialog({
  mode,
  state,
  submission,
  game,
  scheduled,
  controller,
  onAnnounce,
  onClose,
}: {
  mode: SubmissionAction;
  state: DirectorState;
  submission: DirectorState['submissions'][number];
  game: DirectorState['games'][number];
  scheduled?: DirectorState['scheduledGames'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const unresolvedChoices = state.scheduledGames.filter(
    (candidate) => !candidate.bye && !['accepted', 'cancelled'].includes(candidate.status),
  );
  const [scheduledGameId, setScheduledGameId] = useState(unresolvedChoices[0]?.id ?? '');
  const leftScore = scheduled
    ? game.scores.find((entry) => entry.teamId === scheduled.leftTeamId)
    : undefined;
  const rightScore = scheduled?.rightTeamId
    ? game.scores.find((entry) => entry.teamId === scheduled.rightTeamId)
    : undefined;
  const [left, setLeft] = useState(String(leftScore?.score ?? ''));
  const [right, setRight] = useState(String(rightScore?.score ?? ''));
  const [category, setCategory] = useState<'tossup' | 'bonus' | 'procedure' | 'other'>('other');
  const [description, setDescription] = useState('');
  const currentForfeitingTeam = game.forfeitedTeamId ?? scheduled?.leftTeamId ?? '';
  const [correctionKind, setCorrectionKind] = useState<AdministrativeResultReplacement['kind']>('reopen');
  const [correctionForfeitingTeamId, setCorrectionForfeitingTeamId] = useState(currentForfeitingTeam);

  if (mode === 'reject') {
    return (
      <Dialog
        title="Reject result"
        description="The raw submission is retained and the scheduled game reopens so the room can send a corrected result."
        onClose={onClose}
        onSubmit={() => {
          const rejected = controller.rejectSubmission(submission.id, reason.trim() || undefined);
          onAnnounce(
            rejected
              ? 'Result rejected and game reopened.'
              : errorNotice('The result could not be rejected; review the current state.'),
          );
          if (rejected) onClose();
        }}
        submitLabel="Reject result"
        submitVariant="danger"
      >
        <Field label="Reason" optional hint="Stored on the submission and in audit history.">
          <TextArea
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Scores transposed; room is re-entering"
          />
        </Field>
      </Dialog>
    );
  }

  if (mode === 'associate') {
    return (
      <Dialog
        title="Associate result"
        description="Association does not accept the result. Verify it afterward before accepting."
        onClose={onClose}
        onSubmit={() => {
          if (!scheduledGameId) return;
          const associated = controller.associateSubmission(submission.id, scheduledGameId);
          onAnnounce(
            associated
              ? 'Result associated with the selected game and kept in review.'
              : errorNotice('The result was not associated; review the Director error.'),
          );
          if (associated) onClose();
        }}
        submitLabel="Associate result"
        submitDisabled={!scheduledGameId}
      >
        <Field
          label="Scheduled game"
          render={({ id, labelId, describedBy }) => (
            <Select
              id={id}
              ariaLabelledBy={labelId}
              ariaDescribedBy={describedBy}
              value={scheduledGameId}
              options={unresolvedChoices.map((candidate) => ({
                value: candidate.id,
                label: matchupLabel(state, candidate),
                detail: state.rounds.find((round) => round.id === candidate.roundId)?.name,
              }))}
              onChange={setScheduledGameId}
            />
          )}
        />
      </Dialog>
    );
  }

  if (mode === 'correct-forfeit' && scheduled) {
    return (
      <Dialog
        title="Correct administrative forfeit"
        description={`Currently recorded: ${teamLabel(state, currentForfeitingTeam)} forfeited. The original action stays in audit history.`}
        onClose={onClose}
        onSubmit={() => {
          if (!reason.trim()) {
            onAnnounce(errorNotice('A correction reason is required for an administrative forfeit.'));
            return;
          }
          let replacement: AdministrativeResultReplacement;
          if (correctionKind === 'reopen') replacement = { kind: 'reopen' };
          else if (correctionKind === 'forfeit') {
            replacement = { kind: 'forfeit', forfeitedTeamId: correctionForfeitingTeamId };
          } else {
            const nextLeft = Number(left);
            const nextRight = Number(right);
            if (
              !left.trim() ||
              !right.trim() ||
              !Number.isInteger(nextLeft) ||
              !Number.isInteger(nextRight)
            ) {
              onAnnounce(errorNotice('Replacement scores must be finite whole numbers.'));
              return;
            }
            replacement = {
              kind: 'scores',
              scores: [
                { ...scoreForTeam(game, scheduled.leftTeamId), score: nextLeft },
                { ...scoreForTeam(game, scheduled.rightTeamId!), score: nextRight },
              ],
            };
          }
          const saved = controller.correctForfeit(scheduled.id, replacement, reason);
          onAnnounce(
            saved
              ? 'Administrative result corrected; the original forfeit remains in audit history.'
              : errorNotice('The forfeit correction was not saved; review the Director error.'),
          );
          if (saved) onClose();
        }}
        submitLabel="Save correction"
      >
        <Field
          label="Correction outcome"
          render={({ id, labelId, describedBy }) => (
            <Select<AdministrativeResultReplacement['kind']>
              id={id}
              ariaLabelledBy={labelId}
              ariaDescribedBy={describedBy}
              value={correctionKind}
              options={[
                { value: 'reopen', label: 'Reopen game' },
                { value: 'forfeit', label: 'Switch forfeiting team' },
                { value: 'scores', label: 'Replace with played result' },
              ]}
              onChange={setCorrectionKind}
            />
          )}
        />
        {correctionKind === 'forfeit' && (
          <Field
            label="Forfeiting team"
            render={({ id, labelId, describedBy }) => (
              <Select
                id={id}
                ariaLabelledBy={labelId}
                ariaDescribedBy={describedBy}
                value={correctionForfeitingTeamId}
                options={[scheduled.leftTeamId, scheduled.rightTeamId!].map((teamId) => ({
                  value: teamId,
                  label: teamLabel(state, teamId),
                }))}
                onChange={setCorrectionForfeitingTeamId}
              />
            )}
          />
        )}
        {correctionKind === 'scores' && (
          <FieldGrid>
            <Field label={teamLabel(state, scheduled.leftTeamId)}>
              <NumberInput step={1} value={left} onChange={(event) => setLeft(event.target.value)} />
            </Field>
            <Field label={teamLabel(state, scheduled.rightTeamId)}>
              <NumberInput step={1} value={right} onChange={(event) => setRight(event.target.value)} />
            </Field>
          </FieldGrid>
        )}
        <Field label="Correction reason">
          <TextArea
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Wrong team selected; game should be played"
          />
        </Field>
      </Dialog>
    );
  }

  if (mode === 'edit' && scheduled) {
    return (
      <Dialog
        title="Correct accepted result"
        description="The prior accepted result remains in audit history."
        onClose={onClose}
        onSubmit={() => {
          const nextLeft = Number(left);
          const nextRight = Number(right);
          if (!left.trim() || !right.trim() || !Number.isInteger(nextLeft) || !Number.isInteger(nextRight)) {
            onAnnounce(errorNotice('Corrected scores must be finite whole numbers.'));
            return;
          }
          const scores = game.scores.map((entry) =>
            entry.teamId === scheduled.leftTeamId
              ? { ...entry, score: nextLeft }
              : entry.teamId === scheduled.rightTeamId
                ? { ...entry, score: nextRight }
                : entry,
          );
          const saved = controller.editAcceptedResult(game.id, scores, reason.trim() || undefined);
          onAnnounce(
            saved
              ? 'Accepted result corrected; the prior result remains in audit history.'
              : errorNotice('The correction was not saved; review the Director error.'),
          );
          if (saved) onClose();
        }}
        submitLabel="Save correction"
      >
        <FieldGrid>
          <Field label={teamLabel(state, scheduled.leftTeamId)}>
            <NumberInput step={1} value={left} onChange={(event) => setLeft(event.target.value)} />
          </Field>
          <Field label={teamLabel(state, scheduled.rightTeamId)}>
            <NumberInput step={1} value={right} onChange={(event) => setRight(event.target.value)} />
          </Field>
        </FieldGrid>
        <Field label="Correction note" optional>
          <TextArea
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is the accepted score changing?"
          />
        </Field>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Open protest"
      description="The accepted result remains in place until a ruling changes it."
      onClose={onClose}
      onSubmit={() => {
        if (!description.trim()) {
          onAnnounce(errorNotice('Describe the protest before saving it.'));
          return;
        }
        const saved = controller.addProtest(game.id, description, category);
        onAnnounce(
          saved
            ? 'Protest opened and retained with the accepted result.'
            : errorNotice('The protest was not opened; review the Director error.'),
        );
        if (saved) onClose();
      }}
      submitLabel="Open protest"
    >
      <Field
        label="Category"
        render={({ id, describedBy }) => (
          <Select<typeof category>
            id={id}
            ariaDescribedBy={describedBy}
            value={category}
            options={[
              { value: 'tossup', label: 'Tossup' },
              { value: 'bonus', label: 'Bonus' },
              { value: 'procedure', label: 'Procedure' },
              { value: 'other', label: 'Other' },
            ]}
            onChange={setCategory}
          />
        )}
      />
      <Field label="Description">
        <TextArea
          rows={4}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What needs review?"
        />
      </Field>
    </Dialog>
  );
}

function GamesQueue({
  state,
  controller,
  roundId,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
  state: DirectorState;
  controller: DirectorController;
  roundId?: string;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const [showSettled, setShowSettled] = useState(false);
  const targetGameId =
    navigationTarget?.section === 'results' && navigationTarget.entityType === 'game'
      ? navigationTarget.entityId
      : undefined;
  /*
   * A game revealed by a deep link stays revealed.
   *
   * `useNavigationHighlight` is a one-shot: it focuses the row and then clears
   * the target, a render later. Filtering on the live target alone therefore
   * revealed an accepted or cancelled game, focused it, and removed it from the
   * list in the same gesture — the row vanishing out from under the focus that
   * had just landed on it. Remembering the id keeps it there until the director
   * hides settled games again, and re-navigating re-reveals it.
   */
  const [revealedGameId, setRevealedGameId] = useState<string | undefined>(targetGameId);
  if (targetGameId && targetGameId !== revealedGameId) setRevealedGameId(targetGameId);
  const revealed = targetGameId ?? revealedGameId;
  const scheduled = state.scheduledGames.filter(
    (game) => !game.bye && (!roundId || game.roundId === roundId || game.id === revealed),
  );
  const games = scheduled.filter(
    (game) => showSettled || !['accepted', 'cancelled'].includes(game.status) || game.id === revealed,
  );
  const expanded =
    showSettled ||
    scheduled.some((game) => game.id === revealed && ['accepted', 'cancelled'].includes(game.status));
  if (!games.length) {
    return (
      <EmptyState title="No unresolved games" description="Every game in this view is accepted or cancelled.">
        {scheduled.length > 0 && (
          <Button variant="secondary" onClick={() => setShowSettled(true)}>
            Show settled games
          </Button>
        )}
      </EmptyState>
    );
  }
  return (
    <div className="director-stack">
      <div className="director-view-actions">
        <Button
          variant="quiet"
          onClick={() => {
            // The control names the state the list is actually in — which, when
            // a deep link has revealed a settled game, is "showing settled
            // games" even though the toggle itself is off. So it also has to be
            // the way out of a reveal.
            setShowSettled(!expanded);
            setRevealedGameId(undefined);
            onClearNavigationTarget?.();
          }}
        >
          {expanded ? 'Hide settled games' : 'Show settled games'}
        </Button>
      </div>
      <SummaryList ariaLabel="Scheduled games">
        {games.map((game) => (
          <ScheduledGameItem
            key={game.id}
            state={state}
            game={game}
            controller={controller}
            onAnnounce={onAnnounce}
            navigationTarget={navigationTarget}
            onClearNavigationTarget={onClearNavigationTarget}
          />
        ))}
      </SummaryList>
    </div>
  );
}

function ScheduledGameItem({
  state,
  game,
  controller,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
  state: DirectorState;
  game: DirectorState['scheduledGames'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const confirmAction = useConfirm();
  const [forfeitOpen, setForfeitOpen] = useState(false);
  const highlighted = useNavigationHighlight(
    navigationTarget,
    'results',
    'game',
    game.id,
    onClearNavigationTarget,
  );
  const round = state.rounds.find((entry) => entry.id === game.roundId);
  const room = game.roomId ? state.rooms.find((entry) => entry.id === game.roomId) : undefined;
  const canCancel = !['accepted', 'cancelled'].includes(game.status) && !game.bracketKey;
  const canForfeit = !['accepted', 'cancelled'].includes(game.status) && Boolean(game.rightTeamId);
  return (
    <SummaryItem
      className={highlighted ? 'is-navigation-target' : ''}
      title={
        <strong data-director-navigation-id={game.id} data-director-navigation-focus tabIndex={-1}>
          {matchupLabel(state, game)}
        </strong>
      }
      status={<StateLabel state={game.status} label={gameStatusLabel(game.status)} />}
      summary={`${round?.name ?? 'Unknown round'} · ${room?.name ?? 'Room unassigned'}`}
      actions={
        canCancel || canForfeit ? (
          <ActionMenu
            label={`${matchupLabel(state, game)} actions`}
            triggerLabel="Game actions"
            triggerVariant="secondary"
          >
            {(close) => (
              <>
                {canForfeit && (
                  <MenuItem
                    icon="flag"
                    onSelect={() => {
                      close();
                      setForfeitOpen(true);
                    }}
                  >
                    Record forfeit…
                  </MenuItem>
                )}
                {canCancel && (
                  <MenuItem
                    icon="trash"
                    tone="danger"
                    onSelect={() => {
                      close();
                      void (async () => {
                        const approved = await confirmAction({
                          title: `Cancel ${matchupLabel(state, game)}?`,
                          consequence:
                            'The game will no longer block the round from closing. Any raw submissions remain in history.',
                          confirmLabel: 'Cancel game',
                          tone: 'danger',
                        });
                        if (!approved) return;
                        const cancelled = controller.cancelScheduledGame(game.id);
                        onAnnounce(
                          cancelled
                            ? 'Scheduled game cancelled; the round can now close without it.'
                            : errorNotice('The game was not cancelled; review the Director error.'),
                        );
                      })();
                    }}
                  >
                    Cancel game…
                  </MenuItem>
                )}
              </>
            )}
          </ActionMenu>
        ) : undefined
      }
    >
      {game.bracketKey && game.status === 'cancelled' && (
        <Callout tone="warning">
          Cancelled elimination game: generate a replacement or record an explicit administrative resolution
          before closing the phase.
        </Callout>
      )}
      <Diagnostics
        label="Game details"
        standalone={false}
        items={[{ term: 'Game ID', value: game.id, mono: true }]}
      />
      {forfeitOpen && (
        <ForfeitDialog
          state={state}
          game={game}
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setForfeitOpen(false)}
        />
      )}
    </SummaryItem>
  );
}

function ForfeitDialog({
  state,
  game,
  controller,
  onAnnounce,
  onClose,
}: {
  state: DirectorState;
  game: DirectorState['scheduledGames'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const choices = [game.leftTeamId, game.rightTeamId].filter((id): id is string => Boolean(id));
  const [teamId, setTeamId] = useState(choices[0] ?? '');
  return (
    <Dialog
      title="Record forfeit"
      description="Choose the team that forfeited. Director records the administrative result so the round or bracket can advance."
      onClose={onClose}
      onSubmit={() => {
        const saved = controller.recordForfeit(game.id, teamId);
        onAnnounce(
          saved
            ? `${teamLabel(state, teamId)} recorded as forfeiting.`
            : errorNotice('The forfeit was not recorded; review the Director error.'),
        );
        if (saved) onClose();
      }}
      submitLabel="Record forfeit"
      submitVariant="danger"
    >
      <Field
        label="Forfeiting team"
        render={({ id, labelId, describedBy }) => (
          <Select
            id={id}
            ariaLabelledBy={labelId}
            ariaDescribedBy={describedBy}
            value={teamId}
            options={choices.map((id) => ({ value: id, label: teamLabel(state, id) }))}
            onChange={setTeamId}
          />
        )}
      />
    </Dialog>
  );
}

function ProtestsQueue({
  state,
  controller,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  if (!state.protests.length)
    return (
      <EmptyState title="No protests" description="Protests opened from accepted results will appear here." />
    );
  return (
    <SummaryList ariaLabel="Protests">
      {state.protests.map((protest) => (
        <ProtestItem
          key={protest.id}
          protest={protest}
          state={state}
          controller={controller}
          onAnnounce={onAnnounce}
        />
      ))}
    </SummaryList>
  );
}

function ProtestItem({
  protest,
  state,
  controller,
  onAnnounce,
}: {
  protest: DirectorState['protests'][number];
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const [rulingOpen, setRulingOpen] = useState(false);
  const game = state.games.find((entry) => entry.id === protest.gameId);
  const scheduled = game
    ? state.scheduledGames.find((entry) => entry.id === game.scheduledGameId)
    : undefined;
  return (
    <SummaryItem
      title={<strong>{scheduled ? matchupLabel(state, scheduled) : 'Unmatched game'}</strong>}
      status={<StateLabel state={protest.status} label={protest.status === 'open' ? 'Open' : 'Ruled'} />}
      summary={`${categoryLabel(protest.category)} · ${protest.description}`}
      actions={
        protest.status === 'open' && game && scheduled?.rightTeamId ? (
          <Button variant="primary" onClick={() => setRulingOpen(true)}>
            Rule protest
          </Button>
        ) : undefined
      }
    >
      {protest.ruling && (
        <p className="director-text-secondary">
          <strong>Ruling:</strong> {protest.ruling}
        </p>
      )}
      {protest.scoreAdjustment && (
        <p className="director-text-meta">
          Score correction: {teamLabel(state, protest.scoreAdjustment.teamId)}{' '}
          {formatDelta(protest.scoreAdjustment.delta)}
        </p>
      )}
      {rulingOpen && game && scheduled?.rightTeamId && (
        <ProtestRulingDialog
          protest={protest}
          state={state}
          scheduled={scheduled}
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setRulingOpen(false)}
        />
      )}
    </SummaryItem>
  );
}

function ProtestRulingDialog({
  protest,
  state,
  scheduled,
  controller,
  onAnnounce,
  onClose,
}: {
  protest: DirectorState['protests'][number];
  state: DirectorState;
  scheduled: DirectorState['scheduledGames'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const [ruling, setRuling] = useState('');
  const [teamId, setTeamId] = useState('');
  const [delta, setDelta] = useState('');
  return (
    <Dialog
      title="Rule protest"
      description="The ruling and any score correction are retained in audit history."
      onClose={onClose}
      onSubmit={() => {
        if (!ruling.trim()) {
          onAnnounce(errorNotice('Enter the protest ruling first.'));
          return;
        }
        let adjustment: ProtestScoreAdjustment | undefined;
        if (teamId || delta.trim()) {
          const parsed = Number(delta);
          if (!teamId || !Number.isInteger(parsed) || parsed === 0) {
            onAnnounce(
              errorNotice('A score correction needs a team and a non-zero whole-number adjustment.'),
            );
            return;
          }
          adjustment = { teamId, delta: parsed };
        }
        const saved = controller.ruleProtest(protest.id, ruling, adjustment);
        onAnnounce(
          saved
            ? 'Protest ruled and retained in the audit history.'
            : errorNotice('The ruling was not saved; review the Director error.'),
        );
        if (saved) onClose();
      }}
      submitLabel="Save ruling"
    >
      <Field label="Ruling">
        <TextArea
          rows={4}
          value={ruling}
          onChange={(event) => setRuling(event.target.value)}
          placeholder="How was the protest resolved?"
        />
      </Field>
      <DialogSection title="Optional score correction">
        <FieldGrid>
          <Field
            label="Team"
            render={({ id, labelId, describedBy }) => (
              <Select
                id={id}
                ariaLabelledBy={labelId}
                ariaDescribedBy={describedBy}
                value={teamId}
                options={[
                  { value: '', label: 'No score change' },
                  { value: scheduled.leftTeamId, label: teamLabel(state, scheduled.leftTeamId) },
                  { value: scheduled.rightTeamId ?? '', label: teamLabel(state, scheduled.rightTeamId) },
                ].filter((option) => option.value !== '' || option.label === 'No score change')}
                onChange={setTeamId}
              />
            )}
          />
          <Field label="Point adjustment" hint="Positive or negative whole number.">
            <NumberInput step={1} value={delta} onChange={(event) => setDelta(event.target.value)} />
          </Field>
        </FieldGrid>
      </DialogSection>
    </Dialog>
  );
}

function ManualResultDialog({
  roundId,
  state,
  controller,
  onAnnounce,
  onClose,
}: {
  roundId?: string;
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const choices = state.scheduledGames.filter(
    (game) =>
      !game.bye && (!roundId || game.roundId === roundId) && !['accepted', 'cancelled'].includes(game.status),
  );
  const [gameId, setGameId] = useState(choices[0]?.id ?? '');
  const selected = choices.find((game) => game.id === gameId) ?? choices[0];
  const [leftScore, setLeftScore] = useState('');
  const [rightScore, setRightScore] = useState('');
  /*
   * Scores are validated on the fields, not announced as a toast.
   *
   * A toast says what went wrong somewhere else on the screen and then goes
   * away; it does not mark the field, does not set `aria-invalid`, and is gone
   * by the time the operator looks down to fix it. Clearing on the next
   * keystroke is the other half: an error that outlives the correction is
   * noise.
   */
  const [scoreError, setScoreError] = useState<string | null>(null);
  const changeScore = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setScoreError(null);
  };
  return (
    <Dialog
      title="Enter result"
      description="Use for paper or offline games. The result is accepted immediately and updates standings."
      onClose={onClose}
      onSubmit={() => {
        if (!selected?.rightTeamId) {
          onAnnounce(errorNotice('Generate a non-bye scheduled game first.'));
          return;
        }
        const left = Number(leftScore);
        const right = Number(rightScore);
        if (!leftScore.trim() || !rightScore.trim() || !Number.isInteger(left) || !Number.isInteger(right)) {
          setScoreError('Enter both final team scores.');
          return;
        }
        const score = (teamId: string, value: number): TeamGameScore => ({
          teamId,
          score: value,
          superpowers: 0,
          powers: 0,
          gets: 0,
          negs: 0,
          bonuses: 0,
          bonusPoints: 0,
          bouncebacks: 0,
        });
        const scores = [score(selected.leftTeamId, left), score(selected.rightTeamId, right)];
        const decisionIssue = resultDecisionIssue(state, selected, scores);
        if (decisionIssue) {
          setScoreError(decisionIssue.message);
          onAnnounce(errorNotice(decisionIssue.message));
          return;
        }
        const accepted = controller.addManualResult({
          scheduledGameId: selected.id,
          scores,
        });
        onAnnounce(
          accepted
            ? 'Manual result accepted locally; standings updated.'
            : errorNotice('Manual result was not accepted; review the current game state.'),
        );
        if (accepted) onClose();
      }}
      submitLabel="Accept manual result"
      submitDisabled={!selected}
      errors={scoreError ? [scoreError] : undefined}
    >
      {choices.length === 0 ? (
        <Callout tone="info">There are no unresolved scheduled games available for manual entry.</Callout>
      ) : (
        <>
          <Field
            label="Scheduled game"
            render={({ id, labelId, describedBy }) => (
              <Select
                id={id}
                ariaLabelledBy={labelId}
                ariaDescribedBy={describedBy}
                value={selected?.id ?? ''}
                options={choices.map((game) => ({
                  value: game.id,
                  label: matchupLabel(state, game),
                  detail: state.rounds.find((round) => round.id === game.roundId)?.name,
                }))}
                onChange={(value) => {
                  setGameId(value);
                  setLeftScore('');
                  setRightScore('');
                  setScoreError(null);
                }}
              />
            )}
          />
          <FieldGrid>
            <Field label={selected ? teamLabel(state, selected.leftTeamId) : 'Left score'}>
              <NumberInput
                step={1}
                invalid={Boolean(scoreError)}
                value={leftScore}
                onChange={(event) => changeScore(setLeftScore)(event.target.value)}
              />
            </Field>
            <Field label={selected ? teamLabel(state, selected.rightTeamId) : 'Right score'}>
              <NumberInput
                step={1}
                invalid={Boolean(scoreError)}
                value={rightScore}
                onChange={(event) => changeScore(setRightScore)(event.target.value)}
              />
            </Field>
          </FieldGrid>
        </>
      )}
    </Dialog>
  );
}

function submissionState(status: DirectorState['submissions'][number]['status']): string {
  return status === 'accepted'
    ? 'accepted'
    : status === 'rejected'
      ? 'rejected'
      : status === 'duplicate' || status === 'superseded'
        ? 'warning'
        : 'review';
}
function submissionStatusLabel(status: DirectorState['submissions'][number]['status']): string {
  return status === 'received'
    ? 'Review'
    : status === 'superseded'
      ? 'Superseded'
      : status.charAt(0).toUpperCase() + status.slice(1);
}
function teamLabel(state: DirectorState, id: string | null): string {
  return id ? (state.teams.find((team) => team.id === id)?.displayName ?? 'Unknown team') : 'Bye';
}
function matchupLabel(state: DirectorState, game: DirectorState['scheduledGames'][number]): string {
  return `${teamLabel(state, game.leftTeamId)} vs ${teamLabel(state, game.rightTeamId)}`;
}
function scoreForTeam(game: DirectorState['games'][number], teamId: string): TeamGameScore {
  return (
    game.scores.find((entry) => entry.teamId === teamId) ?? {
      teamId,
      score: 0,
      superpowers: 0,
      powers: 0,
      gets: 0,
      negs: 0,
      bonuses: 0,
      bonusPoints: 0,
      bouncebacks: 0,
    }
  );
}
function gameStatusLabel(status: DirectorState['scheduledGames'][number]['status']): string {
  return (
    (
      {
        scheduled: 'Not started',
        released: 'Awaiting result',
        live: 'Playing',
        submitted: 'Review',
        accepted: 'Accepted',
        cancelled: 'Cancelled',
      } as Record<string, string>
    )[status] ?? status
  );
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
