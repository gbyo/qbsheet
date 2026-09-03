import { useMemo, useRef, useState } from 'react';
import {
  acceptedGameRecords,
  applyFinalPlacement,
  derivePlayerStandings,
  deriveTeamStandings,
  orderDayItems,
  playerPoints,
  totalAcceptedResults,
  type DirectorState,
  type GameRecord,
  type PlayerStanding,
  type TeamClassification,
  type TeamStanding,
} from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, EmptyState } from '../components/Controls';
import { PageHeader } from '../components/PageHeader';
import {
  buildStatReportBundle,
  exportTeamStandingsCsv,
  zipStatReportBundle,
} from '@qbsheet/tournament-formats';
import { errorNotice, infoNotice, type AnnounceInput } from '../notices';
import { buildCanonicalSnapshot } from '../reports/canonicalReports';
import { safeReportName, saveOrDownloadBytes, saveOrDownloadText } from '../reports/downloads';
import {
  INDIVIDUAL_COLUMNS,
  TEAM_COLUMNS,
  buildStatsScopes,
  classificationLabels,
  formatAverage,
  formatPpb,
  formatPptuh,
  formatRecord,
  formatTuh,
  formatWinPct,
  hasStoredStatsColumnPrefs,
  loadStatsColumnPrefs,
  saveStatsColumnPrefs,
  scopeOptionsFor,
  superpowersInUse,
  teamClassificationsOf,
  usedClassifications,
  type StatsColumnPrefs,
} from './statsDisplay';

type StatsTab = 'teams' | 'individuals' | 'games' | 'rounds';

const TABS: { id: StatsTab; label: string }[] = [
  { id: 'teams', label: 'Teams' },
  { id: 'individuals', label: 'Individuals' },
  { id: 'games', label: 'Games' },
  { id: 'rounds', label: 'Rounds' },
];

function initialPrefs(state: DirectorState): StatsColumnPrefs {
  const tournamentId = state.tournament?.id;
  const loaded = loadStatsColumnPrefs(tournamentId);
  if (!hasStoredStatsColumnPrefs(tournamentId) && superpowersInUse(state)) {
    return {
      teams: loaded.teams.includes('superpowers') ? loaded.teams : [...loaded.teams, 'superpowers'],
      individuals: loaded.individuals.includes('superpowers')
        ? loaded.individuals
        : [...loaded.individuals, 'superpowers'],
    };
  }
  return loaded;
}

