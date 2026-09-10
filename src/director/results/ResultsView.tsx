import { useCallback, useMemo, useState, type DragEvent } from 'react';
import {
  definitionMatchesDefaults,
  planResultCorrectionImpact,
  resultDecisionIssue,
  resultRevisionOf,
  type DirectorState,
  type ProtestScoreAdjustment,
  type ResultCorrectionImpact,
  type TeamGameScore,
} from '../domain';
import type { AdministrativeResultReplacement, DirectorController } from '../state/useDirectorController';
import { advancementCorrectionBlocker, classifyResultCorrectionTier } from '../state/tournamentSafety';
import {
  ActionMenu,
  Button,
  Callout,
  DataTable,
  Diagnostics,
  Dialog,
  DialogSection,
  EmptyState,
  Field,
  FieldGrid,
  FilePicker,
  IdentityCell,
  MenuItem,
  NumberInput,
  Page,
  PageHeader,
  Panel,
  RowDetail,
  Segmented,
  Select,
  Specs,
  StateLabel,
  SummaryItem,
  SummaryList,
  TextArea,
  useConfirm,
  type Column,
  type PickedFile,
} from '../components';
import type { SectionId } from '../app/navigation';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { useNavigationHighlight } from '../app/useNavigationHighlight';
import { describeWarning } from '../transfers/ingest';
import { errorNotice, type AnnounceInput } from '../notices';
import { transferArtifactNeedsAttention } from '../transfers/attention';
import type { IncomingArtifact } from '../transfers/model';
import { describeSummary, type TransfersRuntime } from '../transfers/useTransfers';
import type { ImportSummary } from '../transfers/state';

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
  transfers,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
  state: DirectorState;
  controller: DirectorController;
  transfers?: TransfersRuntime;
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
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [dropActive, setDropActive] = useState(false);
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

  const importPickedFiles = useCallback(
    async (picked: PickedFile[]) => {
      if (!transfers) {
        onAnnounce(errorNotice('Returned-file import is unavailable in this Director view.'));
        return;
      }
      const files = picked.map((file) => {
        const bytes = new ArrayBuffer(file.bytes.byteLength);
        new Uint8Array(bytes).set(file.bytes);
        return new File([bytes], file.fileName, {
          type: 'application/vnd.quizbowl.qbj+json',
        });
      });
      setImportSummary(await transfers.importFiles(files, 'Chosen returned files'));
    },
    [onAnnounce, transfers],
  );

  const importDroppedFiles = useCallback(
    async (data: DataTransfer | null) => {
      if (!transfers) {
        onAnnounce(errorNotice('Returned-file import is unavailable in this Director view.'));
        return;
      }
      const summary = await transfers.importDataTransfer(data);
      if (summary) setImportSummary(summary);
    },
    [onAnnounce, transfers],
  );

  return (
    <Page>
      <PageHeader
        title="Results"
        description={`${reviewCount} need review · ${unresolvedGameCount} unresolved game${unresolvedGameCount === 1 ? '' : 's'} · ${openProtestCount} open protest${openProtestCount === 1 ? '' : 's'}`}
        actions={
          <>
            <FilePicker
              accept=".qbj,application/vnd.quizbowl.qbj+json,application/json"
              multiple
              disabled={!transfers}
              onPick={importPickedFiles}
              onError={(message) => onAnnounce(errorNotice(message))}
            >
              Import returned files
            </FilePicker>
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

      <div
        className={`director-results-import-dropzone ${dropActive ? 'is-active' : ''}`.trim()}
        role="region"
        aria-label="Import returned files"
        onDragEnter={(event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          setDropActive(true);
        }}
        onDragOver={(event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(event: DragEvent<HTMLDivElement>) => {
          if (event.currentTarget === event.target) setDropActive(false);
        }}
        onDrop={(event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          setDropActive(false);
          void importDroppedFiles(event.dataTransfer);
        }}
      >
        <strong>Drop returned QBJ files here</strong>
        <span>They will be matched and staged through the same review pipeline as QBTCP results.</span>
      </div>

      {importSummary && (
        <Callout
          tone={
            importSummary.invalid > 0
              ? 'danger'
              : importSummary.needsReview > 0 || importSummary.assignments > 0
                ? 'warning'
                : 'info'
          }
          title="Returned files imported"
          role="status"
        >
          {describeSummary(importSummary)}
          {importSummary.messages.length > 0 ? ` · ${importSummary.messages.join(' ')}` : ''}
        </Callout>
      )}

      <ImportProblemsQueue state={state} controller={controller} />

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

function ImportProblemsQueue({
  state,
  controller,
}: {
  state: DirectorState;
  controller: DirectorController;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());
  const problems = useMemo(
    () =>
      state.transfers.artifacts.filter((artifact) => {
        const needsAttention = transferArtifactNeedsAttention(artifact, state.submissions);
        return (
          !dismissedIds.has(artifact.id) &&
          (artifact.status === 'failed' ||
            artifact.classification === 'invalid' ||
            artifact.classification === 'assignment' ||
            artifact.classification === 'not-a-result' ||
            (needsAttention && !artifact.submissionId))
        );
      }),
    [dismissedIds, state.submissions, state.transfers.artifacts],
  );

  if (!problems.length) return null;

  const columns: Column<IncomingArtifact>[] = [
    {
      key: 'artifact',
      header: 'File / source',
      priority: 1,
      render: (artifact) => <IdentityCell title={artifact.fileName} detail={artifact.sourceLabel} />,
    },
    {
      key: 'status',
      header: 'Status',
      priority: 2,
      render: (artifact) => {
        const problem = importProblemFor(artifact);
        return <StateLabel state={problem.state} label={problem.label} tone={problem.tone} />;
      },
    },
    {
      key: 'reason',
      header: 'What needs attention',
      priority: 3,
      render: (artifact) => (
        <span className="director-text-secondary">
          {artifact.detail ??
            (artifact.warnings.length > 0
              ? artifact.warnings.map(describeWarning).join(' ')
              : 'No matching scheduled game.')}
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      priority: 1,
      actions: true,
      render: (artifact) => (
        <div>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              setDismissedIds((current) => new Set(current).add(artifact.id));
              controller.dismissTransferArtifact(artifact.id);
            }}
          >
            Dismiss
          </Button>
          <ActionMenu
            label={`${artifact.fileName} import actions`}
            triggerLabel={`${artifact.fileName} import actions`}
          >
            {(close) => (
              <MenuItem
                icon="info"
                onSelect={() => {
                  close();
                  setExpandedId((current) => (current === artifact.id ? null : artifact.id));
                }}
              >
                {expandedId === artifact.id ? 'Hide import details' : 'View import details'}
              </MenuItem>
            )}
          </ActionMenu>
        </div>
      ),
    },
  ];

  return (
    <Panel
      title="Import problems"
      description="Files Director could not match or read stay here as diagnostics; they never enter standings."
      flush
      className="director-results-import-problems"
    >
      <DataTable
        items={problems}
        columns={columns}
        rowKey={(artifact) => artifact.id}
        ariaLabel="Import problems"
        rowDetail={(artifact) =>
          expandedId === artifact.id ? <ImportProblemDetail artifact={artifact} /> : null
        }
      />
    </Panel>
  );
}

function importProblemFor(artifact: IncomingArtifact): {
  state: string;
  label: string;
  tone: 'warning' | 'danger';
} {
  if (artifact.status === 'failed' || artifact.classification === 'invalid') {
    return { state: 'error', label: 'Unreadable file', tone: 'danger' };
  }
  if (artifact.classification === 'assignment') {
    return { state: 'warning', label: 'Assignment file', tone: 'warning' };
  }
  if (artifact.classification === 'not-a-result') {
    return { state: 'warning', label: 'Not a result', tone: 'warning' };
  }
  return { state: 'unassigned', label: 'Unmatched result', tone: 'warning' };
}

function ImportProblemDetail({ artifact }: { artifact: IncomingArtifact }) {
  return (
    <RowDetail>
      <div className="director-row-detail-header">
        <div>
          <strong>Import diagnostic</strong>
          <p className="director-text-secondary">{artifact.fileName}</p>
        </div>
      </div>
      <Specs
        items={[
          { term: 'Source', value: artifact.sourceLabel },
          { term: 'Detected', value: formatTime(artifact.detectedAt) },
          { term: 'Size', value: formatByteCount(artifact.byteLength) },
          ...(artifact.originalPath ? [{ term: 'Path', value: artifact.originalPath, mono: true }] : []),
          { term: 'Reason', value: artifact.detail ?? 'No scheduled game matched this artifact.' },
          ...(artifact.warnings.length > 0
            ? [{ term: 'Warnings', value: artifact.warnings.map(describeWarning).join(' ') }]
            : []),
        ]}
      />
    </RowDetail>
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [action, setAction] = useState<{ mode: SubmissionAction; submissionId: string } | null>(null);
  const highlighted = useNavigationHighlight(
    navigationTarget,
    'results',
    'submission',
    targetSubmissionId ?? '',
    onClearNavigationTarget,
  );
  const submissions = useMemo(
    () =>
      state.submissions.filter((submission) => {
        if (submission.id === targetSubmissionId) return true;
        const inRound =
          !roundId || state.games.some((game) => game.id === submission.gameId && game.roundId === roundId);
        const review = submission.status === 'review' || submission.status === 'received';
        return inRound && (history ? !review : review);
      }),
    [history, roundId, state.games, state.submissions, targetSubmissionId],
  );

  const columns: Column<DirectorState['submissions'][number]>[] = [
    {
      key: 'matchup',
      header: 'Matchup',
      priority: 1,
      render: (submission) => {
        const scheduled = scheduledForSubmission(state, submission);
        return (
          <IdentityCell
            title={scheduled ? matchupLabel(state, scheduled) : 'Unmatched result'}
            detail={sourceLabelForSubmission(state, submission)}
          />
        );
      },
    },
    {
      key: 'score',
      header: 'Score',
      priority: 2,
      nowrap: true,
      render: (submission) => (
        <span className="director-table-state-cell">
          <strong>{scoreLineForSubmission(state, submission)}</strong>
          <small>Received {formatTime(submission.receivedAt)}</small>
        </span>
      ),
    },
    {
      key: 'round-room',
      header: 'Round / room',
      priority: 3,
      render: (submission) => {
        const scheduled = scheduledForSubmission(state, submission);
        const round = scheduled ? state.rounds.find((entry) => entry.id === scheduled.roundId) : undefined;
        const room = scheduled?.roomId
          ? state.rooms.find((entry) => entry.id === scheduled.roomId)
          : undefined;
        return (
          <span className="director-text-secondary">
            {round?.name ?? 'Unmatched'} · {room?.name ?? 'Room unassigned'}
          </span>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      priority: 2,
      render: (submission) => (
        <StateLabel
          state={submissionState(submission.status)}
          label={submissionStatusLabel(submission.status)}
        />
      ),
    },
    {
      key: 'action',
      header: 'Action',
      priority: 1,
      actions: true,
      render: (submission) => (
        <SubmissionActions
          state={state}
          submission={submission}
          controller={controller}
          onAnnounce={onAnnounce}
          expanded={expandedId === submission.id}
          onToggleDetails={() =>
            setExpandedId((current) => (current === submission.id ? null : submission.id))
          }
          onAction={(mode) => setAction({ mode, submissionId: submission.id })}
        />
      ),
    },
  ];

  const actionSubmission = action
    ? state.submissions.find((submission) => submission.id === action.submissionId)
    : undefined;
  const actionGame = actionSubmission
    ? state.games.find((game) => game.id === actionSubmission.gameId)
    : undefined;
  const actionScheduled = actionGame
    ? state.scheduledGames.find((game) => game.id === actionGame.scheduledGameId)
    : undefined;

  return (
    <>
      {submissions.length === 0 ? (
        <EmptyState
          title={history ? 'No result history in this view' : 'Nothing needs review'}
          description={
            history
              ? 'Accepted, rejected, duplicate, and superseded submissions appear here.'
              : 'New QBTCP and imported submissions will appear here when they need a decision.'
          }
        />
      ) : (
        <DataTable
          items={submissions}
          columns={columns}
          rowKey={(submission) => submission.id}
          ariaLabel={history ? 'Result history' : 'Results needing review'}
          rowProps={(submission) => ({
            className:
              highlighted && submission.id === targetSubmissionId ? 'is-navigation-target' : undefined,
            'data-director-navigation-id': submission.id,
            'data-director-navigation-focus': true,
            tabIndex: -1,
          })}
          rowDetail={(submission) =>
            expandedId === submission.id ? (
              <SubmissionRowDetail
                state={state}
                submission={submission}
                onClose={() => setExpandedId(null)}
              />
            ) : null
          }
        />
      )}
      {action && actionSubmission && actionGame && (
        <SubmissionActionDialog
          mode={action.mode}
          state={state}
          submission={actionSubmission}
          game={actionGame}
          scheduled={actionScheduled}
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setAction(null)}
        />
      )}
    </>
  );
}

function SubmissionActions({
  state,
  submission,
  controller,
  onAnnounce,
  expanded,
  onToggleDetails,
  onAction,
}: {
  state: DirectorState;
  submission: DirectorState['submissions'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  expanded: boolean;
  onToggleDetails: () => void;
  onAction: (mode: SubmissionAction) => void;
}) {
  const game = state.games.find((entry) => entry.id === submission.gameId);
  const scheduled = scheduledForSubmission(state, submission);
  const matchup = scheduled ? matchupLabel(state, scheduled) : 'Unmatched result';
  const review = submission.status === 'received' || submission.status === 'review';
  const cancelledGame = scheduled?.status === 'cancelled' || game?.status === 'cancelled';

  return (
    <>
      {review && !cancelledGame && (
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            const accepted = controller.acceptSubmission(submission.id);
            onAnnounce(
              accepted
                ? `${matchup} result accepted.`
                : errorNotice(`${matchup} result remains in review; it was not accepted.`),
            );
          }}
        >
          Accept
        </Button>
      )}
      <ActionMenu
        label={`${matchup} result actions`}
        triggerLabel={`${matchup} result actions`}
        triggerVariant="quiet"
      >
        {(close) => (
          <>
            <MenuItem
              icon="info"
              onSelect={() => {
                close();
                onToggleDetails();
              }}
            >
              {expanded ? 'Hide result details' : 'View result details'}
            </MenuItem>
            {review && (
              <MenuItem
                icon="x"
                tone="danger"
                onSelect={() => {
                  close();
                  onAction('reject');
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
                  onAction('associate');
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
                  onAction('correct-forfeit');
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
                  onAction('edit');
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
                  onAction('protest');
                }}
              >
                Open protest…
              </MenuItem>
            )}
          </>
        )}
      </ActionMenu>
    </>
  );
}

function SubmissionRowDetail({
  state,
  submission,
  onClose,
}: {
  state: DirectorState;
  submission: DirectorState['submissions'][number];
  onClose: () => void;
}) {
  const game = state.games.find((entry) => entry.id === submission.gameId);
  const scheduled = scheduledForSubmission(state, submission);
  const warnings = submission.warnings ?? [];
  const cancelledGame = scheduled?.status === 'cancelled' || game?.status === 'cancelled';
  const artifact = state.transfers.artifacts.find((entry) => entry.submissionId === submission.id);

  return (
    <RowDetail>
      <div className="director-row-detail-header">
        <div>
          <strong>Result details</strong>
          <p className="director-text-secondary">
            {scheduled ? matchupLabel(state, scheduled) : 'Unmatched result'}
          </p>
        </div>
        <Button variant="quiet" size="sm" onClick={onClose}>
          Hide details
        </Button>
      </div>
      {cancelledGame && (submission.status === 'received' || submission.status === 'review') && (
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
      <Specs
        items={[
          { term: 'Score', value: scoreLineForSubmission(state, submission) },
          { term: 'Source', value: sourceLabelForSubmission(state, submission) },
          { term: 'Received', value: formatTime(submission.receivedAt) },
          { term: 'Submission ID', value: submission.id, mono: true },
          ...(artifact ? [{ term: 'Returned file', value: artifact.fileName }] : []),
          ...(submission.reason ? [{ term: 'Reason', value: submission.reason }] : []),
        ]}
      />
      <Diagnostics
        label="Submission diagnostics"
        standalone={false}
        items={[
          ...(submission.transportResultId
            ? [{ term: 'Transport result ID', value: submission.transportResultId, mono: true }]
            : []),
          ...(submission.sessionId
            ? [{ term: 'QBTCP session', value: submission.sessionId, mono: true }]
            : []),
        ]}
      />
    </RowDetail>
  );
}

function scheduledForSubmission(
  state: DirectorState,
  submission: DirectorState['submissions'][number],
): DirectorState['scheduledGames'][number] | undefined {
  const game = state.games.find((entry) => entry.id === submission.gameId);
  return game ? state.scheduledGames.find((entry) => entry.id === game.scheduledGameId) : undefined;
}

function scoreLineForSubmission(
  state: DirectorState,
  submission: DirectorState['submissions'][number],
): string {
  const game = state.games.find((entry) => entry.id === submission.gameId);
  if (!game) return '—';
  const scheduled = scheduledForSubmission(state, submission);
  if (!scheduled) return game.scores.map((entry) => entry.score).join('–') || '—';
  return [scheduled.leftTeamId, scheduled.rightTeamId]
    .filter((teamId): teamId is string => Boolean(teamId))
    .map((teamId) => game.scores.find((entry) => entry.teamId === teamId)?.score ?? '—')
    .join('–');
}

function sourceLabelForSubmission(
  state: DirectorState,
  submission: DirectorState['submissions'][number],
): string {
  const artifact = state.transfers.artifacts.find((entry) => entry.submissionId === submission.id);
  if (artifact) return artifact.sourceLabel;
  if (submission.sessionId) return 'via QBTCP';
  const game = state.games.find((entry) => entry.id === submission.gameId);
  return game?.source === 'manual' ? 'Manual entry' : game?.source === 'paper' ? 'Paper' : 'Imported file';
}

/**
 * What saving a correction would invalidate, shown before anything is applied (#673).
 *
 * Advisory: the correction path re-verifies guards at commit, so a race with an
 * arriving result still refuses safely. A blocking issue disables Save outright.
 */
function CorrectionImpactNote({
  impact,
  tier,
  revision,
  tierBlocker,
}: {
  impact: ResultCorrectionImpact;
  tier: 1 | 2 | 3 | 4;
  revision: number;
  tierBlocker: string | null;
}) {
  if (impact.issue) {
    return (
      <Callout tone="warning" title="This correction cannot be saved as entered">
        {impact.issue}
      </Callout>
    );
  }
  if (tierBlocker) {
    return (
      <Callout tone="warning" title="This correction needs tournament recovery first">
        {tierBlocker}
      </Callout>
    );
  }
  if (impact.staleAdvancement.length === 0 && impact.bracketUpdates.length === 0) {
    return (
      <Callout tone="info" title="No downstream impact">
        No committed advancement or bracket games depend on this result.
      </Callout>
    );
  }
  return (
    <Callout tone="warning" title="Saving this correction would invalidate">
      <ul className="director-compact-list">
        {impact.staleAdvancement.map((entry) => (
          <li key={entry.phaseId}>
            Advancement from {entry.phaseName}
            {entry.qualifiersChange ? ' (the qualifier set changes)' : ' (basis changes)'}
          </li>
        ))}
        {impact.bracketUpdates.map((update) => (
          <li key={update.scheduledGameId}>Bracket game {update.scheduledGameId} would be re-seeded</li>
        ))}
        {tier === 2 && (
          <li>
            The saved result becomes revision {revision + 1}; committed advancement reads stale until it is
            recommitted.
          </li>
        )}
      </ul>
    </Callout>
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
  // What saving the edited scores would invalidate, recomputed as the operator types (#673).
  // Advisory only: the correction path re-verifies everything at commit.
  const correctionImpact = useMemo(() => {
    if (mode !== 'edit' || !scheduled) return null;
    const nextLeft = Number(left);
    const nextRight = Number(right);
    if (!left.trim() || !right.trim() || !Number.isInteger(nextLeft) || !Number.isInteger(nextRight)) {
      return null;
    }
    return planResultCorrectionImpact(
      state,
      game.id,
      game.scores.map((entry) =>
        entry.teamId === scheduled.leftTeamId
          ? { ...entry, score: nextLeft }
          : entry.teamId === scheduled.rightTeamId
            ? { ...entry, score: nextRight }
            : entry,
      ),
    );
  }, [mode, scheduled, state, game, left, right]);
  // The downstream lifecycle tier is state, not input: Tier 3/4 corrections are
  // refused at commit, so the dialog says so and disables Save up front (#673).
  const correctionTier = useMemo(() => classifyResultCorrectionTier(state, game.id), [state, game.id]);
  const correctionTierBlocker =
    mode === 'edit' && scheduled && correctionTier.tier >= 3
      ? advancementCorrectionBlocker(state, game.id)
      : null;

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
        submitDisabled={Boolean(correctionImpact?.issue) || Boolean(correctionTierBlocker)}
      >
        {correctionImpact && !correctionImpact.empty && (
          <CorrectionImpactNote
            impact={correctionImpact}
            tier={correctionTier.tier}
            revision={resultRevisionOf(game)}
            tierBlocker={correctionTierBlocker}
          />
        )}
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
  // An explicit reissue is only offered for issued but unstarted games (#672). Live,
  // submitted, and accepted games keep their definitions; the controller re-verifies
  // progress guards at commit, so a race with an arriving result still refuses safely.
  const canReissue =
    (game.definitionRevision !== undefined || game.definitionSnapshotId) &&
    (game.status === 'scheduled' || game.status === 'released');
  const defaultsMatch = definitionMatchesDefaults(state, game.id);
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
        canCancel || canForfeit || canReissue ? (
          <ActionMenu
            label={`${matchupLabel(state, game)} actions`}
            triggerLabel="Game actions"
            triggerVariant="secondary"
          >
            {(close) => (
              <>
                {canReissue && (
                  <MenuItem
                    icon="refresh"
                    onSelect={() => {
                      close();
                      void (async () => {
                        const approved = await confirmAction({
                          title: `Reissue ${matchupLabel(state, game)} with current defaults?`,
                          consequence:
                            'The game keeps no progress check behind: the reissue is re-verified at commit and refuses if scorer progress or a result arrived first. ' +
                            'On success the definition revision increments, old prepared files read as stale, and the room needs re-delivery.',
                          confirmLabel: 'Reissue game',
                        });
                        if (!approved) return;
                        const outcome = await Promise.resolve(controller.reissueGameDefinition(game.id));
                        if (!outcome.ok) {
                          onAnnounce(errorNotice(`The game was not reissued: ${outcome.reason}`));
                          return;
                        }
                        onAnnounce(
                          outcome.created
                            ? `Reissued ${matchupLabel(state, game)} with current defaults. Re-deliver its assignment.`
                            : `${matchupLabel(state, game)} already matches current defaults; no new revision.`,
                        );
                      })();
                    }}
                  >
                    Reissue with current defaults…
                  </MenuItem>
                )}
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
                        const cancelled = await Promise.resolve(controller.cancelScheduledGame(game.id));
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
        items={[
          { term: 'Game ID', value: game.id, mono: true },
          ...(game.definitionRevision !== undefined || game.definitionSnapshotId
            ? [
                {
                  term: 'Scoring rules',
                  value:
                    defaultsMatch === null
                      ? `Revision ${game.definitionRevision ?? '—'}`
                      : defaultsMatch
                        ? `Revision ${game.definitionRevision ?? '—'} · matches current defaults`
                        : `Revision ${game.definitionRevision ?? '—'} · differs from current defaults (historical, not an error)`,
                },
              ]
            : []),
        ]}
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
        void Promise.resolve(controller.recordForfeit(game.id, teamId)).then((saved) => {
          onAnnounce(
            saved
              ? `${teamLabel(state, teamId)} recorded as forfeiting.`
              : errorNotice('The forfeit was not recorded; review the Director error.'),
          );
          if (saved) onClose();
        });
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
        void Promise.resolve(
          controller.addManualResult({
            scheduledGameId: selected.id,
            scores,
          }),
        ).then((accepted) => {
          onAnnounce(
            accepted
              ? 'Manual result accepted locally; standings updated.'
              : errorNotice('Manual result was not accepted; review the current game state.'),
          );
          if (accepted) onClose();
        });
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

function formatByteCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} bytes`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
