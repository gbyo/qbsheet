/**
 * YF Shuttle: one window, one screen, no navigation.
 *
 * A compact tournament header, the project folder section, a dense round list, and the
 * playoff section — in that order, always. Advanced identity (Match ids, fingerprints, the
 * manifest) lives behind a Details disclosure. Wording never claims YellowFruit imported
 * anything: batches are "ready", results are "returned", everything else is "waiting".
 */

import { useState } from 'react';
import { Button, ConfirmDialog, Notice, StatusBadge, TextField } from '@qbsheet/ui';
import { ROOM_SLOTS } from '../lib/schedule';
import { assignSlotLabels } from '../lib/playoffs';
import { IMPORT_ROOT_NAME, importFolderName, joinPath, validateRoomNames } from '../lib/project';
import { describePrelimGate, useShuttle, type Shuttle } from '../lib/useShuttle';

const noticeTone = { good: 'success', warn: 'warning', bad: 'danger' } as const;

export default function ShuttleApp() {
  const shuttle = useShuttle();
  return (
    <div className="shell">
      <header className="titlebar">
        <h1>YF Shuttle</h1>
        <span className="subtle">
          {shuttle.tournament
            ? `${shuttle.tournament.name} · 12 teams · 8 rounds`
            : 'No YellowFruit file loaded'}
        </span>
        <span className="titlebar-actions">
          {shuttle.tournament ? (
            <Button
              size="sm"
              variant="quiet"
              onPress={shuttle.changeYellowFruitFile}
              isDisabled={shuttle.busy}
            >
              Change YellowFruit file
            </Button>
          ) : null}
        </span>
      </header>

      <main>
        <div className="page-notices">
          {!shuttle.native ? (
            <Notice tone="neutral">
              File and folder access needs the YF Shuttle desktop application. This browser view can stay open
              for reference, but every button below runs on the desktop.
            </Notice>
          ) : null}
          {shuttle.notice ? (
            <Notice
              tone={noticeTone[shuttle.notice.kind]}
              live={shuttle.notice.kind === 'bad' ? 'assertive' : 'polite'}
            >
              <span>{shuttle.notice.message}</span>
            </Notice>
          ) : null}
          {shuttle.loadError ? <Notice tone="danger">{shuttle.loadError}</Notice> : null}
        </div>

        {!shuttle.tournament ? (
          <FileSection shuttle={shuttle} />
        ) : (
          <>
            <ProjectSection shuttle={shuttle} />
            {shuttle.manifest ? (
              <>
                <RoundsSection shuttle={shuttle} />
                <PlayoffSection shuttle={shuttle} />
                <DetailsSection shuttle={shuttle} />
              </>
            ) : (
              <SetupSection shuttle={shuttle} />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function FileSection({ shuttle }: { shuttle: Shuttle }) {
  const pending = shuttle.pendingRecovery;
  return (
    <section className="panel">
      <h2>YellowFruit file</h2>
      {pending ? (
        <>
          <Notice tone="warning">
            A project for “{pending.manifest.tournamentName || pending.manifest.tournamentId}” (
            {pending.manifest.assignments.length} games) is waiting at{' '}
            <span className="mono">{pending.path}</span>. Open that event&apos;s current YellowFruit file to
            verify it before anything activates.
          </Notice>
          <div className="row">
            <Button
              variant="primary"
              onPress={() => void shuttle.openYellowFruit()}
              isDisabled={shuttle.busy}
            >
              Open matching YellowFruit file
            </Button>
            <Button variant="quiet" onPress={shuttle.cancelRecovery} isDisabled={shuttle.busy}>
              Forget that project
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            Open the tournament <span className="mono">.yft</span>. It is only ever read — YF Shuttle never
            writes to it.
          </p>
          <div className="row">
            <Button
              variant="primary"
              onPress={() => void shuttle.openYellowFruit()}
              isDisabled={shuttle.busy}
            >
              Open YellowFruit file
            </Button>
            <Button
              variant="quiet"
              onPress={() => void shuttle.openExistingProject()}
              isDisabled={shuttle.busy}
            >
              Open existing YF Shuttle project…
            </Button>
          </div>
          <p className="muted">
            Coming back mid-tournament — a restart, a wiped browser, a moved folder? Open the existing project
            folder instead: its <span className="mono">.yf-shuttle.json</span> restores the rooms,
            assignments, and choices, then asks for the matching YellowFruit file.
          </p>
        </>
      )}
    </section>
  );
}

function poolNameOf(shuttle: Shuttle, poolId: string | undefined): string | undefined {
  if (!poolId || !shuttle.tournament) return undefined;
  return shuttle.tournament.pools.find((pool) => pool.id === poolId)?.name;
}

function SetupSection({ shuttle }: { shuttle: Shuttle }) {
  const [rooms, setRooms] = useState<Record<string, string>>(() =>
    Object.fromEntries(ROOM_SLOTS.map((slot) => [slot.id, slot.defaultName])),
  );
  const [folder, setFolder] = useState(shuttle.tournament?.name ?? '');
  const [confirming, setConfirming] = useState(false);

  if (!shuttle.tournament || !shuttle.compat) {
    return (
      <section className="panel">
        <h2>Wildcat format</h2>
        {shuttle.compatErrors.map((error) => (
          <p key={error}>{error}</p>
        ))}
        <p className="muted">
          Fix the file in YellowFruit, save it, and open it again. Nothing has been created.
        </p>
      </section>
    );
  }

  const gold = ROOM_SLOTS.filter((slot) => slot.side === 'gold');
  const maroon = ROOM_SLOTS.filter((slot) => slot.side === 'maroon');
  const poolA = poolNameOf(shuttle, shuttle.compat.poolAId) ?? 'Prelim A';
  const poolB = poolNameOf(shuttle, shuttle.compat.poolBId) ?? 'Prelim B';
  const source = shuttle.scheduleSource;
  const fileRooms =
    source?.kind === 'yft'
      ? [...new Set(source.games.map((game) => game.location ?? 'Unnamed room'))].sort()
      : null;
  const preview =
    source?.kind === 'preset'
      ? validateRoomNames(
          rooms,
          ROOM_SLOTS.map((slot) => slot.id),
        )
      : null;
  const renamed = preview?.ok
    ? preview.value.rooms.filter((room) => room.displayName !== room.folderName)
    : [];

  if (source?.kind === 'mixed') {
    return (
      <section className="panel">
        <h2>Project setup</h2>
        <Notice tone="danger">{source.detail}</Notice>
        <p className="muted">
          Nothing has been created. Fix the schedule in YellowFruit, save it, and open it again.
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Project setup</h2>
      <p>
        Wildcat 12-team format confirmed: two prelim pools of six, rounds 1–8.{' '}
        <span className="muted">
          {poolA} plays in the gold rooms, {poolB} in the maroon rooms.
        </span>
      </p>
      <p className="muted">
        Schedule source:{' '}
        {source?.kind === 'yft' ? (
          <strong>YellowFruit games</strong>
        ) : (
          <span>
            Wildcat tournament preset <span className="muted">(the file holds no scheduled games)</span>
          </span>
        )}
      </p>
      {fileRooms ? (
        <p className="muted">
          The file already schedules all 30 prelim games in these rooms — their folders are created as named,
          and their Match ids are kept: <span className="mono">{fileRooms.join(' · ')}</span>
        </p>
      ) : (
        <>
          <p className="side-label">Gold — {poolA}</p>
          <div className="field-grid">
            {gold.map((slot) => (
              <TextField
                key={slot.id}
                label={`Gold room ${slot.defaultName}`}
                value={rooms[slot.id] ?? ''}
                onChange={(value) => setRooms((previous) => ({ ...previous, [slot.id]: value }))}
              />
            ))}
          </div>
          <p className="side-label">Maroon — {poolB}</p>
          <div className="field-grid">
            {maroon.map((slot) => (
              <TextField
                key={slot.id}
                label={`Maroon room ${slot.defaultName}`}
                value={rooms[slot.id] ?? ''}
                onChange={(value) => setRooms((previous) => ({ ...previous, [slot.id]: value }))}
              />
            ))}
          </div>
        </>
      )}
      <div className="field-grid two">
        <TextField
          label="Tournament folder name"
          value={folder}
          onChange={setFolder}
          description="Created inside the folder you choose next."
        />
      </div>
      {renamed.length > 0 ? (
        <p className="warning-line">
          Folders on disk will read:{' '}
          {renamed.map((room) => `“${room.displayName}” → “${room.folderName}”`).join('; ')}.
        </p>
      ) : null}
      <div className="row">
        <Button variant="primary" onPress={() => setConfirming(true)} isDisabled={shuttle.busy}>
          Create folders &amp; prelim games
        </Button>
      </div>
      <ConfirmDialog
        isOpen={confirming}
        title="Create the project?"
        confirmLabel="Choose folder & create"
        onConfirm={() => {
          setConfirming(false);
          void shuttle.createProject(rooms, folder || shuttle.tournament!.name);
        }}
        onCancel={() => setConfirming(false)}
      >
        This creates six room folders with IN and OUT, eight YellowFruit import folders, and writes the 30
        prelim assignments. Nothing is uploaded anywhere.
      </ConfirmDialog>
    </section>
  );
}

function ProjectSection({ shuttle }: { shuttle: Shuttle }) {
  if (!shuttle.manifest || !shuttle.projectPath) return null;
  const rooms = shuttle.manifest.rooms;
  return (
    <section className="panel">
      <h2>Project folder</h2>
      <div className="row">
        <code className="mono">{shuttle.projectPath}</code>
      </div>
      <div className="row" style={{ marginTop: 'var(--qbs-space-2)' }}>
        <Button size="sm" onPress={() => void shuttle.openPath(shuttle.projectPath!)}>
          Open Folder
        </Button>
        <Button
          size="sm"
          variant="quiet"
          onPress={() => void shuttle.rescanOutFolders()}
          isDisabled={shuttle.busy}
        >
          Rescan OUT folders
        </Button>
        <span className="muted">
          {rooms.map((room) => room.displayName).join(' · ')} · {shuttle.manifest.assignments.length} games
          generated
        </span>
      </div>
    </section>
  );
}

function teamNameOf(shuttle: Shuttle, teamId: string): string {
  return shuttle.tournament?.teams.find((team) => team.id === teamId)?.name ?? 'Unknown team';
}

function RoundsSection({ shuttle }: { shuttle: Shuttle }) {
  const manifest = shuttle.manifest!;
  const rounds = [...new Set(manifest.assignments.map((entry) => entry.roundNumber))].sort((a, b) => a - b);
  return (
    <section className="panel">
      <h2>{rounds.some((round) => round >= 6) ? 'Tournament progress' : 'Prelims'}</h2>
      {rounds.length === 0 ? <p className="muted">No games generated yet.</p> : null}
      <ul className="round-list">
        {rounds.map((round) => (
          <RoundRow key={round} shuttle={shuttle} roundNumber={round} />
        ))}
      </ul>
      {shuttle.report?.problems.map((problem) => (
        <p key={`${problem.folderName}/${problem.fileName}`} className="warning-line">
          {problem.fileName}: {problem.problem.message}
        </p>
      ))}
    </section>
  );
}

function RoundRow({ shuttle, roundNumber }: { shuttle: Shuttle; roundNumber: number }) {
  const manifest = shuttle.manifest!;
  const [confirmingPartial, setConfirmingPartial] = useState(false);
  const games = manifest.assignments
    .filter((entry) => entry.roundNumber === roundNumber)
    .sort((a, b) => a.slotId.localeCompare(b.slotId));
  const roomOf = (slotId: string) =>
    manifest.rooms.find((entry) => entry.slotId === slotId)?.displayName ?? slotId;
  const returned = games.filter((game) => shuttle.scanByMatchId.get(game.matchId)?.chosen);
  const needsChoice = games.filter((game) => shuttle.scanByMatchId.get(game.matchId)?.needsChoice);
  const waiting = games.filter((game) => !shuttle.scanByMatchId.get(game.matchId)?.chosen);
  const complete = returned.length === games.length && games.length > 0;
  const prepared = manifest.preparedRounds.includes(roundNumber);
  const expanded = shuttle.expandedRound === roundNumber;
  // File-scheduled games never take the import-batch path (YellowFruit would append a
  // duplicate). They fill a new `.yft` copy instead.
  const fileSourced = games.some((game) => game.source === 'yft');

  return (
    <li>
      <div className="round-summary" role="group" aria-label={`Round ${roundNumber}`}>
        <button
          type="button"
          className="round-summary"
          style={{ width: 'auto', flex: 1 }}
          onClick={() => shuttle.setExpandedRound(expanded ? null : roundNumber)}
          aria-expanded={expanded}
        >
          <span className="round-name">Round {roundNumber}</span>
          <span className="round-progress">
            {returned.length} / {games.length} returned
          </span>
          {waiting.length > 0 && !complete ? (
            <span className="muted">
              Waiting for {waiting.map((game) => `Room ${roomOf(game.slotId)}`).join(', ')}
            </span>
          ) : null}
          {prepared && !fileSourced ? (
            <StatusBadge tone="success">Ready for YellowFruit</StatusBadge>
          ) : needsChoice.length > 0 ? (
            <StatusBadge tone="warning">{needsChoice.length} need a choice</StatusBadge>
          ) : complete ? (
            <StatusBadge tone="success">Complete</StatusBadge>
          ) : null}
        </button>
        <span className="round-actions">
          {fileSourced ? (
            returned.length > 0 ? (
              <Button
                size="sm"
                onPress={() => void shuttle.createUpdatedCopy(roundNumber)}
                isDisabled={shuttle.busy || needsChoice.length > 0}
                aria-label={
                  needsChoice.length > 0
                    ? 'Choose between the duplicate results below first'
                    : `Fill Round ${roundNumber} results into a new YellowFruit copy`
                }
              >
                Create updated YellowFruit copy
              </Button>
            ) : null
          ) : complete ? (
            <Button
              size="sm"
              onPress={() => void shuttle.prepareRound(roundNumber)}
              isDisabled={shuttle.busy}
              aria-label={`Prepare Round ${roundNumber} for YellowFruit`}
            >
              Prepare for YellowFruit
            </Button>
          ) : returned.length > 0 ? (
            <>
              <Button
                size="sm"
                variant="quiet"
                onPress={() => setConfirmingPartial(true)}
                isDisabled={shuttle.busy || needsChoice.length > 0}
                aria-label={
                  needsChoice.length > 0
                    ? 'Choose between the duplicate results below first'
                    : `Prepare Round ${roundNumber} without all results`
                }
              >
                Prepare incomplete batch…
              </Button>
              <ConfirmDialog
                isOpen={confirmingPartial}
                title={`Prepare Round ${roundNumber} without all results?`}
                confirmLabel="Prepare incomplete batch"
                onConfirm={() => {
                  setConfirmingPartial(false);
                  void shuttle.prepareRound(roundNumber);
                }}
                onCancel={() => setConfirmingPartial(false)}
              >
                {waiting.length} game{waiting.length === 1 ? ' is' : 's are'} still missing:{' '}
                {waiting.map((game) => `Room ${roomOf(game.slotId)}`).join(', ')}. Only the {returned.length}{' '}
                returned result{returned.length === 1 ? '' : 's'} will be batched — the rest can be prepared
                later.
              </ConfirmDialog>
            </>
          ) : null}
          {prepared && !fileSourced ? (
            <Button
              size="sm"
              variant="quiet"
              onPress={() =>
                void shuttle.openPath(
                  joinPath(shuttle.projectPath!, IMPORT_ROOT_NAME, importFolderName(roundNumber)),
                )
              }
            >
              Open YellowFruit Import folder
            </Button>
          ) : null}
        </span>
      </div>
      {prepared && !fileSourced ? (
        <p className="muted">
          Batch prepared. In YellowFruit, open Games → Import and select the Round {roundNumber} files.
          Re-preparing overwrites these copies — it never duplicates them.
        </p>
      ) : null}
      {fileSourced ? (
        <p className="muted">
          These games were scheduled by the YellowFruit file itself, so results fill a new{' '}
          <span className="mono">.yft</span> copy — importing them would duplicate the games already in the
          file.
        </p>
      ) : null}
      {expanded ? (
        <table className="game-table">
          <thead>
            <tr>
              <th scope="col">Room</th>
              <th scope="col">Game</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {games.map((game) => {
              const scan = shuttle.scanByMatchId.get(game.matchId);
              const room = roomOf(game.slotId);
              const matchup = `${teamNameOf(shuttle, game.leftTeamId)} vs ${teamNameOf(shuttle, game.rightTeamId)}`;
              const partial = scan && !scan.chosen && scan.partialCopies.length > 0;
              return (
                <tr key={game.matchId}>
                  <td>{room}</td>
                  <td>
                    {matchup}
                    {scan?.wrongFolder ? (
                      <div className="warning-line">
                        Round {scan.wrongFolder.roundNumber} / Room {scan.wrongFolder.expectedRoom} was found
                        in Room {scan.wrongFolder.foundIn}’s OUT folder.
                      </div>
                    ) : null}
                    {scan && scan.needsChoice ? (
                      <DuplicateChooser
                        shuttle={shuttle}
                        matchId={game.matchId}
                        room={room}
                        roundNumber={game.roundNumber}
                        candidates={scan.candidates}
                        selectedFileName={scan.selectedFileName}
                      />
                    ) : null}
                    {scan && !scan.chosen && scan.untouchedCopies.length > 0 ? (
                      <div className="warning-line">
                        An unscored copy is sitting in OUT — not counted as a result.
                      </div>
                    ) : null}
                  </td>
                  <td className={scan?.chosen ? 'state-returned' : 'state-waiting'}>
                    {scan?.chosen
                      ? `Returned — ${scan.chosen.scoreLine}`
                      : partial
                        ? 'Partial copy found — not ready'
                        : 'Waiting for result'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </li>
  );
}

function DuplicateChooser({
  shuttle,
  matchId,
  room,
  roundNumber,
  candidates,
  selectedFileName,
}: {
  shuttle: Shuttle;
  matchId: string;
  room: string;
  roundNumber: number;
  candidates: {
    candidateId: string;
    fileName: string;
    folderName: string;
    scoreLine: string;
    modifiedMs?: number;
  }[];
  selectedFileName?: string;
}) {
  return (
    <div className="duplicate-box">
      <fieldset>
        <legend>{candidates.length} results found — choose which one goes to YellowFruit</legend>
        {candidates.map((candidate) => (
          <label key={candidate.candidateId}>
            <input
              type="radio"
              name={`choice-${matchId}`}
              checked={candidate.fileName === selectedFileName}
              onChange={() => void shuttle.chooseResult(matchId, candidate.candidateId)}
            />{' '}
            <span className="mono">{candidate.fileName}</span> · {candidate.scoreLine} · in{' '}
            {candidate.folderName}’s OUT
            {candidate.modifiedMs !== undefined
              ? ` · ${new Date(candidate.modifiedMs).toLocaleString()}`
              : ''}
          </label>
        ))}
      </fieldset>
      <p className="warning-line">
        Round {roundNumber} / Room {room} has {candidates.length} completed results. Both originals stay
        untouched; only the chosen one is batched.
      </p>
    </div>
  );
}

function PlayoffSection({ shuttle }: { shuttle: Shuttle }) {
  const manifest = shuttle.manifest!;
  const hasPlayoffGames = manifest.assignments.some((entry) => entry.roundNumber >= 6);

  if (!shuttle.playoffs && !manifest.playoffSlots) {
    return (
      <section className="panel">
        <h2>Playoffs</h2>
        <p className="muted">
          Waiting for preliminary standings. Import Rounds 1–5 into YellowFruit, confirm advancement, save the
          file, then load it here.
        </p>
        <div className="row">
          <Button onPress={() => void shuttle.loadUpdatedYellowFruit()} isDisabled={shuttle.busy}>
            Load updated YellowFruit file
          </Button>
        </div>
      </section>
    );
  }

  if (manifest.playoffSlots && !shuttle.playoffs) {
    return (
      <section className="panel">
        <h2>Playoffs</h2>
        <SlotTables shuttle={shuttle} slots={manifest.playoffSlots} />
        {hasPlayoffGames ? (
          <p className="muted">
            Playoff games are in the room IN folders. Rescan OUT folders as results come back.
          </p>
        ) : (
          <div className="row">
            <Button
              variant="primary"
              onPress={() => void shuttle.generatePlayoffs()}
              isDisabled={shuttle.busy}
            >
              Generate playoff games
            </Button>
          </div>
        )}
      </section>
    );
  }

  const playoffs = shuttle.playoffs!;
  const resolvedA = assignSlotLabels(playoffs.orders.A, 'F', playoffs.manual.A);
  const resolvedB = assignSlotLabels(playoffs.orders.B, 'B', playoffs.manual.B);
  const tied = playoffs.orders.A.tiedGroups.length + playoffs.orders.B.tiedGroups.length > 0;
  const verbatim = playoffs.verbatimGames.length > 0;
  const teamName = (id: string) => shuttle.tournament?.teams.find((team) => team.id === id)?.name ?? id;
  const roomName = (slotId: string) =>
    manifest.rooms.find((room) => room.slotId === slotId)?.displayName ?? slotId;
  const gateLine = describePrelimGate(playoffs.gate, teamName, roomName);

  return (
    <section className="panel">
      <h2>Playoffs</h2>
      <ol className="muted">
        <li>Import Rounds 1–5 into YellowFruit.</li>
        <li>Confirm advancement in YellowFruit.</li>
        <li>Save the YellowFruit file.</li>
        <li>Load the updated file here.</li>
      </ol>
      {verbatim ? (
        <p>
          <StatusBadge tone="success">18 playoff games found in YellowFruit</StatusBadge>
        </p>
      ) : (
        <p className="muted">
          {gateLine} These slots only label the printed schedule — standings stay YellowFruit’s.
        </p>
      )}
      {!playoffs.gateReady ? (
        <Notice tone="danger">
          The playoffs stay locked. {gateLine} Import every prelim result into YellowFruit, save it, and
          reload the file here.
        </Notice>
      ) : null}
      {verbatim ? (
        <p className="muted">
          The file already holds every R6–R8 game, so there is nothing to rank: generating packages
          YellowFruit’s own matchups verbatim into the room IN folders.
        </p>
      ) : (
        <div className="slot-columns">
          <PoolSlots
            shuttle={shuttle}
            poolKey="A"
            letter="F"
            order={playoffs.orders.A}
            resolved={resolvedA.ok ? resolvedA.slots : null}
          />
          <PoolSlots
            shuttle={shuttle}
            poolKey="B"
            letter="B"
            order={playoffs.orders.B}
            resolved={resolvedB.ok ? resolvedB.slots : null}
          />
        </div>
      )}
      {tied && !verbatim ? (
        <Notice tone="warning">
          Some teams share a record, so the file cannot separate them. Prefer resolving advancement in
          YellowFruit first; ordering here only labels the schedule.
        </Notice>
      ) : null}
      {playoffs.verificationError ? <Notice tone="danger">{playoffs.verificationError}</Notice> : null}
      {playoffs.goldPoolName ? (
        <p>
          <StatusBadge tone="success">Gold / Maroon assignments verified</StatusBadge>
        </p>
      ) : null}
      <div className="row">
        {!verbatim ? (
          <Button
            variant="primary"
            onPress={() => void shuttle.confirmPlayoffSlots()}
            isDisabled={shuttle.busy || !resolvedA.ok || !resolvedB.ok || !playoffs.gateReady}
            aria-label={
              playoffs.gateReady
                ? 'Confirm playoff slots'
                : 'Confirm playoff slots (locked until all 30 prelim results are in)'
            }
          >
            Confirm slots
          </Button>
        ) : null}
        <Button
          variant="quiet"
          onPress={() => void shuttle.loadUpdatedYellowFruit()}
          isDisabled={shuttle.busy}
        >
          Reload file
        </Button>
        {(verbatim && playoffs.gateReady) || manifest.playoffSlots ? (
          <Button
            variant={verbatim ? 'primary' : undefined}
            onPress={() => void shuttle.generatePlayoffs()}
            isDisabled={shuttle.busy || hasPlayoffGames || !playoffs.gateReady}
          >
            {hasPlayoffGames ? 'Playoff games written' : 'Generate playoff games'}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function PoolSlots({
  shuttle,
  poolKey,
  letter,
  order,
  resolved,
}: {
  shuttle: Shuttle;
  poolKey: 'A' | 'B';
  letter: 'F' | 'B';
  order: {
    poolName: string;
    standings: {
      teamId: string;
      teamName: string;
      wins: number;
      losses: number;
      ties: number;
      rankLabel: string;
    }[];
    tiedGroups: string[][];
  };
  resolved: Record<string, string> | null;
}) {
  const groupOf = (teamId: string): string[] | null =>
    order.tiedGroups.find((group) => group.includes(teamId)) ?? null;

  const groupOrder = (group: string[]): string[] => {
    if (!resolved) return group;
    const positions = group
      .map((teamId) => order.standings.findIndex((standing) => standing.teamId === teamId))
      .sort((a, b) => a - b);
    return positions.map((position) => resolved[`${letter}${position + 1}`]).filter(Boolean);
  };

  const moveInGroup = (group: string[], position: number, teamId: string) => {
    const current = groupOrder(group).filter((id) => id !== teamId);
    current.splice(position, 0, teamId);
    shuttle.reorderTiedGroup(poolKey, group, current);
  };

  return (
    <table className="slot-table" aria-label={`${order.poolName} finishing slots`}>
      <thead>
        <tr>
          <th scope="col">Slot</th>
          <th scope="col">{order.poolName}</th>
          <th scope="col">Record</th>
        </tr>
      </thead>
      <tbody>
        {order.standings.map((standing, index) => {
          const label = `${letter}${index + 1}`;
          const group = groupOf(standing.teamId);
          return (
            <tr key={standing.teamId}>
              <td>{label}</td>
              <td>
                {group && resolved ? (
                  <select
                    aria-label={`${label} in ${order.poolName}`}
                    value={resolved[label] ?? standing.teamId}
                    onChange={(event) =>
                      moveInGroup(group, groupOrder(group).indexOf(resolved[label]), event.target.value)
                    }
                  >
                    {groupOrder(group).map((teamId) => (
                      <option key={teamId} value={teamId}>
                        {order.standings.find((entry) => entry.teamId === teamId)?.teamName ?? teamId}
                      </option>
                    ))}
                  </select>
                ) : (
                  standing.teamName
                )}
              </td>
              <td className="muted">
                {standing.wins}–{standing.losses}
                {standing.ties > 0 ? `–${standing.ties}` : ''} · {standing.rankLabel}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SlotTables({ shuttle, slots }: { shuttle: Shuttle; slots: Record<string, string> }) {
  const rows = (letter: 'F' | 'B'): [string, string][] =>
    [1, 2, 3, 4, 5, 6].map((number) => {
      const label = `${letter}${number}`;
      return [label, teamNameOf(shuttle, slots[label] ?? '')];
    });
  return (
    <div className="slot-columns">
      {(['F', 'B'] as const).map((letter) => (
        <table key={letter} className="slot-table">
          <tbody>
            {rows(letter).map(([label, name]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}

function DetailsSection({ shuttle }: { shuttle: Shuttle }) {
  const manifest = shuttle.manifest!;
  return (
    <details className="details">
      <summary>Details</summary>
      <p>
        Tournament id <code className="mono">{manifest.tournamentId}</code> · fingerprint{' '}
        <code className="mono">{manifest.tournamentFingerprint}</code> · {manifest.assignments.length}{' '}
        assignments · source file <code className="mono">{shuttle.yftPath ?? '—'}</code>
      </p>
      <pre>{JSON.stringify(manifest, null, 2)}</pre>
    </details>
  );
}