export function StandingsView({
  state,
  controller,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const [tab, setTab] = useState<StatsTab>('teams');
  const [scopeId, setScopeId] = useState('overall');
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [classificationFilter, setClassificationFilter] = useState<'all' | TeamClassification>('all');
  const [prefsState, setPrefsState] = useState(() => ({
    tournamentId: state.tournament?.id,
    prefs: initialPrefs(state),
  }));
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Column preferences belong to the open tournament. Reconcile during render
  // when the tournament changes; stale team/player/scope selections self-heal
  // through the fallbacks below.
  if (prefsState.tournamentId !== state.tournament?.id) {
    setPrefsState({ tournamentId: state.tournament?.id, prefs: initialPrefs(state) });
  }
  const prefs = prefsState.prefs;

  const { scopes, showSelector } = useMemo(() => buildStatsScopes(state), [state]);
  const scope = useMemo(
    () => scopes.find((entry) => entry.id === scopeId) ?? scopes[0] ?? { id: 'overall', label: 'Overall' },
    [scopes, scopeId],
  );
  const isOverall = scope.id === 'overall';
  const scopeOptions = useMemo(() => scopeOptionsFor(scope), [scope]);
  const classifications = useMemo(() => usedClassifications(state), [state]);
  const acceptedCount = useMemo(() => totalAcceptedResults(state), [state]);

  const teamStandings = useMemo(() => {
    const calculated = deriveTeamStandings(state, undefined, scopeOptions);
    const ordered = isOverall
      ? applyFinalPlacement(calculated, state.tournament?.finalPlacement)
      : calculated;
    if (classificationFilter === 'all') return ordered;
    const matching = new Set(
      state.teams
        .filter((team) => teamClassificationsOf(state, team.id).includes(classificationFilter))
        .map((team) => team.id),
    );
    return ordered.filter((standing) => matching.has(standing.teamId));
  }, [state, scopeOptions, isOverall, classificationFilter]);

  const playerStandings = useMemo(() => {
    const teamIds =
      classificationFilter === 'all' ? undefined : teamStandings.map((standing) => standing.teamId);
    return derivePlayerStandings(state, {
      ...scopeOptions,
      ...(teamIds ? { teamIds } : {}),
    }).filter((standing) => standing.gamesPlayed > 0);
  }, [state, scopeOptions, classificationFilter, teamStandings]);

  const games = useMemo(() => acceptedGameRecords(state, scopeOptions), [state, scopeOptions]);

  const showTab = (next: StatsTab) => {
    setTab(next);
    setSelectedTeamId(null);
    setSelectedPlayerId(null);
  };

  const showScope = (next: string) => {
    setScopeId(next);
    setSelectedTeamId(null);
    setSelectedPlayerId(null);
  };

  const onTabKeyDown = (event: React.KeyboardEvent, index: number) => {
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    if (next !== null) {
      event.preventDefault();
      const tabId = TABS[next]?.id;
      if (tabId) showTab(tabId);
      tabRefs.current[next]?.focus();
    }
  };

  const updatePrefs = (kind: 'teams' | 'individuals', ids: string[]) => {
    const next = { ...prefs, [kind]: ids };
    setPrefsState({ tournamentId: state.tournament?.id, prefs: next });
    saveStatsColumnPrefs(state.tournament?.id, next);
  };

  const selectedTeam = selectedTeamId
    ? (state.teams.find((team) => team.id === selectedTeamId) ?? null)
    : null;
  const selectedPlayer = selectedPlayerId
    ? (state.players.find((player) => player.id === selectedPlayerId) ?? null)
    : null;

  return (
    <>
      <PageHeader
        eyebrow="Review"
        title="Stats"
        description="Team standings and individual statistics, derived from accepted game records and the tournament tiebreak configuration."
        actions={
          <>
            <Button
              variant="secondary"
              icon="download"
              onClick={() => downloadStandingsCsv(state, onAnnounce)}
            >
              Export CSV
            </Button>
            <Button
              variant="primary"
              icon="publish"
              onClick={() => void downloadStatReport(state, onAnnounce)}
            >
              Export stat report
            </Button>
          </>
        }
      />
      <div className="director-page-stack">
        {state.teams.length === 0 ? (
          <EmptyState
            title="No stats yet"
            description="Add teams and accept results to derive records, scoring, and player statistics."
          />
        ) : (
          <>
            <div className="director-stats-toolbar">
              <div role="tablist" aria-label="Statistics sections" className="director-tabs">
                {TABS.map((entry, index) => (
                  <button
                    key={entry.id}
                    ref={(element) => {
                      tabRefs.current[index] = element;
                    }}
                    role="tab"
                    id={`stats-tab-${entry.id}`}
                    aria-selected={tab === entry.id}
                    aria-controls={`stats-panel-${entry.id}`}
                    tabIndex={tab === entry.id ? 0 : -1}
                    className={tab === entry.id ? 'director-tab-active' : ''}
                    onClick={() => showTab(entry.id)}
                    onKeyDown={(event) => onTabKeyDown(event, index)}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
              <div className="director-stats-filters">
                {showSelector && (
                  <label className="director-inline-field">
                    Scope
                    <select value={scope.id} onChange={(event) => showScope(event.target.value)}>
                      {scopes.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {classifications.length > 0 && (
                  <label className="director-inline-field">
                    Group
                    <select
                      value={classificationFilter}
                      onChange={(event) =>
                        setClassificationFilter(event.target.value as 'all' | TeamClassification)
                      }
                    >
                      <option value="all">Every team</option>
                      {classifications.map((classification) => (
                        <option key={classification} value={classification}>
                          {classificationLabels[classification]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </div>
            <div
              role="tabpanel"
              id={`stats-panel-${tab}`}
              aria-labelledby={`stats-tab-${tab}`}
              className="director-panel"
            >
              {tab === 'teams' && selectedTeam === null && selectedPlayer === null && (
                <TeamsPanel
                  state={state}
                  controller={controller}
                  standings={teamStandings}
                  acceptedCount={acceptedCount}
                  isOverall={isOverall}
                  visibleColumns={prefs.teams}
                  onVisibleColumns={(ids) => updatePrefs('teams', ids)}
                  onSelectTeam={setSelectedTeamId}
                  onAnnounce={onAnnounce}
                />
              )}
              {tab === 'individuals' && selectedTeam === null && selectedPlayer === null && (
                <IndividualsPanel
                  state={state}
                  standings={playerStandings}
                  visibleColumns={prefs.individuals}
                  onVisibleColumns={(ids) => updatePrefs('individuals', ids)}
                  onSelectTeam={setSelectedTeamId}
                  onSelectPlayer={setSelectedPlayerId}
                />
              )}
              {tab === 'games' && selectedTeam === null && selectedPlayer === null && (
                <GamesPanel state={state} games={games} onSelectTeam={setSelectedTeamId} />
              )}
              {tab === 'rounds' && selectedTeam === null && selectedPlayer === null && (
                <RoundsPanel
                  state={state}
                  games={games}
                  scopePhaseId={scope.phaseId}
                  onSelectTeam={setSelectedTeamId}
                />
              )}
              {selectedTeam !== null && (
                <TeamDetail
                  state={state}
                  teamId={selectedTeam.id}
                  scopeOptions={scopeOptions}
                  isOverall={isOverall}
                  onBack={() => setSelectedTeamId(null)}
                  onSelectPlayer={setSelectedPlayerId}
                  onSelectTeam={setSelectedTeamId}
                />
              )}
              {selectedTeam === null && selectedPlayer !== null && (
                <PlayerDetail
                  state={state}
                  playerId={selectedPlayer.id}
                  scopeOptions={scopeOptions}
                  onBack={() => setSelectedPlayerId(null)}
                  onSelectTeam={setSelectedTeamId}
                />
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function teamNameOf(state: DirectorState, teamId: string): string {
  return state.teams.find((team) => team.id === teamId)?.displayName ?? 'Unknown';
}

function teamCellText(standing: TeamStanding, columnId: string): string {
  switch (columnId) {
    case 'record':
      return formatRecord(standing);
    case 'winpct':
      return formatWinPct(standing.winPercentage);
    case 'pf':
      return String(standing.pointsFor);
    case 'pa':
      return String(standing.pointsAgainst);
    case 'margin':
      return `${standing.margin > 0 ? '+' : ''}${standing.margin}`;
    case 'ppg':
      return formatAverage(standing.pointsFor, standing.gamesPlayed);
    case 'papg':
      return formatAverage(standing.pointsAgainst, standing.gamesPlayed);
    case 'ppb':
      return formatPpb(standing);
    case 'superpowers':
      return String(standing.superpowers);
    case 'powers':
      return String(standing.powers);
    case 'gets':
      return String(standing.gets);
    case 'negs':
      return String(standing.negs);
    default:
      return '';
  }
}

function TeamsPanel({
  state,
  controller,
  standings,
  acceptedCount,
  isOverall,
  visibleColumns,
  onVisibleColumns,
  onSelectTeam,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  standings: TeamStanding[];
  acceptedCount: number;
  isOverall: boolean;
  visibleColumns: string[];
  onVisibleColumns: (ids: string[]) => void;
  onSelectTeam: (teamId: string) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const placement = state.tournament?.finalPlacement;
  const columns = TEAM_COLUMNS.filter((column) => visibleColumns.includes(column.id));
  return (
    <>
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Team standings</p>
          <h2>
            {standings.length} team{standings.length === 1 ? '' : 's'}
            {isOverall && placement ? ' · final order set by director' : ''}
          </h2>
        </div>
        <span className="director-muted">{acceptedCount} accepted games</span>
      </div>
      <div className="director-table-wrap">
        <table className="director-table director-standings-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Team</th>
              {columns.map((column) => (
                <th key={column.id} scope="col">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {standings.map((standing, index) => {
              const classifications = teamClassificationsOf(state, standing.teamId);
              return (
                <tr key={standing.teamId}>
                  <td className="director-number-cell">{index + 1}</td>
                  <td>
                    <button
                      type="button"
                      className="director-link-button"
                      onClick={() => onSelectTeam(standing.teamId)}
                    >
                      <strong>{teamNameOf(state, standing.teamId)}</strong>
                    </button>
                    {classifications.length > 0 && (
                      <span className="director-muted">
                        {' '}
                        · {classifications.map((entry) => classificationLabels[entry]).join(', ')}
                      </span>
                    )}
                  </td>
                  {columns.map((column) => (
                    <td key={column.id} className="director-number-cell">
                      {teamCellText(standing, column.id)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="director-panel-body">
        <ColumnsConfig
          columns={TEAM_COLUMNS}
          visible={visibleColumns}
          onChange={onVisibleColumns}
          label="Team columns"
        />
        {isOverall && acceptedCount > 0 && (
          <FinalPlacementEditor
            state={state}
            controller={controller}
            standings={standings}
            onAnnounce={onAnnounce}
          />
        )}
      </div>
    </>
  );
}

function FinalPlacementEditor({
  state,
  controller,
  standings,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  standings: TeamStanding[];
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const placement = state.tournament?.finalPlacement;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [reason, setReason] = useState('');

  const beginEditing = () => {
    setDraft(placement ? [...placement.order] : standings.map((standing) => standing.teamId));
    setReason(placement?.reason ?? '');
    setEditing(true);
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= draft.length) return;
    const next = [...draft];
    const [moved] = next.splice(index, 1);
    if (moved !== undefined) next.splice(target, 0, moved);
    setDraft(next);
  };

  const save = () => {
    const result = controller.setFinalPlacement({ order: draft, reason });
    onAnnounce(result.applied ? infoNotice(result.message) : errorNotice(result.message));
    if (result.applied) setEditing(false);
  };

  const reset = () => {
    if (controller.clearFinalPlacement()) {
      onAnnounce(infoNotice('Final placement cleared. Calculated standings are final again.'));
      setEditing(false);
    }
  };

  if (!editing) {
    return (
      <div className="director-final-placement">
        <p className="director-muted">
          {placement
            ? `Final order set${placement.reason ? `: ${placement.reason}` : ''} Calculated results and records are unchanged.`
            : 'Ranks follow the calculated order. Set an explicit final order when the format needs one.'}
        </p>
        <div className="director-row-actions">
          <Button variant="secondary" onClick={beginEditing}>
            {placement ? 'Adjust final order' : 'Set final order'}
          </Button>
          {placement && (
            <Button variant="quiet" onClick={reset}>
              Reset to calculated
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="director-final-placement">
      <p>
        <strong>Final order.</strong> Reorder without rewriting results: scores and win–loss records stay
        exactly as played.
      </p>
      <ol className="director-final-placement-list">
        {draft.map((teamId, index) => (
          <li key={teamId}>
            <span className="director-number-cell">{index + 1}.</span> {teamNameOf(state, teamId)}
            <span className="director-row-actions">
              <Button variant="quiet" disabled={index === 0} onClick={() => move(index, -1)}>
                Move up
              </Button>
              <Button variant="quiet" disabled={index === draft.length - 1} onClick={() => move(index, 1)}>
                Move down
              </Button>
            </span>
          </li>
        ))}
      </ol>
      <label className="director-field">
        Reason (optional)
        <input
          type="text"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why does the final differ from calculated order?"
        />
      </label>
      <div className="director-row-actions">
        <Button variant="primary" onClick={save}>
          Save final order
        </Button>
        <Button variant="quiet" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function IndividualsPanel({
  state,
  standings,
  visibleColumns,
  onVisibleColumns,
  onSelectTeam,
  onSelectPlayer,
}: {
  state: DirectorState;
  standings: PlayerStanding[];
  visibleColumns: string[];
  onVisibleColumns: (ids: string[]) => void;
  onSelectTeam: (teamId: string) => void;
  onSelectPlayer: (playerId: string) => void;
}) {
  const columns = INDIVIDUAL_COLUMNS.filter((column) => visibleColumns.includes(column.id));
  const rules = state.tournament?.rules;
  return (
    <>
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Individual statistics</p>
          <h2>
            {standings.length} player{standings.length === 1 ? '' : 's'}
          </h2>
        </div>
        <span className="director-muted">Accepted games only</span>
      </div>
      {standings.length === 0 ? (
        <div className="director-panel-body director-panel-empty-body" role="status">
          <p className="director-empty-copy">
            Player statistics will appear when accepted results include rosters.
          </p>
        </div>
      ) : (
        <div className="director-table-wrap">
          <table className="director-table director-player-table">
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col">Team</th>
                <th scope="col">Games</th>
                {columns.map((column) => (
                  <th key={column.id} scope="col">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {standings.map((standing) => {
                const player = state.players.find((entry) => entry.id === standing.playerId);
                const points = playerPoints(standing, rules);
                return (
                  <tr key={standing.playerId}>
                    <td>
                      <button
                        type="button"
                        className="director-link-button"
                        onClick={() => onSelectPlayer(standing.playerId)}
                      >
                        <strong>{player?.name ?? 'Unknown'}</strong>
                      </button>
                      {typeof player?.schoolYear === 'number' && (
                        <span className="director-muted"> · Grade {player.schoolYear}</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="director-link-button"
                        onClick={() => onSelectTeam(standing.teamId)}
                      >
                        {teamNameOf(state, standing.teamId)}
                      </button>
                    </td>
                    <td className="director-number-cell">{standing.gamesPlayed}</td>
                    {columns.map((column) => (
                      <td key={column.id} className="director-number-cell">
                        {individualCellText(standing, column.id, points)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="director-panel-body">
        <ColumnsConfig
          columns={INDIVIDUAL_COLUMNS}
          visible={visibleColumns}
          onChange={onVisibleColumns}
          label="Individual columns"
        />
      </div>
    </>
  );
}

function individualCellText(standing: PlayerStanding, columnId: string, points: number): string {
  switch (columnId) {
    case 'tuh':
      return formatTuh(standing);
    case 'superpowers':
      return String(standing.superpowers);
    case 'powers':
      return String(standing.powers);
    case 'gets':
      return String(standing.gets);
    case 'negs':
      return String(standing.negs);
    case 'points':
      return String(points);
    case 'ppg':
      return standing.gamesPlayed > 0 ? (points / standing.gamesPlayed).toFixed(1) : '0.0';
    case 'pptuh':
      return formatPptuh(points, standing);
    case 'bonus':
      return String(standing.bonusPoints);
    default:
      return '';
  }
}

function roundNameOf(state: DirectorState, roundId: string): string {
  return state.rounds.find((round) => round.id === roundId)?.name ?? 'Round';
}

function gameSummary(
  state: DirectorState,
  game: GameRecord,
): {
  leftName: string;
  rightName: string;
  leftScore: number;
  rightScore: number;
} {
  const [left, right] = game.scores;
  return {
    leftName: teamNameOf(state, left?.teamId ?? ''),
    rightName: teamNameOf(state, right?.teamId ?? ''),
    leftScore: left?.score ?? 0,
    rightScore: right?.score ?? 0,
  };
}

function GamesPanel({
  state,
  games,
  onSelectTeam,
}: {
  state: DirectorState;
  games: GameRecord[];
  onSelectTeam: (teamId: string) => void;
}) {
  const roundOrder = useMemo(() => {
    const order = new Map<string, number>();
    orderDayItems(state.rounds, state.timeline).forEach((entry, index) => {
      if (entry.kind === 'round' && entry.round) order.set(entry.round.id, index);
    });
    return order;
  }, [state.rounds, state.timeline]);
  const sorted = useMemo(
    () =>
      [...games].sort(
        (left, right) =>
          (roundOrder.get(left.roundId) ?? Number.MAX_SAFE_INTEGER) -
            (roundOrder.get(right.roundId) ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id),
      ),
    [games, roundOrder],
  );
  return (
    <>
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Games</p>
          <h2>
            {sorted.length} accepted game{sorted.length === 1 ? '' : 's'}
          </h2>
        </div>
        <span className="director-muted">Corrections live in Results</span>
      </div>
      {sorted.length === 0 ? (
        <div className="director-panel-body director-panel-empty-body" role="status">
          <p className="director-empty-copy">Accepted games will appear here with final scores.</p>
        </div>
      ) : (
        <div className="director-table-wrap">
          <table className="director-table">
            <thead>
              <tr>
                <th scope="col">Round</th>
                <th scope="col">Matchup</th>
                <th scope="col">Score</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((game) => {
                const summary = gameSummary(state, game);
                const [left, right] = game.scores;
                return (
                  <tr key={game.id}>
                    <td>{roundNameOf(state, game.roundId)}</td>
                    <td>
                      <button
                        type="button"
                        className="director-link-button"
                        onClick={() => left && onSelectTeam(left.teamId)}
                      >
                        {summary.leftName}
                      </button>{' '}
                      vs{' '}
                      <button
                        type="button"
                        className="director-link-button"
                        onClick={() => right && onSelectTeam(right.teamId)}
                      >
                        {summary.rightName}
                      </button>
                    </td>
                    <td className="director-number-cell">
                      {summary.leftScore}–{summary.rightScore}
                    </td>
                    <td>
                      {game.detailedStats === 'incomplete' || game.detailedStats === 'unknown' ? (
                        <span className="director-muted">Partial stats</span>
                      ) : (
                        <span className="director-muted">Complete</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function RoundsPanel({
  state,
  games,
  scopePhaseId,
  onSelectTeam,
}: {
  state: DirectorState;
  games: GameRecord[];
  scopePhaseId?: string;
  onSelectTeam: (teamId: string) => void;
}) {
  const rounds = useMemo(
    () =>
      orderDayItems(state.rounds, state.timeline)
        .flatMap((entry) => (entry.kind === 'round' && entry.round ? [entry.round] : []))
        .filter((round) => scopePhaseId === undefined || round.phaseId === scopePhaseId),
    [state.rounds, state.timeline, scopePhaseId],
  );
  const acceptedByScheduled = useMemo(() => new Set(games.map((game) => game.scheduledGameId)), [games]);
  return (
    <>
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Round by round</p>
          <h2>
            {rounds.length} round{rounds.length === 1 ? '' : 's'}
          </h2>
        </div>
        <span className="director-muted">Tournament-day order</span>
      </div>
      <div className="director-panel-body">
        {rounds.map((round) => {
          const roundGames = games.filter((game) => game.roundId === round.id);
          const pending = state.scheduledGames.filter(
            (scheduled) =>
              scheduled.roundId === round.id &&
              !scheduled.bye &&
              scheduled.status !== 'cancelled' &&
              !acceptedByScheduled.has(scheduled.id),
          ).length;
          return (
            <section key={round.id} aria-label={round.name} className="director-round-stats">
              <h3>
                {round.name}
                <span className="director-muted">
                  {' '}
                  · {roundGames.length} accepted{pending > 0 ? ` · ${pending} awaiting result` : ''}
                </span>
              </h3>
              {roundGames.length === 0 ? (
                <p className="director-muted">No accepted games yet.</p>
              ) : (
                <ul className="director-plain-list">
                  {roundGames.map((game) => {
                    const summary = gameSummary(state, game);
                    const [left, right] = game.scores;
                    return (
                      <li key={game.id}>
                        <button
                          type="button"
                          className="director-link-button"
                          onClick={() => left && onSelectTeam(left.teamId)}
                        >
                          {summary.leftName}
                        </button>{' '}
                        {summary.leftScore}–{summary.rightScore}{' '}
                        <button
                          type="button"
                          className="director-link-button"
                          onClick={() => right && onSelectTeam(right.teamId)}
                        >
                          {summary.rightName}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

function TeamDetail({
  state,
  teamId,
  scopeOptions,
  isOverall,
  onBack,
  onSelectPlayer,
  onSelectTeam,
}: {
  state: DirectorState;
  teamId: string;
  scopeOptions: { phaseId?: string; poolId?: string };
  isOverall: boolean;
  onBack: () => void;
  onSelectPlayer: (playerId: string) => void;
  onSelectTeam: (teamId: string) => void;
}) {
  const team = state.teams.find((entry) => entry.id === teamId);
  const ordered = useMemo(() => {
    const calculated = deriveTeamStandings(state, undefined, scopeOptions);
    return isOverall ? applyFinalPlacement(calculated, state.tournament?.finalPlacement) : calculated;
  }, [state, scopeOptions, isOverall]);
  const rank = ordered.findIndex((standing) => standing.teamId === teamId);
  const standing = rank >= 0 ? ordered[rank] : undefined;
  const roster = useMemo(
    () => derivePlayerStandings(state, scopeOptions).filter((entry) => entry.teamId === teamId),
    [state, scopeOptions, teamId],
  );
  const log = useMemo(
    () =>
      acceptedGameRecords(state, scopeOptions).filter((game) =>
        game.scores.some((score) => score.teamId === teamId),
      ),
    [state, scopeOptions, teamId],
  );
  if (!team) return null;
  const classifications = teamClassificationsOf(state, teamId);
  const rules = state.tournament?.rules;
  return (
    <>
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Team detail</p>
          <h2>
            {team.displayName}
            {rank >= 0 ? ` · #${rank + 1}` : ''}
          </h2>
        </div>
        <Button variant="quiet" onClick={onBack}>
          Back to stats
        </Button>
      </div>
      <div className="director-panel-body">
        {standing && (
          <p>
            {formatRecord(standing)} · {formatAverage(standing.pointsFor, standing.gamesPlayed)} PPG ·{' '}
            {formatPpb(standing)} PPB · {standing.powers} powers, {standing.gets} gets, {standing.negs} negs
          </p>
        )}
        {classifications.length > 0 && (
          <p className="director-muted">
            Group: {classifications.map((entry) => classificationLabels[entry]).join(', ')}
            {(team.tags ?? []).length > 0 ? ` · ${(team.tags ?? []).join(', ')}` : ''}
          </p>
        )}
        <h3>Roster</h3>
        {roster.length === 0 ? (
          <p className="director-muted">No player statistics in this scope.</p>
        ) : (
          <ul className="director-plain-list">
            {roster.map((entry) => {
              const player = state.players.find((candidate) => candidate.id === entry.playerId);
              return (
                <li key={entry.playerId}>
                  <button
                    type="button"
                    className="director-link-button"
                    onClick={() => onSelectPlayer(entry.playerId)}
                  >
                    <strong>{player?.name ?? 'Unknown'}</strong>
                  </button>{' '}
                  · {entry.gamesPlayed} games · {playerPoints(entry, rules)} pts ·{' '}
                  {entry.gamesPlayed > 0
                    ? (playerPoints(entry, rules) / entry.gamesPlayed).toFixed(1)
                    : '0.0'}{' '}
                  PPG
                </li>
              );
            })}
          </ul>
        )}
        <h3>Games</h3>
        {log.length === 0 ? (
          <p className="director-muted">No accepted games in this scope.</p>
        ) : (
          <ul className="director-plain-list">
            {log.map((game) => {
              const own = game.scores.find((score) => score.teamId === teamId);
              const opponent = game.scores.find((score) => score.teamId !== teamId);
              const result =
                own && opponent
                  ? own.score > opponent.score
                    ? 'W'
                    : own.score < opponent.score
                      ? 'L'
                      : 'T'
                  : '';
              return (
                <li key={game.id}>
                  {roundNameOf(state, game.roundId)} · {result} {own?.score ?? 0}–{opponent?.score ?? 0} vs{' '}
                  {opponent ? (
                    <button
                      type="button"
                      className="director-link-button"
                      onClick={() => onSelectTeam(opponent.teamId)}
                    >
                      {teamNameOf(state, opponent.teamId)}
                    </button>
                  ) : (
                    'bye'
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

function PlayerDetail({
  state,
  playerId,
  scopeOptions,
  onBack,
  onSelectTeam,
}: {
  state: DirectorState;
  playerId: string;
  scopeOptions: { phaseId?: string; poolId?: string };
  onBack: () => void;
  onSelectTeam: (teamId: string) => void;
}) {
  const player = state.players.find((entry) => entry.id === playerId);
  const standing = useMemo(
    () => derivePlayerStandings(state, scopeOptions).find((entry) => entry.playerId === playerId),
    [state, scopeOptions, playerId],
  );
  const log = useMemo(
    () =>
      acceptedGameRecords(state, scopeOptions)
        .map((game) => ({
          game,
          stat: game.playerStats.find((entry) => entry.playerId === playerId),
        }))
        .filter(
          (entry): entry is { game: GameRecord; stat: NonNullable<GameRecord['playerStats'][number]> } =>
            entry.stat !== undefined,
        ),
    [state, scopeOptions, playerId],
  );
  if (!player) return null;
  const rules = state.tournament?.rules;
  const points = standing ? playerPoints(standing, rules) : 0;
  return (
    <>
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Player detail</p>
          <h2>{player.name}</h2>
        </div>
        <Button variant="quiet" onClick={onBack}>
          Back to stats
        </Button>
      </div>
      <div className="director-panel-body">
        <p>
          <button type="button" className="director-link-button" onClick={() => onSelectTeam(player.teamId)}>
            {teamNameOf(state, player.teamId)}
          </button>
          {typeof player.schoolYear === 'number' ? ` · Grade ${player.schoolYear}` : ''}
        </p>
        {standing && (
          <p>
            {standing.gamesPlayed} games · {formatTuh(standing)} TUH · {standing.powers} powers,{' '}
            {standing.gets} gets, {standing.negs} negs · {points} pts ·{' '}
            {standing.gamesPlayed > 0 ? (points / standing.gamesPlayed).toFixed(1) : '0.0'} PPG ·{' '}
            {formatPptuh(points, standing)} PPTUH
          </p>
        )}
        <h3>Games</h3>
        {log.length === 0 ? (
          <p className="director-muted">No accepted games in this scope.</p>
        ) : (
          <ul className="director-plain-list">
            {log.map(({ game, stat }) => {
              const opponent = game.scores.find((score) => score.teamId !== player.teamId);
              return (
                <li key={game.id}>
                  {roundNameOf(state, game.roundId)} vs{' '}
                  {opponent ? (
                    <button
                      type="button"
                      className="director-link-button"
                      onClick={() => onSelectTeam(opponent.teamId)}
                    >
                      {teamNameOf(state, opponent.teamId)}
                    </button>
                  ) : (
                    teamNameOf(state, player.teamId)
                  )}{' '}
                  · {stat.powers}/{stat.gets}/{stat.negs} · {playerPoints(stat, rules)} pts
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

function ColumnsConfig({
  columns,
  visible,
  onChange,
  label,
}: {
  columns: { id: string; label: string }[];
  visible: string[];
  onChange: (ids: string[]) => void;
  label: string;
}) {
  const toggle = (id: string) => {
    if (visible.includes(id)) {
      const next = visible.filter((entry) => entry !== id);
      if (next.length > 0) onChange(next);
    } else {
      onChange([...visible, id]);
    }
  };
  return (
    <details className="director-columns-config">
      <summary>{label}</summary>
      <div className="director-columns-options">
        {columns.map((column) => (
          <label key={column.id}>
            <input type="checkbox" checked={visible.includes(column.id)} onChange={() => toggle(column.id)} />{' '}
            {column.label}
          </label>
        ))}
      </div>
    </details>
  );
}

function downloadStandingsCsv(state: DirectorState, onAnnounce: (announcement: AnnounceInput) => void): void {
  saveOrDownloadText(
    exportTeamStandingsCsv(buildCanonicalSnapshot(state)),
    `${safeReportName(state.tournament?.name ?? 'tournament')}-standings.csv`,
    'text/csv;charset=utf-8',
    onAnnounce,
    'Standings CSV exported',
  );
}

function downloadStatReport(
  state: DirectorState,
  onAnnounce: (announcement: AnnounceInput) => void,
): Promise<void> {
  return saveOrDownloadBytes(
    zipStatReportBundle(buildStatReportBundle(buildCanonicalSnapshot(state))),
    `${safeReportName(state.tournament?.name ?? 'tournament')}-stat-report.zip`,
    'application/zip',
    onAnnounce,
    'Stat report exported',
    'Stat report save cancelled',
  );
}
