import { useCallback, useEffect, useRef, useState } from 'react';
import {
  closeRound,
  defaultRules,
  emptyDirectorState,
  generateDirectorRound,
  isoNow,
  newDirectorId,
  roomAssignmentConflicts,
  roundScheduleIsValid,
  type DirectorId,
  type DirectorState,
  type AdvancementRule,
  type DetailedStatsStatus,
  type GameRecord,
  type PlayerGameStat,
  type ProtestScoreAdjustment,
  type ResultSubmission,
  type ScheduledGame,
  type StaffRole,
  type TeamGameScore,
} from '../domain';
import { createDirectorRepository, normalizeDirectorState, type DirectorRepository } from '../persistence';
import {
  assessIncomingDocument,
  ingestWarnings,
  readResultStatisticsForAssociation,
  stageIncomingDocument,
  type IncomingDocument,
} from '../transfers/ingest';
import {
  addTransferLocation,
  dismissTransferArtifact,
  importTransferDocuments,
  noteTransferScan,
  recordPreparedAssignments,
  recordQbtcpDelivery,
  removeTransferLocation,
  setTransferWatching,
  syncRemovableVolumes,
  type AddLocationInput,
  type ImportInput,
  type ImportSummary,
  type RecordPreparedInput,
} from '../transfers/state';
import type { TransferVolume } from '../transfers/ports';
import {
  readNativeServerSnapshot,
  type NativeHelpSnapshot,
  type NativeProgressSnapshot,
  type NativeRosterAmendmentSnapshot,
  type NativeServerSnapshot,
  type NativeSessionSnapshot,
} from '../platform/native';

export interface NewTournamentInput {
  name: string;
  date: string;
  venue: string;
  organizer: string;
}

export interface NewTeamInput {
  displayName: string;
  organizationName?: string;
  teamLetter?: string;
  seed?: number | null;
  notes?: string;
}

export interface ImportedTeamInput {
  id?: string;
  displayName: string;
  organizationId?: string;
  teamLetter?: string;
  seed?: number | null;
  status?: 'confirmed' | 'waitlist' | 'dropped';
  notes?: string;
  players?: Array<{
    id?: string;
    name: string;
    captain?: boolean;
    active?: boolean;
    rosterNumber?: string | number;
    notes?: string;
  }>;
}

export interface NewRoomInput {
  name: string;
  building?: string;
  floor?: string;
  accessibility?: string;
  directions?: string;
  notes?: string;
}

export interface NewPoolInput {
  name: string;
  phaseId?: DirectorId;
  teamIds?: DirectorId[];
}

export interface NewStaffInput {
  name: string;
  roles?: StaffRole[];
  notes?: string;
}

export interface NewEquipmentInput {
  name: string;
  kind?: DirectorState['equipment'][number]['kind'];
  notes?: string;
}

export interface ManualResultInput {
  scheduledGameId: DirectorId;
  scores: TeamGameScore[];
  playerStats?: PlayerGameStat[];
  detailedStats?: DetailedStatsStatus;
  note?: string;
}

export interface DirectorController {
  state: DirectorState;
  loading: boolean;
  saving: boolean;
  error: string | null;
  repositoryKind: DirectorRepository['kind'];
  createTournament(input: NewTournamentInput): void;
  updateTournament(
    changes: Partial<Pick<NonNullable<DirectorState['tournament']>, 'name' | 'date' | 'venue' | 'organizer'>>,
  ): boolean;
  addTeam(input: NewTeamInput): boolean;
  addImportedTeams(teams: ImportedTeamInput[]): { inserted: number; skipped: number };
  updateTeam(teamId: DirectorId, changes: Partial<NewTeamInput>): boolean;
  dropTeam(teamId: DirectorId, reason?: string): boolean;
  restoreTeam(teamId: DirectorId): boolean;
  addPlayer(
    teamId: DirectorId,
    name: string,
    captain?: boolean,
    rosterNumber?: string | number,
    notes?: string,
  ): boolean;
  updatePlayer(
    playerId: DirectorId,
    changes: Partial<
      Pick<DirectorState['players'][number], 'name' | 'captain' | 'active' | 'rosterNumber' | 'notes'>
    >,
  ): boolean;
  removePlayer(playerId: DirectorId): void;
  addRoom(input: NewRoomInput): void;
  updateRoom(
    roomId: DirectorId,
    changes: Partial<NewRoomInput> & {
      available?: boolean;
      moderatorId?: DirectorId | null;
      scorekeeperId?: DirectorId | null;
      equipmentId?: DirectorId | null;
    },
  ): boolean;
  addStaff(input: NewStaffInput): void;
  updateStaff(
    staffId: DirectorId,
    changes: Partial<Pick<DirectorState['staff'][number], 'name' | 'roles' | 'available' | 'notes'>>,
  ): boolean;
  addEquipment(input: NewEquipmentInput): void;
  updateEquipment(
    equipmentId: DirectorId,
    changes: Partial<Pick<DirectorState['equipment'][number], 'name' | 'kind' | 'available' | 'notes'>>,
  ): boolean;
  addPacket(
    name: string,
    source?: 'manual' | 'qbj' | 'imported',
    options?: { tiebreaker?: boolean; notes?: string },
  ): boolean;
  addPackets(
    packets: Array<{
      name: string;
      source?: 'manual' | 'qbj' | 'imported';
      tiebreaker?: boolean;
      notes?: string;
    }>,
  ): { inserted: number; skipped: number };
  updatePacket(
    packetId: DirectorId,
    changes: Partial<Pick<DirectorState['packets'][number], 'name' | 'tiebreaker' | 'notes'>>,
  ): boolean;
  selectPhase(phaseId: DirectorId): void;
  selectPacket(packetId: DirectorId): void;
  updateFormat(
    changes: Partial<
      Pick<
        NonNullable<DirectorState['formats'][number]>,
        'name' | 'kind' | 'avoidRematches' | 'avoidSameOrganization' | 'allowByes' | 'roundsPerTeam'
      >
    >,
  ): boolean;
  addPhase(name: string, kind?: NonNullable<DirectorState['phases'][number]>['kind']): void;
  updatePhase(
    phaseId: DirectorId,
    changes: Partial<
      Pick<NonNullable<DirectorState['phases'][number]>, 'name' | 'kind' | 'carryover' | 'advancementRule'>
    >,
  ): boolean;
  addPool(input: NewPoolInput): boolean;
  updatePool(poolId: DirectorId, changes: { name?: string; teamIds?: DirectorId[] }): boolean;
  updateRules(changes: Partial<NonNullable<DirectorState['tournament']>['rules']>): boolean;
  generateSchedule(options?: { seed?: number; avoidRematches?: boolean; avoidSameOrganization?: boolean }): {
    conflicts: string[];
    generated: boolean;
  };
  prepareRound(roundId: DirectorId): boolean;
  releaseRound(roundId: DirectorId): boolean;
  closeRound(roundId: DirectorId): boolean;
  cancelScheduledGame(scheduledGameId: DirectorId, reason?: string): boolean;
  addManualResult(input: ManualResultInput): boolean;
  associateSubmission(submissionId: DirectorId, scheduledGameId: DirectorId): boolean;
  acceptSubmission(submissionId: DirectorId, actor?: string): boolean;
  rejectSubmission(submissionId: DirectorId, reason?: string): boolean;
  editAcceptedResult(gameId: DirectorId, scores: TeamGameScore[], note?: string): boolean;
  addProtest(
    gameId: DirectorId,
    description: string,
    category?: 'tossup' | 'bonus' | 'procedure' | 'other',
  ): boolean;
  ruleProtest(protestId: DirectorId, ruling: string, scoreAdjustment?: ProtestScoreAdjustment): boolean;
  syncQbtcp(): Promise<void>;
  qbtcpHealth: { lastSuccessfulAt: string | null; error: string | null };
  /** Add or re-adopt a place assignments can be written to and results read from. */
  addTransferLocation(input: AddLocationInput): void;
  removeTransferLocation(locationId: DirectorId): void;
  setTransferWatching(locationId: DirectorId, watching: boolean): void;
  /** Reconcile known removable locations against what the platform currently sees. */
  syncTransferVolumes(volumes: TransferVolume[]): void;
  noteTransferScan(locationId: DirectorId, outcome: { at: string; message?: string; found?: number }): void;
  recordPreparedAssignments(input: RecordPreparedInput): void;
  /**
   * Import a batch of documents through the shared result pipeline.
   *
   * Returns what happened so the caller can say it in one line. Nothing here accepts a result: the
   * batch lands in the results inbox and a director accepts it there, the same as a QBTCP arrival.
   */
  importTransferDocuments(inputs: ImportInput[]): ImportSummary;
  dismissTransferArtifact(artifactId: DirectorId): void;
  checkpoint(reason: string): Promise<void>;
  exportSnapshot(): string;
  importSnapshot(value: unknown): boolean;
}

export function useDirectorController(repository = createDirectorRepository()): DirectorController {
  const repositoryRef = useRef(repository);
  const [repositoryKind] = useState(() => repository.kind);
  const [state, setState] = useState<DirectorState>(emptyDirectorState);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qbtcpHealth, setQbtcpHealth] = useState<{
    lastSuccessfulAt: string | null;
    error: string | null;
  }>({ lastSuccessfulAt: null, error: null });
  const stateRef = useRef<DirectorState>(emptyDirectorState());
  const stateRevisionRef = useRef(0);
  const persistenceQueueRef = useRef(Promise.resolve());
  const persistenceSequenceRef = useRef(0);
  const qbtcpSyncInFlightRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let active = true;
    void repositoryRef.current
      .load()
      .then((loaded) => {
        if (!active) return;
        stateRef.current = loaded;
        stateRevisionRef.current += 1;
        setState(loaded);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : 'Director storage could not be opened.');
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const enqueuePersistence = useCallback(
    (
      snapshot: DirectorState,
      revision: number,
      operation: (persisted: DirectorState) => Promise<void>,
    ): Promise<void> => {
      const sequence = persistenceSequenceRef.current + 1;
      persistenceSequenceRef.current = sequence;
      const task = persistenceQueueRef.current.then(async () => {
        const persisted = structuredClone(snapshot);
        await operation(persisted);
        // A successful queued write clears a previous failure even when this revision is no
        // longer current. A newer queued write will set the error again if it fails.
        setError(null);
        if (stateRevisionRef.current === revision) {
          stateRef.current = persisted;
          setState(persisted);
        }
      });
      persistenceQueueRef.current = task.then(
        () => undefined,
        () => undefined,
      );
      setSaving(true);
      void task
        .then(undefined, (reason: unknown) => {
          setError(reason instanceof Error ? reason.message : 'Director storage could not be saved.');
        })
        .finally(() => {
          if (persistenceSequenceRef.current === sequence) setSaving(false);
        });
      return task;
    },
    [],
  );

  const persist = useCallback(
    (next: DirectorState, revision: number) =>
      enqueuePersistence(next, revision, async (persisted) => {
        persisted.metadata.lastSavedAt = isoNow();
        await repositoryRef.current.save(persisted);
      }),
    [enqueuePersistence],
  );

  const commit = useCallback(
    (mutator: (draft: DirectorState) => void) => {
      const next = structuredClone(stateRef.current);
      mutator(next);
      const revision = stateRevisionRef.current + 1;
      stateRevisionRef.current = revision;
      stateRef.current = next;
      setState(next);
      void persist(next, revision).catch(() => undefined);
    },
    [persist],
  );

  const createTournament = useCallback(
    (input: NewTournamentInput) => {
      const now = isoNow();
      const tournamentId = newDirectorId('tournament');
      const formatId = newDirectorId('format');
      const phaseId = newDirectorId('phase');
      commit((draft) => {
        const fresh = emptyDirectorState();
        Object.assign(draft, fresh);
        draft.tournament = {
          id: tournamentId,
          name: input.name.trim() || 'Untitled tournament',
          date: input.date,
          venue: input.venue.trim(),
          organizer: input.organizer.trim(),
          status: 'draft',
          rules: structuredClone(defaultRules),
          formatId,
          currentPhaseId: phaseId,
          currentPacketId: null,
          currentRoundId: null,
          createdAt: now,
          updatedAt: now,
        };
        draft.formats.push({
          id: formatId,
          name: 'Round robin',
          kind: 'round-robin',
          phaseIds: [phaseId],
          roundsPerTeam: null,
          avoidRematches: true,
          avoidSameOrganization: false,
          allowByes: true,
          editable: true,
        });
        draft.phases.push({
          id: phaseId,
          name: 'Preliminary phase',
          kind: 'preliminary',
          order: 1,
          formatId,
          poolIds: [],
          roundIds: [],
          advancementRule: null,
          carryover: false,
          status: 'planned',
        });
        draft.audit.push({
          id: newDirectorId('audit'),
          at: now,
          actor: 'Director',
          type: 'tournament-created',
          summary: `Created ${draft.tournament.name}.`,
          entityId: tournamentId,
        });
      });
    },
    [commit],
  );

  const updateTournament = useCallback(
    (
      changes: Partial<
        Pick<NonNullable<DirectorState['tournament']>, 'name' | 'date' | 'venue' | 'organizer'>
      >,
    ): boolean => {
      const current = stateRef.current.tournament;
      if (!current) {
        setError('Create a tournament before editing its details.');
        return false;
      }
      const normalized = {
        ...(changes.name !== undefined ? { name: changes.name.trim() } : {}),
        ...(changes.date !== undefined ? { date: changes.date.trim() } : {}),
        ...(changes.venue !== undefined ? { venue: changes.venue.trim() } : {}),
        ...(changes.organizer !== undefined ? { organizer: changes.organizer.trim() } : {}),
      };
      if ('name' in normalized && !normalized.name) {
        setError('A tournament name is required.');
        return false;
      }
      commit((draft) => {
        if (!draft.tournament) return;
        Object.assign(draft.tournament, normalized, { updatedAt: isoNow() });
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'tournament-updated',
          summary: 'Tournament details updated.',
          entityId: draft.tournament.id,
        });
      });
      return true;
    },
    [commit],
  );

  const addTeam = useCallback(
    (input: NewTeamInput): boolean => {
      const snapshot = stateRef.current;
      const displayName = input.displayName.trim();
      if (!displayName) {
        setError('A team name is required.');
        return false;
      }
      if (
        snapshot.teams.some((team) => team.displayName.trim().toLowerCase() === displayName.toLowerCase())
      ) {
        setError(`Team “${displayName}” already exists.`);
        return false;
      }
      if (
        input.seed !== undefined &&
        input.seed !== null &&
        (!Number.isInteger(input.seed) || input.seed < 1)
      ) {
        setError('Seed must be a positive whole number or blank.');
        return false;
      }
      commit((draft) => {
        const now = isoNow();
        let organizationId: DirectorId | null = null;
        const organizationName = input.organizationName?.trim();
        if (organizationName) {
          const existing = draft.organizations.find(
            (organization) => organization.name.toLocaleLowerCase() === organizationName.toLocaleLowerCase(),
          );
          organizationId = existing?.id ?? newDirectorId('organization');
          if (!existing) draft.organizations.push({ id: organizationId, name: organizationName });
        }
        const teamId = newDirectorId('team');
        draft.teams.push({
          id: teamId,
          organizationId,
          displayName,
          teamLetter: input.teamLetter?.trim() || '',
          seed: input.seed ?? null,
          status: 'confirmed',
          notes: input.notes?.trim(),
          createdAt: now,
          updatedAt: now,
        });
        draft.audit.push({
          id: newDirectorId('audit'),
          at: now,
          actor: 'Director',
          type: 'team-changed',
          summary: `Added ${displayName}.`,
          entityId: teamId,
        });
      });
      return true;
    },
    [commit],
  );

  const addImportedTeams = useCallback(
    (inputs: ImportedTeamInput[]): { inserted: number; skipped: number } => {
      if (inputs.length === 0) return { inserted: 0, skipped: 0 };
      let inserted = 0;
      let skipped = 0;
      commit((draft) => {
        const teamIds = new Set(draft.teams.map((team) => team.id));
        const teamNames = new Set(draft.teams.map((team) => team.displayName.toLocaleLowerCase()));
        const playerIds = new Set(draft.players.map((player) => player.id));
        for (const input of inputs) {
          const name = input.displayName.trim();
          const requestedTeamId = input.id?.trim();
          if (
            !name ||
            (requestedTeamId && teamIds.has(requestedTeamId)) ||
            teamNames.has(name.toLocaleLowerCase())
          ) {
            skipped += 1;
            continue;
          }
          const now = isoNow();
          const teamId = requestedTeamId || newDirectorId('team');
          if (teamIds.has(teamId)) {
            skipped += 1;
            continue;
          }
          const organizationName = input.organizationId?.trim();
          let organizationId: DirectorId | null = null;
          if (organizationName) {
            const organization = draft.organizations.find(
              (candidate) =>
                candidate.id === organizationName ||
                candidate.name.toLocaleLowerCase() === organizationName.toLocaleLowerCase(),
            );
            if (organization) organizationId = organization.id;
            else {
              const newOrgId = newDirectorId('organization');
              draft.organizations.push({ id: newOrgId, name: organizationName });
              organizationId = newOrgId;
            }
          }
          draft.teams.push({
            id: teamId,
            organizationId,
            displayName: name,
            teamLetter: input.teamLetter?.trim() || '',
            seed: input.seed ?? null,
            status: input.status ?? 'confirmed',
            notes: input.notes?.trim(),
            createdAt: now,
            updatedAt: now,
          });
          teamIds.add(teamId);
          teamNames.add(name.toLocaleLowerCase());
          const teamPlayerNames = new Set<string>();
          for (const sourcePlayer of input.players ?? []) {
            const playerName = sourcePlayer.name.trim();
            if (!playerName || teamPlayerNames.has(playerName.toLocaleLowerCase())) continue;
            const requestedPlayerId = sourcePlayer.id?.trim();
            const playerId =
              requestedPlayerId && !playerIds.has(requestedPlayerId)
                ? requestedPlayerId
                : newDirectorId('player');
            draft.players.push({
              id: playerId,
              teamId,
              name: playerName,
              captain: sourcePlayer.captain ?? false,
              active: sourcePlayer.active ?? true,
              rosterNumber: sourcePlayer.rosterNumber,
              notes: sourcePlayer.notes?.trim(),
            });
            playerIds.add(playerId);
            teamPlayerNames.add(playerName.toLocaleLowerCase());
          }
          draft.audit.push({
            id: newDirectorId('audit'),
            at: now,
            actor: 'Director',
            type: 'team-changed',
            summary: `Imported ${name}.`,
            entityId: teamId,
          });
          inserted += 1;
        }
      });
      return { inserted, skipped };
    },
    [commit],
  );

  const updateTeam = useCallback(
    (teamId: DirectorId, changes: Partial<NewTeamInput>): boolean => {
      const snapshot = stateRef.current;
      const current = snapshot.teams.find((entry) => entry.id === teamId);
      if (!current) {
        setError('That team is no longer in the tournament workspace.');
        return false;
      }
      const displayName =
        changes.displayName === undefined ? current.displayName : changes.displayName.trim();
      if (!displayName) {
        setError('A team name is required.');
        return false;
      }
      if (
        snapshot.teams.some(
          (team) =>
            team.id !== teamId &&
            team.displayName.trim().toLocaleLowerCase() === displayName.toLocaleLowerCase(),
        )
      ) {
        setError(`Team “${displayName}” already exists.`);
        return false;
      }
      if (
        changes.seed !== undefined &&
        changes.seed !== null &&
        (!Number.isInteger(changes.seed) || changes.seed < 1)
      ) {
        setError('Seed must be a positive whole number or blank.');
        return false;
      }
      commit((draft) => {
        const team = draft.teams.find((entry) => entry.id === teamId);
        if (!team) return;
        if (changes.organizationName !== undefined) {
          const organizationName = changes.organizationName.trim();
          if (!organizationName) team.organizationId = null;
          else {
            const existing = draft.organizations.find(
              (organization) =>
                organization.id === organizationName ||
                organization.name.toLocaleLowerCase() === organizationName.toLocaleLowerCase(),
            );
            if (existing) team.organizationId = existing.id;
            else {
              const organizationId = newDirectorId('organization');
              draft.organizations.push({ id: organizationId, name: organizationName });
              team.organizationId = organizationId;
            }
          }
        }
        team.displayName = displayName;
        if (changes.teamLetter !== undefined) team.teamLetter = changes.teamLetter.trim();
        if (changes.seed !== undefined) team.seed = changes.seed;
        if (changes.notes !== undefined) team.notes = changes.notes.trim() || undefined;
        team.updatedAt = isoNow();
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'team-changed',
          summary: `Updated ${team.displayName}.`,
          entityId: teamId,
        });
      });
      return true;
    },
    [commit],
  );

  const dropTeam = useCallback(
    (teamId: DirectorId, reason = 'Dropped by director'): boolean => {
      const snapshot = stateRef.current;
      const current = snapshot.teams.find((entry) => entry.id === teamId);
      if (!current) {
        setError('That team is no longer in the tournament workspace.');
        return false;
      }
      if (current.status === 'dropped') {
        setError('That team is already dropped.');
        return false;
      }
      const openRound = snapshot.rounds.find(
        (round) =>
          round.status !== 'closed' &&
          snapshot.scheduledGames.some(
            (game) =>
              game.roundId === round.id && (game.leftTeamId === teamId || game.rightTeamId === teamId),
          ),
      );
      if (openRound) {
        setError(`Finish or repair ${openRound.name} before dropping this team.`);
        return false;
      }
      commit((draft) => {
        const team = draft.teams.find((entry) => entry.id === teamId);
        if (!team) return;
        team.status = 'dropped';
        team.notes = [team.notes, reason].filter(Boolean).join(' · ');
        team.updatedAt = isoNow();
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'team-dropped',
          summary: `${team.displayName} dropped.`,
          entityId: teamId,
          details: { reason },
        });
      });
      return true;
    },
    [commit],
  );

  const restoreTeam = useCallback(
    (teamId: DirectorId): boolean => {
      const snapshot = stateRef.current;
      const current = snapshot.teams.find((entry) => entry.id === teamId);
      if (!current) {
        setError('That team is no longer in the tournament workspace.');
        return false;
      }
      if (current.status !== 'dropped') {
        setError('That team is already active.');
        return false;
      }
      if (
        snapshot.teams.some(
          (team) =>
            team.id !== teamId &&
            team.displayName.trim().toLowerCase() === current.displayName.trim().toLowerCase(),
        )
      ) {
        setError(`Team “${current.displayName}” already exists.`);
        return false;
      }
      commit((draft) => {
        const team = draft.teams.find((entry) => entry.id === teamId);
        if (!team) return;
        team.status = 'confirmed';
        team.updatedAt = isoNow();
        draft.audit.push({
          id: newDirectorId('audit'),
          at: team.updatedAt,
          actor: 'Director',
          type: 'team-changed',
          summary: `${team.displayName} restored to the active field.`,
          entityId: teamId,
        });
      });
      return true;
    },
    [commit],
  );

  const addPlayer = useCallback(
    (
      teamId: DirectorId,
      name: string,
      captain = false,
      rosterNumber?: string | number,
      notes?: string,
    ): boolean => {
      const normalizedName = name.trim();
      const snapshot = stateRef.current;
      if (!normalizedName) {
        setError('A player name is required.');
        return false;
      }
      if (!snapshot.teams.some((team) => team.id === teamId)) {
        setError('A player must belong to an existing team.');
        return false;
      }
      if (
        snapshot.players.some(
          (player) =>
            player.teamId === teamId &&
            player.active &&
            player.name.trim().toLocaleLowerCase() === normalizedName.toLocaleLowerCase(),
        )
      ) {
        setError(`“${normalizedName}” is already on this active roster.`);
        return false;
      }
      commit((draft) => {
        const playerId = newDirectorId('player');
        if (captain)
          draft.players
            .filter((player) => player.teamId === teamId)
            .forEach((player) => (player.captain = false));
        draft.players.push({
          id: playerId,
          teamId,
          name: normalizedName,
          captain,
          active: true,
          rosterNumber: normalizeRosterNumber(rosterNumber),
          notes: notes?.trim() || undefined,
        });
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'team-changed',
          summary: `Added ${normalizedName} to a roster.`,
          entityId: playerId,
        });
      });
      return true;
    },
    [commit],
  );

  const updatePlayer = useCallback(
    (
      playerId: DirectorId,
      changes: Partial<
        Pick<DirectorState['players'][number], 'name' | 'captain' | 'active' | 'rosterNumber' | 'notes'>
      >,
    ): boolean => {
      const snapshot = stateRef.current;
      const current = snapshot.players.find((player) => player.id === playerId);
      if (!current) {
        setError('That player is no longer on the tournament roster.');
        return false;
      }
      const name = changes.name === undefined ? current.name : changes.name.trim();
      if (!name) {
        setError('A player name is required.');
        return false;
      }
      const active = changes.active ?? current.active;
      if (
        active &&
        snapshot.players.some(
          (player) =>
            player.id !== playerId &&
            player.teamId === current.teamId &&
            player.active &&
            player.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
        )
      ) {
        setError(`“${name}” is already on this active roster.`);
        return false;
      }
      commit((draft) => {
        const player = draft.players.find((entry) => entry.id === playerId);
        if (!player) return;
        if (changes.captain) {
          draft.players
            .filter((entry) => entry.teamId === player.teamId && entry.id !== playerId)
            .forEach((entry) => (entry.captain = false));
        }
        player.name = name;
        if (changes.captain !== undefined) player.captain = changes.captain;
        if (changes.active !== undefined) player.active = changes.active;
        if (changes.rosterNumber !== undefined) {
          const normalizedRosterNumber = normalizeRosterNumber(changes.rosterNumber);
          if (normalizedRosterNumber === undefined) delete player.rosterNumber;
          else player.rosterNumber = normalizedRosterNumber;
        }
        if (changes.notes !== undefined) {
          const normalizedNotes = changes.notes.trim();
          if (normalizedNotes) player.notes = normalizedNotes;
          else delete player.notes;
        }
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'team-changed',
          summary: `Updated ${player.name} on a roster.`,
          entityId: playerId,
        });
      });
      return true;
    },
    [commit],
  );

  const removePlayer = useCallback(
    (playerId: DirectorId) =>
      commit((draft) => {
        const player = draft.players.find((entry) => entry.id === playerId);
        if (!player) return;
        player.active = false;
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'team-changed',
          summary: `Removed ${player.name} from the active roster.`,
          entityId: playerId,
        });
      }),
    [commit],
  );

  const addRoom = useCallback(
    (input: NewRoomInput) =>
      commit((draft) => {
        const roomId = newDirectorId('room');
        draft.rooms.push({
          id: roomId,
          name: input.name.trim() || `Room ${draft.rooms.length + 1}`,
          building: input.building?.trim(),
          floor: input.floor?.trim(),
          accessibility: input.accessibility?.trim() || undefined,
          directions: input.directions?.trim() || undefined,
          notes: input.notes?.trim() || undefined,
          status: 'available',
          moderatorId: null,
          scorekeeperId: null,
          equipmentId: null,
          available: true,
        });
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'room-changed',
          summary: `Added ${input.name.trim() || `Room ${draft.rooms.length}`}.`,
          entityId: roomId,
        });
      }),
    [commit],
  );

  const updateRoom = useCallback(
    (
      roomId: DirectorId,
      changes: Partial<NewRoomInput> & {
        available?: boolean;
        moderatorId?: DirectorId | null;
        scorekeeperId?: DirectorId | null;
        equipmentId?: DirectorId | null;
      },
    ): boolean => {
      const current = stateRef.current.rooms.find((entry) => entry.id === roomId);
      if (!current) {
        setError('That room is no longer in the tournament workspace.');
        return false;
      }
      if (changes.name !== undefined && !changes.name.trim()) {
        setError('A room name is required.');
        return false;
      }
      commit((draft) => {
        const room = draft.rooms.find((entry) => entry.id === roomId);
        if (!room) return;
        Object.assign(room, changes);
        if (changes.name !== undefined) room.name = changes.name.trim();
        if (changes.building !== undefined) room.building = changes.building.trim() || undefined;
        if (changes.floor !== undefined) room.floor = changes.floor.trim() || undefined;
        if (changes.accessibility !== undefined) {
          room.accessibility = changes.accessibility.trim() || undefined;
        }
        if (changes.directions !== undefined) room.directions = changes.directions.trim() || undefined;
        if (changes.notes !== undefined) room.notes = changes.notes.trim() || undefined;
        // Availability controls future assignment. Do not overwrite a live scorer, open help
        // request, or finished room; only mirror the explicit choice for an otherwise idle room.
        if (changes.available === true && room.status === 'offline') room.status = 'available';
        if (changes.available === false && room.status === 'available') room.status = 'offline';
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'room-changed',
          summary: `Updated ${room.name}.`,
          entityId: roomId,
        });
      });
      return true;
    },
    [commit],
  );

  const addStaff = useCallback(
    (input: NewStaffInput) =>
      commit((draft) => {
        const name = input.name.trim();
        if (!name) return;
        const staffId = newDirectorId('staff');
        draft.staff.push({
          id: staffId,
          name,
          roles: input.roles?.length ? input.roles : ['moderator'],
          available: true,
          notes: input.notes?.trim(),
        });
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'room-changed',
          summary: `Added ${name} to staff.`,
          entityId: staffId,
        });
      }),
    [commit],
  );

  const updateStaff = useCallback(
    (
      staffId: DirectorId,
      changes: Partial<Pick<DirectorState['staff'][number], 'name' | 'roles' | 'available' | 'notes'>>,
    ): boolean => {
      const current = stateRef.current.staff.find((member) => member.id === staffId);
      if (!current) {
        setError('That staff member is no longer in the tournament workspace.');
        return false;
      }
      const name = changes.name === undefined ? current.name : changes.name.trim();
      if (!name) {
        setError('A staff member needs a name.');
        return false;
      }
      const roles = changes.roles === undefined ? current.roles : [...new Set(changes.roles)];
      if (roles.length === 0) {
        setError('A staff member needs at least one role.');
        return false;
      }
      commit((draft) => {
        const member = draft.staff.find((entry) => entry.id === staffId);
        if (!member) return;
        member.name = name;
        member.roles = roles;
        if (changes.available !== undefined) member.available = changes.available;
        if (changes.notes !== undefined) member.notes = changes.notes.trim() || undefined;
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'room-changed',
          summary: `Updated ${member.name}.`,
          entityId: staffId,
        });
      });
      return true;
    },
    [commit],
  );

  const addEquipment = useCallback(
    (input: NewEquipmentInput) =>
      commit((draft) => {
        const name = input.name.trim();
        if (!name) return;
        const equipmentId = newDirectorId('equipment');
        draft.equipment.push({
          id: equipmentId,
          name,
          kind: input.kind ?? 'other',
          available: true,
          notes: input.notes?.trim(),
        });
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'room-changed',
          summary: `Added ${name} to equipment.`,
          entityId: equipmentId,
        });
      }),
    [commit],
  );

  const updateEquipment = useCallback(
    (
      equipmentId: DirectorId,
      changes: Partial<Pick<DirectorState['equipment'][number], 'name' | 'kind' | 'available' | 'notes'>>,
    ): boolean => {
      const current = stateRef.current.equipment.find((item) => item.id === equipmentId);
      if (!current) {
        setError('That equipment resource is no longer in the tournament workspace.');
        return false;
      }
      const name = changes.name === undefined ? current.name : changes.name.trim();
      if (!name) {
        setError('An equipment resource needs a name.');
        return false;
      }
      commit((draft) => {
        const item = draft.equipment.find((entry) => entry.id === equipmentId);
        if (!item) return;
        item.name = name;
        if (changes.kind !== undefined) item.kind = changes.kind;
        if (changes.available !== undefined) item.available = changes.available;
        if (changes.notes !== undefined) item.notes = changes.notes.trim() || undefined;
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'room-changed',
          summary: `Updated ${item.name}.`,
          entityId: equipmentId,
        });
      });
      return true;
    },
    [commit],
  );

  const addPacket = useCallback(
    (
      name: string,
      source: 'manual' | 'qbj' | 'imported' = 'manual',
      options: { tiebreaker?: boolean; notes?: string } = {},
    ): boolean => {
      const snapshot = stateRef.current;
      const normalizedName = name.trim();
      if (!normalizedName) {
        setError('A packet name is required.');
        return false;
      }
      if (
        snapshot.packets.some(
          (packet) => packet.name.trim().toLocaleLowerCase() === normalizedName.toLocaleLowerCase(),
        )
      ) {
        setError(`Packet “${normalizedName}” already exists.`);
        return false;
      }
      commit((draft) => {
        const packetId = newDirectorId('packet');
        draft.packets.push({
          id: packetId,
          name: normalizedName,
          source,
          assignedRoundIds: [],
          assignedGameIds: [],
          usedGameIds: [],
          replacementForPacketId: null,
          tiebreaker: options.tiebreaker ?? false,
          notes: options.notes?.trim() || undefined,
        });
        if (draft.tournament && draft.tournament.currentPacketId === null) {
          draft.tournament.currentPacketId = packetId;
          draft.tournament.updatedAt = isoNow();
        }
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'packet-changed',
          summary: `Added ${normalizedName}.`,
          entityId: packetId,
        });
      });
      return true;
    },
    [commit],
  );

  const addPackets = useCallback(
    (
      packets: Array<{
        name: string;
        source?: 'manual' | 'qbj' | 'imported';
        tiebreaker?: boolean;
        notes?: string;
      }>,
    ): { inserted: number; skipped: number } => {
      let inserted = 0;
      let skipped = 0;
      commit((draft) => {
        const now = isoNow();
        const existingNames = new Set(draft.packets.map((packet) => packet.name.trim().toLocaleLowerCase()));
        for (const input of packets) {
          const name = input.name.trim();
          if (!name || existingNames.has(name.toLocaleLowerCase())) {
            skipped += 1;
            continue;
          }
          const packetId = newDirectorId('packet');
          draft.packets.push({
            id: packetId,
            name,
            source: input.source ?? 'imported',
            assignedRoundIds: [],
            assignedGameIds: [],
            usedGameIds: [],
            replacementForPacketId: null,
            tiebreaker: input.tiebreaker ?? false,
            notes: input.notes?.trim(),
          });
          if (draft.tournament && draft.tournament.currentPacketId === null) {
            draft.tournament.currentPacketId = packetId;
            draft.tournament.updatedAt = now;
          }
          existingNames.add(name.toLocaleLowerCase());
          draft.audit.push({
            id: newDirectorId('audit'),
            at: now,
            actor: 'Director',
            type: 'packet-changed',
            summary: `Imported ${name}.`,
            entityId: packetId,
          });
          inserted += 1;
        }
      });
      return { inserted, skipped };
    },
    [commit],
  );

  const updatePacket = useCallback(
    (
      packetId: DirectorId,
      changes: Partial<Pick<DirectorState['packets'][number], 'name' | 'tiebreaker' | 'notes'>>,
    ): boolean => {
      const snapshot = stateRef.current;
      const current = snapshot.packets.find((packet) => packet.id === packetId);
      if (!current) {
        setError('That packet is no longer in the tournament inventory.');
        return false;
      }
      const name = changes.name === undefined ? current.name : changes.name.trim();
      if (!name) {
        setError('A packet name is required.');
        return false;
      }
      if (
        snapshot.packets.some(
          (packet) =>
            packet.id !== packetId && packet.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
        )
      ) {
        setError(`Packet “${name}” already exists.`);
        return false;
      }
      commit((draft) => {
        const packet = draft.packets.find((entry) => entry.id === packetId);
        if (!packet) return;
        packet.name = name;
        if (changes.tiebreaker !== undefined) packet.tiebreaker = changes.tiebreaker;
        if (changes.notes !== undefined) {
          const normalizedNotes = changes.notes.trim();
          if (normalizedNotes) packet.notes = normalizedNotes;
          else delete packet.notes;
        }
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'packet-changed',
          summary: `Updated ${packet.name}.`,
          entityId: packetId,
        });
      });
      return true;
    },
    [commit],
  );

  const updateFormat = useCallback(
    (
      changes: Partial<
        Pick<
          NonNullable<DirectorState['formats'][number]>,
          'name' | 'kind' | 'avoidRematches' | 'avoidSameOrganization' | 'allowByes' | 'roundsPerTeam'
        >
      >,
    ): boolean => {
      const snapshot = stateRef.current;
      const formatId = snapshot.tournament?.formatId;
      const format = formatId ? snapshot.formats.find((entry) => entry.id === formatId) : undefined;
      if (!format) {
        setError('Choose a valid tournament format before editing its settings.');
        return false;
      }
      if (changes.kind !== undefined && changes.kind !== format.kind && snapshot.rounds.length > 0) {
        setError('The format type is locked after schedule generation; add a new phase for future play.');
        return false;
      }
      if (
        changes.roundsPerTeam !== undefined &&
        changes.roundsPerTeam !== null &&
        (!Number.isInteger(changes.roundsPerTeam) || changes.roundsPerTeam < 1 || changes.roundsPerTeam > 99)
      ) {
        setError('Rounds per team must be a whole number from 1 to 99, or blank for no fixed limit.');
        return false;
      }
      if (changes.name !== undefined && !changes.name.trim()) {
        setError('A format name is required.');
        return false;
      }
      const normalized = {
        ...changes,
        ...(changes.name !== undefined ? { name: changes.name.trim() } : {}),
      };
      commit((draft) => {
        const formatId = draft.tournament?.formatId;
        const format = formatId ? draft.formats.find((entry) => entry.id === formatId) : undefined;
        if (!format) return;
        Object.assign(format, normalized);
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'format-changed',
          summary: `Updated ${format.name}.`,
          entityId: format.id,
        });
      });
      return true;
    },
    [commit],
  );

  const addPhase = useCallback(
    (name: string, kind: NonNullable<DirectorState['phases'][number]>['kind'] = 'preliminary') =>
      commit((draft) => {
        const formatId = draft.tournament?.formatId;
        const format = formatId ? draft.formats.find((entry) => entry.id === formatId) : undefined;
        if (!format) return;
        const phaseId = newDirectorId('phase');
        const phase = {
          id: phaseId,
          name: name.trim() || `Phase ${draft.phases.length + 1}`,
          kind,
          order: draft.phases.length + 1,
          formatId: format.id,
          poolIds: [],
          roundIds: [],
          advancementRule: null,
          carryover: false,
          status: 'planned' as const,
        };
        draft.phases.push(phase);
        format.phaseIds.push(phaseId);
        if (draft.tournament && draft.tournament.currentPhaseId === null) {
          draft.tournament.currentPhaseId = phaseId;
          draft.tournament.updatedAt = isoNow();
        }
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'format-changed',
          summary: `Added ${phase.name}.`,
          entityId: phaseId,
        });
      }),
    [commit],
  );

  const updatePhase = useCallback(
    (
      phaseId: DirectorId,
      changes: Partial<
        Pick<NonNullable<DirectorState['phases'][number]>, 'name' | 'kind' | 'carryover' | 'advancementRule'>
      >,
    ): boolean => {
      const snapshot = stateRef.current;
      const phase = snapshot.phases.find((entry) => entry.id === phaseId);
      if (!phase || phase.formatId !== snapshot.tournament?.formatId) {
        setError('That phase is not part of the current format.');
        return false;
      }
      if (changes.name !== undefined && !changes.name.trim()) {
        setError('A phase name is required.');
        return false;
      }
      if (changes.kind !== undefined && !isPhaseKind(changes.kind)) {
        setError('Choose a valid phase type.');
        return false;
      }
      if (changes.kind !== undefined && changes.kind !== phase.kind && phase.roundIds.length > 0) {
        setError('A phase type is locked after a round has been generated.');
        return false;
      }
      const advancementError = validateAdvancementRule(changes.advancementRule);
      if (advancementError) {
        setError(advancementError);
        return false;
      }
      commit((draft) => {
        const target = draft.phases.find((entry) => entry.id === phaseId);
        if (!target) return;
        if (changes.name !== undefined) target.name = changes.name.trim();
        if (changes.kind !== undefined) target.kind = changes.kind;
        if (changes.carryover !== undefined) target.carryover = changes.carryover;
        if (changes.advancementRule !== undefined) {
          target.advancementRule = changes.advancementRule
            ? { ...changes.advancementRule, tiebreakers: [...changes.advancementRule.tiebreakers] }
            : null;
        }
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'format-changed',
          summary: `Updated ${target.name}.`,
          entityId: target.id,
        });
      });
      return true;
    },
    [commit],
  );

  const addPool = useCallback(
    (input: NewPoolInput): boolean => {
      const snapshot = stateRef.current;
      const phaseId = input.phaseId ?? snapshot.tournament?.currentPhaseId;
      const phase = phaseId ? snapshot.phases.find((entry) => entry.id === phaseId) : undefined;
      if (!phase || phase.formatId !== snapshot.tournament?.formatId) {
        setError('Choose a valid current phase before adding a pool.');
        return false;
      }
      if (phase.roundIds.length > 0) {
        setError('Pool membership is locked after a round has been generated; add a new phase instead.');
        return false;
      }
      const name = input.name.trim();
      if (!name) {
        setError('A pool name is required.');
        return false;
      }
      if (
        snapshot.pools.some(
          (pool) =>
            pool.phaseId === phase.id && pool.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
        )
      ) {
        setError(`Pool “${name}” already exists in this phase.`);
        return false;
      }
      const teamIds = [...(input.teamIds ?? [])];
      if (new Set(teamIds).size !== teamIds.length) {
        setError('A pool cannot contain the same team twice.');
        return false;
      }
      if (teamIds.some((teamId) => !snapshot.teams.some((team) => team.id === teamId))) {
        setError('A pool can only contain teams that exist in the tournament.');
        return false;
      }
      const siblingTeamIds = new Set(
        snapshot.pools.filter((pool) => pool.phaseId === phase.id).flatMap((pool) => pool.teamIds),
      );
      const overlap = teamIds.find((teamId) => siblingTeamIds.has(teamId));
      if (overlap) {
        setError('Each team can belong to only one pool in a phase.');
        return false;
      }
      commit((draft) => {
        const poolId = newDirectorId('pool');
        draft.pools.push({
          id: poolId,
          phaseId: phase.id,
          name,
          teamIds,
          order: phase.poolIds.length + 1,
        });
        const targetPhase = draft.phases.find((entry) => entry.id === phase.id);
        if (targetPhase) targetPhase.poolIds.push(poolId);
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'format-changed',
          summary: `Added ${name}.`,
          entityId: poolId,
          details: { phaseId: phase.id, teamCount: teamIds.length },
        });
      });
      return true;
    },
    [commit],
  );

  const updatePool = useCallback(
    (poolId: DirectorId, changes: { name?: string; teamIds?: DirectorId[] }): boolean => {
      const snapshot = stateRef.current;
      const pool = snapshot.pools.find((entry) => entry.id === poolId);
      const phase = pool ? snapshot.phases.find((entry) => entry.id === pool.phaseId) : undefined;
      if (!pool || !phase) {
        setError('That pool is not in the current tournament.');
        return false;
      }
      if (phase.formatId !== snapshot.tournament?.formatId) {
        setError('That pool is not part of the current format.');
        return false;
      }
      const name = changes.name === undefined ? pool.name : changes.name.trim();
      if (!name) {
        setError('A pool name is required.');
        return false;
      }
      if (
        snapshot.pools.some(
          (candidate) =>
            candidate.id !== poolId &&
            candidate.phaseId === phase.id &&
            candidate.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
        )
      ) {
        setError(`Pool “${name}” already exists in this phase.`);
        return false;
      }
      const teamIds = changes.teamIds === undefined ? pool.teamIds : [...changes.teamIds];
      if (new Set(teamIds).size !== teamIds.length) {
        setError('A pool cannot contain the same team twice.');
        return false;
      }
      if (teamIds.some((teamId) => !snapshot.teams.some((team) => team.id === teamId))) {
        setError('A pool can only contain teams that exist in the tournament.');
        return false;
      }
      if (changes.teamIds !== undefined && phase.roundIds.length > 0) {
        setError('Pool membership is locked after a round has been generated; add a new phase instead.');
        return false;
      }
      if (changes.teamIds !== undefined) {
        const siblingTeamIds = new Set(
          snapshot.pools
            .filter((candidate) => candidate.phaseId === phase.id && candidate.id !== poolId)
            .flatMap((candidate) => candidate.teamIds),
        );
        if (teamIds.some((teamId) => siblingTeamIds.has(teamId))) {
          setError('Each team can belong to only one pool in a phase.');
          return false;
        }
      }
      commit((draft) => {
        const target = draft.pools.find((entry) => entry.id === poolId);
        if (!target) return;
        target.name = name;
        if (changes.teamIds !== undefined) target.teamIds = teamIds;
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'format-changed',
          summary: `Updated ${name}.`,
          entityId: poolId,
          details: { phaseId: phase.id, teamCount: teamIds.length },
        });
      });
      return true;
    },
    [commit],
  );

  const updateRules = useCallback(
    (changes: Partial<NonNullable<DirectorState['tournament']>['rules']>): boolean => {
      if (!stateRef.current.tournament) {
        setError('Create a tournament before editing scoring rules.');
        return false;
      }
      const validationError = validateDirectorRuleChanges(changes);
      if (validationError) {
        setError(validationError);
        return false;
      }
      commit((draft) => {
        if (!draft.tournament) return;
        draft.tournament.rules = {
          ...draft.tournament.rules,
          ...changes,
          ...(changes.tiebreakers ? { tiebreakers: [...changes.tiebreakers] } : {}),
        };
        draft.tournament.updatedAt = isoNow();
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'tournament-updated',
          summary: 'Tournament rules updated.',
          entityId: draft.tournament.id,
        });
      });
      return true;
    },
    [commit],
  );

  const selectPhase = useCallback(
    (phaseId: DirectorId) => {
      const snapshot = stateRef.current;
      const phase = snapshot.phases.find((entry) => entry.id === phaseId);
      if (!phase || phase.formatId !== snapshot.tournament?.formatId) {
        setError('That phase is not part of the current format.');
        return;
      }
      commit((draft) => {
        if (!draft.tournament) return;
        draft.tournament.currentPhaseId = phaseId;
        draft.tournament.updatedAt = isoNow();
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'format-changed',
          summary: `Selected ${phase.name} as the current phase.`,
          entityId: phaseId,
        });
      });
    },
    [commit],
  );

  const selectPacket = useCallback(
    (packetId: DirectorId) => {
      const packet = stateRef.current.packets.find((entry) => entry.id === packetId);
      if (!packet) {
        setError('That packet is not in the current inventory.');
        return;
      }
      commit((draft) => {
        if (!draft.tournament) return;
        draft.tournament.currentPacketId = packetId;
        draft.tournament.updatedAt = isoNow();
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'packet-changed',
          summary: `Selected ${packet.name} for the next generated round.`,
          entityId: packetId,
        });
      });
    },
    [commit],
  );

  const generateSchedule = useCallback(
    (options: { seed?: number; avoidRematches?: boolean; avoidSameOrganization?: boolean } = {}) => {
      const snapshot = stateRef.current;
      if (!snapshot.tournament)
        return { conflicts: ['Create a tournament before generating a schedule.'], generated: false };
      if (snapshot.teams.filter((team) => team.status === 'confirmed').length < 2) {
        return {
          conflicts: ['Add at least two confirmed teams before generating a schedule.'],
          generated: false,
        };
      }
      const generated = generateDirectorRound(snapshot, options);
      const conflicts = generated.conflicts.map((conflict) => conflict.message);
      if (generated.hardFailure) return { conflicts, generated: false };

      const generatedRound = structuredClone(generated.round);
      const generatedGames = structuredClone(generated.games);
      const snapshotPhase = snapshot.phases.find((entry) => entry.id === generatedRound.phaseId);
      if (!snapshotPhase || snapshot.tournament?.currentPhaseId !== snapshotPhase.id) {
        return {
          conflicts: [...conflicts, 'The current phase changed before the generated round could be saved.'],
          generated: false,
        };
      }
      commit((draft) => {
        const phase = draft.phases.find((entry) => entry.id === generatedRound.phaseId);
        if (!phase || draft.tournament?.currentPhaseId !== phase.id) return;
        draft.rounds.push(generatedRound);
        draft.scheduledGames.push(...generatedGames);
        phase.roundIds.push(generatedRound.id);
        phase.status = 'active';
        draft.tournament.currentRoundId = generatedRound.id;
        draft.tournament.updatedAt = isoNow();
        const packet = generatedRound.packetId
          ? draft.packets.find((entry) => entry.id === generatedRound.packetId)
          : undefined;
        if (packet) {
          if (!packet.assignedRoundIds.includes(generatedRound.id))
            packet.assignedRoundIds.push(generatedRound.id);
          for (const game of generatedGames) {
            if (!game.bye && !packet.assignedGameIds.includes(game.id)) packet.assignedGameIds.push(game.id);
          }
        }
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'schedule-generated',
          summary: `Generated ${generatedRound.name}.`,
          entityId: generatedRound.id,
          details: { conflicts },
        });
      });
      return { conflicts, generated: true };
    },
    [commit],
  );

  const prepareRound = useCallback(
    (roundId: DirectorId): boolean => {
      const snapshot = stateRef.current;
      const round = snapshot.rounds.find((entry) => entry.id === roundId);
      if (!round || round.status !== 'planned') {
        setError('Only a planned round can be prepared.');
        return false;
      }
      const games = snapshot.scheduledGames.filter((game) => game.roundId === roundId);
      if (games.length === 0 || !roundScheduleIsValid(snapshot, roundId)) {
        setError('This round cannot be prepared until every matchup is valid.');
        return false;
      }
      commit((draft) => {
        const target = draft.rounds.find((entry) => entry.id === roundId);
        if (!target || target.status !== 'planned') return;
        target.status = 'prepared';
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'schedule-repaired',
          summary: `Prepared ${target.name}.`,
          entityId: roundId,
        });
      });
      return true;
    },
    [commit],
  );

  const releaseRound = useCallback(
    (roundId: DirectorId): boolean => {
      const snapshot = stateRef.current;
      const round = snapshot.rounds.find((entry) => entry.id === roundId);
      if (!round || round.status !== 'prepared') {
        setError('Only a prepared round can be released.');
        return false;
      }
      const games = snapshot.scheduledGames.filter((game) => game.roundId === roundId);
      const activeGames = games.filter((game) => !game.bye && game.status !== 'cancelled');
      const roomIds = activeGames.map((game) => game.roomId);
      const duplicateRoom = roomIds.filter((roomId, index) => roomId && roomIds.indexOf(roomId) !== index)[0];
      const invalidRoom = activeGames.find((game) => {
        if (!game.roomId) return true;
        const room = snapshot.rooms.find((entry) => entry.id === game.roomId);
        return !room || !room.available || room.status !== 'available';
      });
      const roomIdsForRound = new Set(roomIds.filter((roomId): roomId is DirectorId => roomId !== null));
      const resourceIssues = roomAssignmentConflicts(snapshot, roomIdsForRound);
      if (
        !roundScheduleIsValid(snapshot, roundId) ||
        games.length === 0 ||
        roomIds.some((roomId) => roomId === null) ||
        duplicateRoom ||
        invalidRoom ||
        resourceIssues.length > 0
      ) {
        setError(
          resourceIssues[0]?.message ??
            (duplicateRoom
              ? 'A room can only host one game in a round.'
              : 'This round cannot be released until every game has a valid matchup and available room.'),
        );
        return false;
      }
      commit((draft) => {
        const round = draft.rounds.find((entry) => entry.id === roundId);
        if (!round || round.status !== 'prepared') return;
        round.status = 'released';
        round.startedAt ??= isoNow();
        const phase = draft.phases.find((entry) => entry.id === round.phaseId);
        if (phase) phase.status = 'active';
        if (draft.tournament) {
          draft.tournament.status = 'running';
          draft.tournament.currentRoundId = roundId;
          draft.tournament.updatedAt = isoNow();
        }
        draft.scheduledGames
          .filter((game) => game.roundId === roundId && game.status === 'scheduled')
          .forEach((game) => (game.status = 'released'));
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'assignment-released',
          summary: `Released ${round.name}.`,
          entityId: roundId,
        });
        // Releasing a round is QBTCP's delivery. Recording it as a transfer keeps the unified
        // history honest: "how did this room get its assignment" has one table with one answer,
        // whether that answer was the network, a stick, or both.
        recordQbtcpDelivery(draft, roundId);
      });
      return true;
    },
    [commit],
  );

  const closeRoundAction = useCallback(
    (roundId: DirectorId): boolean => {
      const snapshot = stateRef.current;
      const round = snapshot.rounds.find((entry) => entry.id === roundId);
      if (!round || round.status !== 'released') {
        setError('Only a released round can be closed.');
        return false;
      }
      if (!roundScheduleIsValid(snapshot, roundId)) {
        setError('This round contains an invalid matchup or round membership and cannot be closed.');
        return false;
      }
      const unresolved = snapshot.scheduledGames.some(
        (game) => game.roundId === roundId && !game.bye && !['accepted', 'cancelled'].includes(game.status),
      );
      if (unresolved) {
        setError('Every game must have an accepted result or be cancelled before the round closes.');
        return false;
      }
      commit((draft) => {
        const target = draft.rounds.find((entry) => entry.id === roundId);
        if (!target || target.status !== 'released') return;
        Object.assign(target, closeRound(target));
        const phase = draft.phases.find((entry) => entry.id === target.phaseId);
        if (
          phase &&
          phase.roundIds.every((id) => draft.rounds.find((entry) => entry.id === id)?.status === 'closed')
        ) {
          phase.status = 'complete';
        }
        if (
          draft.tournament &&
          draft.rounds.length > 0 &&
          draft.rounds.every((entry) => entry.status === 'closed')
        ) {
          draft.tournament.status = 'complete';
          draft.tournament.updatedAt = isoNow();
        }
        // Finished rooms are room-session state, not just a one-way flag after a live game.
        // Resetting finished rooms that remain marked available lets the next round reuse them
        // without loosening releaseRound's status === 'available' gate.
        const closingGameRoomIds = new Set(
          draft.scheduledGames
            .filter((game) => game.roundId === roundId && game.roomId)
            .map((game) => game.roomId as DirectorId),
        );
        for (const room of draft.rooms) {
          if (room.status === 'finished' && closingGameRoomIds.has(room.id)) {
            room.status = room.available ? 'available' : 'offline';
          }
        }
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'tournament-updated',
          summary: `Closed ${target.name}.`,
          entityId: roundId,
        });
      });
      return true;
    },
    [commit],
  );

  const cancelScheduledGame = useCallback(
    (scheduledGameId: DirectorId, reason = 'Cancelled by director'): boolean => {
      const snapshot = stateRef.current;
      const scheduled = snapshot.scheduledGames.find((game) => game.id === scheduledGameId);
      if (!scheduled) {
        setError('That scheduled game is no longer in the tournament workspace.');
        return false;
      }
      if (scheduled.bye) {
        setError('A bye does not need to be cancelled.');
        return false;
      }
      if (scheduled.status === 'cancelled') {
        setError('That scheduled game is already cancelled.');
        return false;
      }
      if (scheduled.status === 'accepted' || canonicalAcceptedGame(snapshot, scheduled.id)) {
        setError(
          'An accepted result cannot be cancelled; correct the result or retain it in the audit history.',
        );
        return false;
      }
      const normalizedReason = reason.trim() || 'Cancelled by director';
      commit((draft) => {
        const target = draft.scheduledGames.find((game) => game.id === scheduledGameId);
        if (!target || target.status === 'cancelled' || target.status === 'accepted') return;
        target.status = 'cancelled';
        for (const game of draft.games.filter((entry) => entry.scheduledGameId === scheduledGameId)) {
          if (game.status !== 'accepted') {
            game.status = 'cancelled';
            game.note = [game.note, `Scheduled game cancelled: ${normalizedReason}`]
              .filter(Boolean)
              .join(' · ');
          }
          for (const submission of draft.submissions.filter((entry) => entry.gameId === game.id)) {
            if (submission.status === 'received' || submission.status === 'review') {
              submission.status = 'rejected';
              submission.reason = `Scheduled game cancelled: ${normalizedReason}`;
            }
          }
        }
        const room = target.roomId ? draft.rooms.find((entry) => entry.id === target.roomId) : undefined;
        if (room?.status === 'finished') room.status = room.available ? 'available' : 'offline';
        if (room?.status === 'live') markRoomAvailableIfIdle(draft, room.id);
        const now = isoNow();
        draft.audit.push({
          id: newDirectorId('audit'),
          at: now,
          actor: 'Director',
          type: 'schedule-cancelled',
          summary: `Cancelled the game between ${target.leftTeamId} and ${target.rightTeamId ?? 'a bye'}.`,
          entityId: scheduledGameId,
          details: { reason: normalizedReason, roundId: target.roundId },
        });
      });
      return true;
    },
    [commit],
  );

  const addManualResult = useCallback(
    (input: ManualResultInput): boolean => {
      const snapshot = stateRef.current;
      const scheduled = snapshot.scheduledGames.find((game) => game.id === input.scheduledGameId);
      const playerStats = input.playerStats ?? [];
      const validationError = validateResultForScheduledGame(snapshot, scheduled, input.scores, playerStats);
      if (validationError) {
        setError(validationError);
        return false;
      }
      const detailedStatsError = validateDetailedStats(input.detailedStats, playerStats);
      if (detailedStatsError) {
        setError(detailedStatsError);
        return false;
      }
      if (scheduled && canonicalAcceptedGame(snapshot, scheduled.id)) {
        setError(
          'This scheduled game already has an accepted canonical result. Edit that result to correct it.',
        );
        return false;
      }
      commit((draft) => {
        const target = draft.scheduledGames.find((game) => game.id === input.scheduledGameId);
        if (!target || target.bye) return;
        const gameId = newDirectorId('game-record');
        const now = isoNow();
        const packetId = effectivePacketId(draft, target);
        const game: GameRecord = {
          id: gameId,
          scheduledGameId: target.id,
          roundId: target.roundId,
          packetId,
          status: 'accepted',
          scores: structuredClone(input.scores),
          playerStats: structuredClone(playerStats),
          source: 'manual',
          detailedStats: input.detailedStats ?? (playerStats.length > 0 ? 'incomplete' : 'unknown'),
          finishedAt: now,
          acceptedAt: now,
          note: input.note,
        };
        draft.games.push(game);
        target.status = 'accepted';
        markPacketUsed(draft, target.id, packetId);
        markRoomFinished(draft, target.roomId);
        const submission: ResultSubmission = {
          id: newDirectorId('submission'),
          gameId,
          receivedAt: now,
          fingerprint: fingerprintForScores(input.scores),
          status: 'accepted',
          rawSubmission: { source: 'manual', game: structuredClone(game) },
          acceptedBy: 'Director',
          acceptedAt: now,
        };
        draft.submissions.push(submission);
        draft.audit.push({
          id: newDirectorId('audit'),
          at: now,
          actor: 'Director',
          type: 'result-accepted',
          summary: `Accepted a manual result for ${gameId}.`,
          entityId: gameId,
          details: { scheduledGameId: target.id, detailedStats: game.detailedStats },
        });
      });
      return true;
    },
    [commit],
  );

  const associateSubmission = useCallback(
    (submissionId: DirectorId, scheduledGameId: DirectorId): boolean => {
      const snapshot = stateRef.current;
      const submission = snapshot.submissions.find((entry) => entry.id === submissionId);
      const game = submission ? snapshot.games.find((entry) => entry.id === submission.gameId) : undefined;
      const scheduled = snapshot.scheduledGames.find((entry) => entry.id === scheduledGameId);
      if (!submission || (submission.status !== 'received' && submission.status !== 'review') || !game) {
        setError('Only a result waiting for review can be associated.');
        return false;
      }
      if (!scheduled || scheduled.bye || scheduled.status === 'cancelled') {
        setError('Choose a non-bye scheduled game that has not been cancelled.');
        return false;
      }
      if (canonicalAcceptedGame(snapshot, scheduled.id) || scheduled.status === 'accepted') {
        setError('That scheduled game already has a canonical accepted result.');
        return false;
      }
      if (game.scheduledGameId === scheduled.id) {
        setError('This result is already associated with that scheduled game.');
        return false;
      }

      const rawSubmission = isRecordLike(submission.rawSubmission) ? submission.rawSubmission : undefined;
      const rawQbj = rawSubmission?.qbj ?? game.rawQbj;
      const parsed =
        rawQbj === undefined ? undefined : readResultStatisticsForAssociation(rawQbj, snapshot, scheduled);
      const warnings = new Set(
        (submission.warnings ?? []).filter(
          (warning) =>
            warning !== 'unknown-match' &&
            warning !== 'matched-by-teams' &&
            (warning !== ingestWarnings.statisticsWarning || parsed?.scores.length === 2),
        ),
      );
      for (const warning of parsed?.warnings ?? []) warnings.add(warning);
      if (!parsed || parsed.scores.length < 2) warnings.add(ingestWarnings.statisticsWarning);
      warnings.add(ingestWarnings.directorAssociation);

      commit((draft) => {
        const targetSubmission = draft.submissions.find((entry) => entry.id === submissionId);
        const targetGame = targetSubmission
          ? draft.games.find((entry) => entry.id === targetSubmission.gameId)
          : undefined;
        const targetScheduled = draft.scheduledGames.find((entry) => entry.id === scheduledGameId);
        if (!targetSubmission || !targetGame || !targetScheduled) return;
        targetGame.scheduledGameId = targetScheduled.id;
        targetGame.roundId = targetScheduled.roundId;
        targetGame.packetId = effectivePacketId(draft, targetScheduled);
        if (parsed?.scores.length === 2) targetGame.scores = structuredClone(parsed.scores);
        if (parsed) targetGame.playerStats = structuredClone(parsed.playerStats);
        targetGame.status = 'submitted';
        targetSubmission.status = 'review';
        targetSubmission.warnings = [...warnings];
        targetSubmission.reason = `Associated by Director with ${targetScheduled.id}; verify the retained review notes before accepting.`;
        if (isRecordLike(targetSubmission.rawSubmission)) {
          targetSubmission.rawSubmission = {
            ...targetSubmission.rawSubmission,
            association: 'director',
            associatedScheduledGameId: targetScheduled.id,
          };
        } else {
          targetSubmission.rawSubmission = {
            original: targetSubmission.rawSubmission,
            association: 'director',
            associatedScheduledGameId: targetScheduled.id,
          };
        }
        targetSubmission.conflictWith = undefined;
        targetScheduled.status = 'submitted';
        const artifact = draft.transfers.artifacts.find((entry) => entry.submissionId === submissionId);
        if (artifact) {
          artifact.scheduledGameId = targetScheduled.id;
          artifact.detail = targetSubmission.reason;
          artifact.warnings = [...warnings];
        }
        const now = isoNow();
        draft.audit.push({
          id: newDirectorId('audit'),
          at: now,
          actor: 'Director',
          type: 'result-edited',
          summary: `Associated result ${submissionId} with ${targetScheduled.id}.`,
          entityId: targetGame.id,
          details: {
            scheduledGameId: targetScheduled.id,
            positionalAssociation: parsed?.positionalAssociation ?? false,
          },
        });
      });
      return true;
    },
    [commit],
  );

  const acceptSubmission = useCallback(
    (submissionId: DirectorId, actor = 'Director'): boolean => {
      const snapshot = stateRef.current;
      const submission = snapshot.submissions.find((entry) => entry.id === submissionId);
      if (!submission || (submission.status !== 'received' && submission.status !== 'review')) return false;
      if (!actor.trim()) {
        setError('An accepting operator is required.');
        return false;
      }
      const game = snapshot.games.find((entry) => entry.id === submission.gameId);
      const scheduled = game
        ? snapshot.scheduledGames.find((entry) => entry.id === game.scheduledGameId)
        : undefined;
      const nativeAssociation = isRecordLike(submission.rawSubmission)
        ? submission.rawSubmission.association
        : undefined;
      if (!game || !scheduled || scheduled.bye) {
        setError(
          'An unmatched or bye result must remain in review until it is associated with a scheduled game.',
        );
        return false;
      }
      if (game.source === 'qbtcp' && nativeAssociation === 'unmatched') {
        setError('This unmatched QBTCP result is review-only until a director explicitly associates it.');
        return false;
      }
      const validationError = validateResultForScheduledGame(
        snapshot,
        scheduled,
        game.scores,
        game.playerStats,
      );
      if (validationError) {
        setError(validationError);
        return false;
      }
      const detailedStatsError = validateDetailedStats(game.detailedStats, game.playerStats);
      if (detailedStatsError) {
        setError(detailedStatsError);
        return false;
      }
      const canonical = canonicalAcceptedGame(snapshot, scheduled.id);
      if (canonical && canonical.id !== game.id) {
        setError('This scheduled game already has a canonical result; the new submission remains in review.');
        return false;
      }
      const currentSubmission = currentAcceptedSubmission(snapshot, game.id);
      if (currentSubmission && currentSubmission.id !== submissionId) {
        setError(
          'This game already has one accepted canonical submission; the new submission remains in review.',
        );
        return false;
      }
      const duplicate = snapshot.submissions.find(
        (entry) =>
          entry.id !== submissionId &&
          entry.status === 'accepted' &&
          entry.fingerprint === submission.fingerprint &&
          snapshot.games.find((candidate) => candidate.id === entry.gameId)?.scheduledGameId === scheduled.id,
      );
      if (duplicate) {
        setError('An identical result is already accepted for this scheduled game.');
        return false;
      }
      commit((draft) => {
        const target = draft.submissions.find((entry) => entry.id === submissionId);
        const targetGame = target ? draft.games.find((entry) => entry.id === target.gameId) : undefined;
        const targetScheduled = targetGame
          ? draft.scheduledGames.find((entry) => entry.id === targetGame.scheduledGameId)
          : undefined;
        if (
          !target ||
          !targetGame ||
          !targetScheduled ||
          targetScheduled.bye ||
          (canonicalAcceptedGame(draft, targetScheduled.id) &&
            canonicalAcceptedGame(draft, targetScheduled.id)?.id !== targetGame.id)
        ) {
          if (target && target.status !== 'accepted') {
            target.status = 'review';
            target.reason = 'A different accepted result is already canonical for this scheduled game.';
          }
          return;
        }
        const existingAccepted = draft.submissions.find(
          (entry) =>
            entry.id !== submissionId && entry.gameId === targetGame.id && entry.status === 'accepted',
        );
        if (existingAccepted) {
          const identical = target.fingerprint === existingAccepted.fingerprint;
          target.status = identical ? 'duplicate' : 'review';
          target.conflictWith = existingAccepted.id;
          target.reason = identical
            ? 'An identical accepted result already exists for this game.'
            : 'Only one accepted canonical submission is allowed for this game.';
          return;
        }
        const duplicate = draft.submissions.find(
          (entry) =>
            entry.id !== submissionId &&
            entry.status === 'accepted' &&
            entry.fingerprint === target.fingerprint &&
            draft.games.find((candidate) => candidate.id === entry.gameId)?.scheduledGameId ===
              targetScheduled.id,
        );
        if (duplicate) {
          target.status = 'duplicate';
          target.conflictWith = duplicate.id;
          target.reason = 'An identical accepted result already exists for this scheduled game.';
          return;
        }
        const acceptedAt = isoNow();
        target.status = 'accepted';
        target.acceptedBy = actor;
        target.acceptedAt = acceptedAt;
        targetGame.status = 'accepted';
        targetGame.acceptedAt = acceptedAt;
        targetGame.detailedStats ??= targetGame.playerStats.length > 0 ? 'incomplete' : 'unknown';
        targetScheduled.status = 'accepted';
        markPacketUsed(draft, targetScheduled.id, effectivePacketId(draft, targetScheduled));
        markRoomFinished(draft, targetScheduled.roomId);
        draft.audit.push({
          id: newDirectorId('audit'),
          at: acceptedAt,
          actor,
          type: 'result-accepted',
          summary: `Accepted result ${submissionId}.`,
          entityId: target.gameId,
          details: { scheduledGameId: targetScheduled.id },
        });
      });
      return true;
    },
    [commit],
  );

  const rejectSubmission = useCallback(
    (submissionId: DirectorId, reason = 'Rejected by director'): boolean => {
      const snapshot = stateRef.current;
      const submission = snapshot.submissions.find((entry) => entry.id === submissionId);
      if (!submission || (submission.status !== 'received' && submission.status !== 'review')) return false;
      commit((draft) => {
        const submission = draft.submissions.find((entry) => entry.id === submissionId);
        if (!submission || (submission.status !== 'received' && submission.status !== 'review')) return;
        submission.status = 'rejected';
        submission.reason = reason;
        const game = draft.games.find((entry) => entry.id === submission.gameId);
        const scheduled = game
          ? draft.scheduledGames.find((entry) => entry.id === game.scheduledGameId)
          : undefined;
        const accepted = scheduled ? canonicalAcceptedGame(draft, scheduled.id) : undefined;
        // A later QBTCP retry can be retained as a review submission on the current canonical
        // GameRecord. Rejecting that retry must not reject the accepted result it is attached to.
        const canReopen = Boolean(
          game && game.status !== 'accepted' && (!accepted || accepted.id === game.id),
        );
        if (canReopen && game) game.status = 'rejected';
        if (scheduled && canReopen) {
          const round = draft.rounds.find((entry) => entry.id === scheduled.roundId);
          scheduled.status = round?.status === 'released' ? 'released' : 'scheduled';
          if (game?.source === 'qbtcp') markRoomAvailable(draft, scheduled.roomId);
        }
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'result-edited',
          summary: `Rejected result ${submissionId}.`,
          entityId: submission.gameId,
          details: { reason, scheduledGameId: scheduled?.id },
        });
      });
      return true;
    },
    [commit],
  );

  const editAcceptedResult = useCallback(
    (gameId: DirectorId, scores: TeamGameScore[], note?: string): boolean => {
      const snapshot = stateRef.current;
      const game = snapshot.games.find((entry) => entry.id === gameId);
      const scheduled = game
        ? snapshot.scheduledGames.find((entry) => entry.id === game.scheduledGameId)
        : undefined;
      const validationError = validateResultForScheduledGame(
        snapshot,
        scheduled,
        scores,
        game?.playerStats ?? [],
      );
      if (validationError) {
        setError(validationError);
        return false;
      }
      if (
        !game ||
        game.status !== 'accepted' ||
        !scheduled ||
        canonicalAcceptedGame(snapshot, scheduled.id)?.id !== gameId
      ) {
        setError('Only the current canonical accepted result can be corrected.');
        return false;
      }
      commit((draft) => {
        applyAcceptedResultCorrection(draft, gameId, scores, note, 'Director', 'accepted-result-correction');
      });
      return true;
    },
    [commit],
  );

  const addProtest = useCallback(
    (
      gameId: DirectorId,
      description: string,
      category: 'tossup' | 'bonus' | 'procedure' | 'other' = 'other',
    ): boolean => {
      const snapshot = stateRef.current;
      const game = snapshot.games.find((entry) => entry.id === gameId);
      const scheduled = game
        ? snapshot.scheduledGames.find((entry) => entry.id === game.scheduledGameId)
        : undefined;
      if (
        !game ||
        game.status !== 'accepted' ||
        !scheduled ||
        !scheduled.rightTeamId ||
        canonicalAcceptedGame(snapshot, scheduled.id)?.id !== gameId
      ) {
        setError('A protest must target the current canonical accepted result for a two-team game.');
        return false;
      }
      if (!description.trim()) {
        setError('A protest description is required.');
        return false;
      }
      commit((draft) => {
        const protestId = newDirectorId('protest');
        const now = isoNow();
        draft.protests.push({
          id: protestId,
          gameId,
          category,
          description: description.trim(),
          status: 'open',
          createdAt: now,
          updatedAt: now,
        });
        draft.audit.push({
          id: newDirectorId('audit'),
          at: now,
          actor: 'Director',
          type: 'protest-created',
          summary: 'Created a protest.',
          entityId: protestId,
        });
      });
      return true;
    },
    [commit],
  );

  const ruleProtest = useCallback(
    (protestId: DirectorId, ruling: string, scoreAdjustment?: ProtestScoreAdjustment): boolean => {
      const rawAdjustment: unknown = scoreAdjustment;
      if (typeof rawAdjustment === 'number') {
        setError('A protest score correction must identify the team receiving the adjustment.');
        return false;
      }
      if (
        rawAdjustment !== undefined &&
        (!isRecordLike(rawAdjustment) ||
          typeof rawAdjustment.teamId !== 'string' ||
          typeof rawAdjustment.delta !== 'number' ||
          !Number.isFinite(rawAdjustment.delta) ||
          !Number.isInteger(rawAdjustment.delta) ||
          rawAdjustment.delta === 0)
      ) {
        setError('A protest score correction needs a non-zero finite team-specific delta.');
        return false;
      }
      const snapshot = stateRef.current;
      const protest = snapshot.protests.find((entry) => entry.id === protestId);
      if (!protest || protest.status !== 'open') {
        setError('Only an open protest can be ruled.');
        return false;
      }
      if (!ruling.trim()) {
        setError('A protest ruling is required.');
        return false;
      }
      const adjustment = rawAdjustment as ProtestScoreAdjustment | undefined;
      if (adjustment) {
        const protestGame = snapshot.games.find((entry) => entry.id === protest.gameId);
        const game = protestGame ? canonicalAcceptedGame(snapshot, protestGame.scheduledGameId) : undefined;
        const score = game?.scores.find((entry) => entry.teamId === adjustment.teamId);
        if (
          !game ||
          game.status !== 'accepted' ||
          !score ||
          !Number.isFinite(score.score + adjustment.delta)
        ) {
          setError('A protest correction must target a team in the current canonical accepted result.');
          return false;
        }
      }
      commit((draft) => {
        const target = draft.protests.find((entry) => entry.id === protestId);
        if (!target) return;
        let correctionSubmissionId: DirectorId | undefined;
        if (adjustment) {
          const protestGame = draft.games.find((entry) => entry.id === target.gameId);
          const game = protestGame ? canonicalAcceptedGame(draft, protestGame.scheduledGameId) : undefined;
          if (!game) return;
          const scores = structuredClone(game.scores);
          const score = scores.find((entry) => entry.teamId === adjustment.teamId);
          if (!score) return;
          score.score += adjustment.delta;
          correctionSubmissionId = applyAcceptedResultCorrection(
            draft,
            game.id,
            scores,
            `Protest ${protestId}: ${ruling.trim()}`,
            'Director',
            'protest-score-correction',
          );
          if (!correctionSubmissionId) return;
        }
        const now = isoNow();
        target.status = 'ruled';
        target.ruling = ruling.trim();
        target.scoreAdjustment = adjustment ? structuredClone(adjustment) : undefined;
        target.correctionSubmissionId = correctionSubmissionId;
        target.updatedAt = now;
        draft.audit.push({
          id: newDirectorId('audit'),
          at: now,
          actor: 'Director',
          type: 'protest-ruled',
          summary: 'Ruled on a protest.',
          entityId: protestId,
          details: { scoreAdjustment: adjustment, correctionSubmissionId },
        });
      });
      return true;
    },
    [commit],
  );

  const syncQbtcp = useCallback(() => {
    // The app polls every second. Do not allow a slow local-network read to overlap the next poll:
    // an older response could otherwise arrive after a newer one and reopen a cancelled help
    // request or apply stale operational metadata.
    if (qbtcpSyncInFlightRef.current) return qbtcpSyncInFlightRef.current;
    const task = (async () => {
      const read = await readNativeServerSnapshot();
      if (read.status === 'error') {
        setQbtcpHealth((previous) => ({ ...previous, error: read.message }));
        return;
      }
      const snapshot = read.snapshot;
      setQbtcpHealth({ lastSuccessfulAt: isoNow(), error: null });
      const next = structuredClone(stateRef.current);
      let changed = applyNativeSessions(next, snapshot.sessions);
      changed = applyNativePresence(next, snapshot) || changed;
      changed = applyNativeProgress(next, snapshot.progress) || changed;
      changed = applyNativeHelp(next, snapshot.help) || changed;
      changed = applyNativeRosterAmendments(next, snapshot.rosterAmendments) || changed;
      changed = applyNativeResults(next, snapshot) || changed;
      changed = expireQbtcpSessions(next) || changed;
      if (!changed) return;
      const revision = stateRevisionRef.current + 1;
      stateRevisionRef.current = revision;
      stateRef.current = next;
      setState(next);
      void persist(next, revision).catch(() => undefined);
    })();
    qbtcpSyncInFlightRef.current = task;
    void task.then(
      () => {
        if (qbtcpSyncInFlightRef.current === task) qbtcpSyncInFlightRef.current = null;
      },
      () => {
        if (qbtcpSyncInFlightRef.current === task) qbtcpSyncInFlightRef.current = null;
      },
    );
    return task;
  }, [persist]);

  const addTransferLocationAction = useCallback(
    (input: AddLocationInput) => commit((draft) => void addTransferLocation(draft, input)),
    [commit],
  );

  const removeTransferLocationAction = useCallback(
    (locationId: DirectorId) => commit((draft) => removeTransferLocation(draft, locationId)),
    [commit],
  );

  const setTransferWatchingAction = useCallback(
    (locationId: DirectorId, watching: boolean) =>
      commit((draft) => setTransferWatching(draft, locationId, watching)),
    [commit],
  );

  const syncTransferVolumesAction = useCallback(
    (volumes: TransferVolume[]) => {
      // Volume polling runs on a timer, so it must not write state on a tick where nothing moved:
      // a save per poll would rewrite the tournament document every few seconds all day.
      const next = structuredClone(stateRef.current);
      const changes = syncRemovableVolumes(next, volumes);
      if (changes.appeared.length === 0 && changes.disappeared.length === 0 && !changes.metadataChanged)
        return;
      const revision = stateRevisionRef.current + 1;
      stateRevisionRef.current = revision;
      stateRef.current = next;
      setState(next);
      // Polling metadata (label, read-only state, capacity and last-seen time) belongs in the live
      // component state immediately, but only connection inventory changes need a durable write.
      if (changes.appeared.length > 0 || changes.disappeared.length > 0) {
        void persist(next, revision).catch(() => undefined);
      }
    },
    [persist],
  );

  const noteTransferScanAction = useCallback(
    (locationId: DirectorId, outcome: { at: string; message?: string; found?: number }) =>
      commit((draft) => noteTransferScan(draft, locationId, outcome)),
    [commit],
  );

  const recordPreparedAssignmentsAction = useCallback(
    (input: RecordPreparedInput) => commit((draft) => recordPreparedAssignments(draft, input)),
    [commit],
  );

  const importTransferDocumentsAction = useCallback(
    (inputs: ImportInput[]) => {
      let summary: ImportSummary = {
        imported: 0,
        duplicates: 0,
        needsReview: 0,
        assignments: 0,
        invalid: 0,
        skipped: 0,
        classifications: [],
        messages: [],
      };
      commit((draft) => {
        summary = importTransferDocuments(draft, inputs);
      });
      return summary;
    },
    [commit],
  );

  const dismissTransferArtifactAction = useCallback(
    (artifactId: DirectorId) => commit((draft) => dismissTransferArtifact(draft, artifactId)),
    [commit],
  );

  const checkpoint = useCallback(
    async (reason: string) => {
      const next = structuredClone(stateRef.current);
      const now = isoNow();
      next.metadata.lastCheckpointAt = now;
      next.audit.push({
        id: newDirectorId('audit'),
        at: now,
        actor: 'Director',
        type: 'checkpoint-created',
        summary: `Created checkpoint: ${reason.trim() || 'manual checkpoint'}.`,
        details: { reason },
      });
      const revision = stateRevisionRef.current + 1;
      stateRevisionRef.current = revision;
      stateRef.current = next;
      setState(next);
      await enqueuePersistence(next, revision, async (persisted) => {
        persisted.metadata.lastSavedAt = isoNow();
        await repositoryRef.current.checkpoint(persisted, reason);
      });
    },
    [enqueuePersistence],
  );

  const exportSnapshot = useCallback(() => JSON.stringify(stateRef.current, null, 2), []);

  const importSnapshot = useCallback(
    (value: unknown) => {
      const candidate =
        value && typeof value === 'object' && 'state' in value ? (value as { state?: unknown }).state : value;
      let next: DirectorState;
      try {
        next = normalizeDirectorState(candidate);
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : 'The Director archive is not valid.');
        return false;
      }
      next.audit = [
        ...(next.audit ?? []),
        {
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'imported',
          summary: 'Imported a portable tournament archive.',
        },
      ];
      next.metadata = {
        ...(next.metadata ?? { lastSavedAt: null, lastCheckpointAt: null }),
        lastSavedAt: null,
      };
      const revision = stateRevisionRef.current + 1;
      stateRevisionRef.current = revision;
      stateRef.current = next;
      setState(next);
      void persist(next, revision).catch(() => undefined);
      return true;
    },
    [persist],
  );

  return {
    state,
    loading,
    saving,
    error,
    repositoryKind,
    createTournament,
    updateTournament,
    addTeam,
    updateTeam,
    dropTeam,
    restoreTeam,
    addPlayer,
    updatePlayer,
    removePlayer,
    addRoom,
    updateRoom,
    addStaff,
    updateStaff,
    addEquipment,
    updateEquipment,
    addPacket,
    addPackets,
    updatePacket,
    addImportedTeams,
    selectPhase,
    selectPacket,
    updateFormat,
    addPhase,
    updatePhase,
    addPool,
    updatePool,
    updateRules,
    generateSchedule,
    prepareRound,
    releaseRound,
    closeRound: closeRoundAction,
    cancelScheduledGame,
    addManualResult,
    associateSubmission,
    acceptSubmission,
    rejectSubmission,
    editAcceptedResult,
    addProtest,
    ruleProtest,
    syncQbtcp,
    qbtcpHealth,
    addTransferLocation: addTransferLocationAction,
    removeTransferLocation: removeTransferLocationAction,
    setTransferWatching: setTransferWatchingAction,
    syncTransferVolumes: syncTransferVolumesAction,
    noteTransferScan: noteTransferScanAction,
    recordPreparedAssignments: recordPreparedAssignmentsAction,
    importTransferDocuments: importTransferDocumentsAction,
    dismissTransferArtifact: dismissTransferArtifactAction,
    checkpoint,
    exportSnapshot,
    importSnapshot,
  };
}

function fingerprintForScores(scores: TeamGameScore[]): string {
  return scores
    .map((score) =>
      [
        score.teamId,
        score.score,
        score.powers,
        score.gets,
        score.negs,
        score.bonuses,
        score.bonusPoints,
        score.bouncebacks,
      ]
        .map((value) => String(value))
        .join('\u001f'),
    )
    .sort()
    .join('\u001e');
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRosterNumber(value: string | number | undefined): string | number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function validateResultForScheduledGame(
  state: DirectorState,
  scheduled: ScheduledGame | undefined,
  scores: TeamGameScore[],
  playerStats: PlayerGameStat[],
): string | null {
  if (!scheduled) return 'The selected scheduled game does not exist.';
  if (scheduled.bye) return 'A bye cannot receive a game result.';
  if (scheduled.status === 'cancelled') return 'A cancelled scheduled game cannot receive a game result.';
  if (!scheduled.rightTeamId) return 'The scheduled game is missing its opponent.';
  if (!Array.isArray(scores) || scores.length !== 2) {
    return 'A result must contain exactly one score for each assigned team.';
  }
  const expected = new Set([scheduled.leftTeamId, scheduled.rightTeamId]);
  const scoreTeamIds = scores.map((score) => score?.teamId);
  if (
    scoreTeamIds.some((teamId) => typeof teamId !== 'string' || !expected.has(teamId)) ||
    new Set(scoreTeamIds).size !== 2
  ) {
    return 'A result must contain exactly the two teams assigned to the scheduled game.';
  }
  const countFields: Array<keyof Omit<TeamGameScore, 'teamId' | 'score'>> = [
    'powers',
    'gets',
    'negs',
    'bonuses',
    'bonusPoints',
    'bouncebacks',
  ];
  for (const score of scores) {
    if (!score || typeof score !== 'object') {
      return 'Each result score must be a team score object.';
    }
    if (!Number.isInteger(score.score) || !Number.isFinite(score.score)) {
      return 'Final team scores must be finite whole numbers; negative totals are allowed.';
    }
    if (!state.teams.some((team) => team.id === score.teamId)) {
      return 'A result references a team that is not in this tournament.';
    }
    for (const field of countFields) {
      if (!Number.isInteger(score[field]) || !Number.isFinite(score[field]) || score[field] < 0) {
        return `${field} must be a finite non-negative whole number.`;
      }
    }
  }
  if (!Array.isArray(playerStats)) return 'Detailed player statistics must be an array when supplied.';
  const playerIds = new Set<string>();
  for (const stat of playerStats) {
    if (!stat || typeof stat !== 'object') return 'Each player statistic must be a player stat object.';
    if (playerIds.has(stat.playerId)) return 'A result cannot contain duplicate player statistics.';
    playerIds.add(stat.playerId);
    if (!expected.has(stat.teamId)) return 'Player statistics must belong to a team in the scheduled game.';
    const player = state.players.find((candidate) => candidate.id === stat.playerId);
    if (!player || player.teamId !== stat.teamId)
      return 'Player statistics must reference the player roster for that team.';
    const playerFields: Array<keyof Omit<PlayerGameStat, 'playerId' | 'teamId' | 'tossupsHeard'>> = [
      'powers',
      'gets',
      'negs',
      'bonusPoints',
    ];
    for (const field of playerFields) {
      if (!Number.isInteger(stat[field]) || !Number.isFinite(stat[field]) || stat[field] < 0) {
        return `Player ${field} must be a finite non-negative whole number.`;
      }
    }
    if (
      stat.tossupsHeard !== null &&
      (!Number.isInteger(stat.tossupsHeard) || !Number.isFinite(stat.tossupsHeard) || stat.tossupsHeard < 0)
    ) {
      return 'Player tossups heard must be a non-negative whole number or unknown.';
    }
  }
  return null;
}

function validateDetailedStats(
  status: DetailedStatsStatus | undefined,
  playerStats: readonly PlayerGameStat[],
): string | null {
  if (status !== undefined && status !== 'complete' && status !== 'incomplete' && status !== 'unknown') {
    return 'Detailed statistics must be marked complete, incomplete, or unknown.';
  }
  if (status === 'complete' && playerStats.length === 0) {
    return 'Detailed statistics cannot be marked complete without player statistics.';
  }
  if (status === 'complete' && playerStats.some((stat) => stat.tossupsHeard === null)) {
    return 'Detailed statistics cannot be marked complete when tossups heard is unknown.';
  }
  return null;
}

function canonicalAcceptedGame(state: DirectorState, scheduledGameId: DirectorId): GameRecord | undefined {
  const candidates = state.games.filter((game) => {
    return game.scheduledGameId === scheduledGameId && game.status === 'accepted';
  });
  // Corrected results retain their historical GameRecord/submission. Prefer the record with a
  // current accepted submission over legacy accepted records that predate the submission ledger.
  const withCurrentSubmission = candidates.filter((game) => currentAcceptedSubmission(state, game.id));
  const eligible = withCurrentSubmission.length > 0 ? withCurrentSubmission : candidates;
  return [...eligible]
    .sort((left, right) => {
      const leftSubmission = currentAcceptedSubmission(state, left.id);
      const rightSubmission = currentAcceptedSubmission(state, right.id);
      const leftAt = leftSubmission?.acceptedAt ?? leftSubmission?.receivedAt ?? left.acceptedAt ?? '';
      const rightAt = rightSubmission?.acceptedAt ?? rightSubmission?.receivedAt ?? right.acceptedAt ?? '';
      return leftAt.localeCompare(rightAt) || left.id.localeCompare(right.id);
    })
    .at(-1);
}

function currentAcceptedSubmission(state: DirectorState, gameId: DirectorId): ResultSubmission | undefined {
  return state.submissions
    .filter((submission) => submission.gameId === gameId && submission.status === 'accepted')
    .sort(
      (left, right) =>
        (left.acceptedAt ?? left.receivedAt).localeCompare(right.acceptedAt ?? right.receivedAt) ||
        left.id.localeCompare(right.id),
    )
    .at(-1);
}

function effectivePacketId(state: DirectorState, scheduled: ScheduledGame): DirectorId | null {
  return scheduled.packetId ?? state.rounds.find((round) => round.id === scheduled.roundId)?.packetId ?? null;
}

function markPacketUsed(
  state: DirectorState,
  scheduledGameId: DirectorId,
  packetId: DirectorId | null,
): void {
  if (!packetId) return;
  const packet = state.packets.find((entry) => entry.id === packetId);
  if (packet && !packet.usedGameIds.includes(scheduledGameId)) packet.usedGameIds.push(scheduledGameId);
}

function markRoomFinished(state: DirectorState, roomId: DirectorId | null): void {
  if (!roomId) return;
  const room = state.rooms.find((entry) => entry.id === roomId);
  if (room) room.status = 'finished';
}

function markRoomAvailable(state: DirectorState, roomId: DirectorId | null): void {
  if (!roomId) return;
  const room = state.rooms.find((entry) => entry.id === roomId);
  if (room && room.status !== 'offline') room.status = 'available';
}

function applyAcceptedResultCorrection(
  state: DirectorState,
  gameId: DirectorId,
  scores: TeamGameScore[],
  note: string | undefined,
  actor: string,
  reason: string,
): DirectorId | undefined {
  const game = state.games.find((entry) => entry.id === gameId);
  if (!game || game.status !== 'accepted') return undefined;
  const scheduled = state.scheduledGames.find((entry) => entry.id === game.scheduledGameId);
  if (!scheduled || scheduled.bye || canonicalAcceptedGame(state, scheduled.id)?.id !== gameId)
    return undefined;
  const previous = structuredClone(game);
  const now = isoNow();
  const replacementId = newDirectorId('submission');
  const previousAccepted = state.submissions.filter(
    (submission) => submission.gameId === gameId && submission.status === 'accepted',
  );
  const previousSubmission = currentAcceptedSubmission(state, gameId);
  for (const submission of previousAccepted) {
    submission.status = 'superseded';
    submission.supersededBySubmissionId = replacementId;
  }
  game.scores = structuredClone(scores);
  game.status = 'accepted';
  game.acceptedAt = now;
  game.note = note ?? game.note;
  game.packetId = effectivePacketId(state, scheduled);
  game.detailedStats ??= game.playerStats.length > 0 ? 'incomplete' : 'unknown';
  scheduled.status = 'accepted';
  markPacketUsed(state, scheduled.id, game.packetId);
  state.submissions.push({
    id: replacementId,
    gameId,
    receivedAt: now,
    fingerprint: fingerprintForScores(scores),
    status: 'accepted',
    rawSubmission: {
      correctionReason: reason,
      editedFrom: previous,
      scores: structuredClone(scores),
    },
    acceptedBy: actor,
    acceptedAt: now,
    supersedesSubmissionId: previousSubmission?.id ?? previousAccepted.at(-1)?.id,
  });
  state.audit.push({
    id: newDirectorId('audit'),
    at: now,
    actor,
    type: 'result-edited',
    summary: `Corrected the canonical result for ${gameId}.`,
    entityId: gameId,
    details: {
      reason,
      scheduledGameId: scheduled.id,
      supersededSubmissionIds: previousAccepted.map((submission) => submission.id),
      replacementSubmissionId: replacementId,
      previousScores: previous.scores,
      correctedScores: scores,
    },
  });
  return replacementId;
}

function expireQbtcpSessions(state: DirectorState): boolean {
  const staleAfterMs = 2 * 60 * 1000;
  const now = Date.now();
  let changed = false;
  // A session is an audit/recovery record, not a cache. Keep it even when its room is removed or
  // unavailable; only an actually stale live session transitions to abandoned.
  for (const session of state.qbtcpSessions) {
    const lastSeen = Date.parse(session.lastSeenAt);
    if (session.state !== 'live' || (Number.isFinite(lastSeen) && now - lastSeen <= staleAfterMs)) continue;
    session.state = 'abandoned';
    session.progress = null;
    session.resumable = true;
    changed = true;
    markRoomAvailableIfIdle(state, session.roomId);
  }
  return changed;
}

function markRoomAvailableIfIdle(state: DirectorState, roomId: DirectorId): boolean {
  const room = state.rooms.find((entry) => entry.id === roomId);
  if (!room || room.status !== 'live') return false;
  const anotherLiveSession = state.qbtcpSessions.some(
    (candidate) => candidate.roomId === roomId && candidate.state === 'live',
  );
  const liveGame = state.scheduledGames.some((game) => game.roomId === roomId && game.status === 'live');
  const openHelp = state.qbtcpHelpRequests.some(
    (request) => request.roomId === roomId && request.status === 'open',
  );
  if (anotherLiveSession || liveGame || openHelp) return false;
  room.status = room.available ? 'available' : 'offline';
  return true;
}

function applyNativeSessions(state: DirectorState, records: NativeSessionSnapshot[]): boolean {
  let changed = false;
  for (const record of records) {
    const session = state.qbtcpSessions.find((entry) => entry.sessionId === record.sessionId);
    const nextState = nativeSessionState(record, session?.state);
    if (!session) {
      state.qbtcpSessions.push({
        roomId: record.roomId,
        sessionId: record.sessionId,
        matchId: record.matchId,
        deviceId: record.deviceId ?? '',
        operatorName: record.operatorName,
        state: nextState,
        resumable:
          nextState === 'abandoned' ? true : nextState === 'result-received' ? false : record.resumable,
        resultReceived: record.resultReceived || nextState === 'result-received',
        progressSequence: record.progressSequence,
        lastSeenAt: record.updatedAt,
        progress: null,
        helpRequestId: null,
      });
      changed = true;
      if (nextState === 'abandoned') markRoomAvailableIfIdle(state, record.roomId);
      continue;
    }
    const lastSeenAt = newerTimestamp(session.lastSeenAt, record.updatedAt)
      ? record.updatedAt
      : session.lastSeenAt;
    const nextProgressSequence = Math.max(session.progressSequence ?? -1, record.progressSequence ?? -1);
    const nextResultReceived = Boolean(session.resultReceived || record.resultReceived);
    if (
      session.roomId !== record.roomId ||
      session.matchId !== (record.matchId ?? session.matchId) ||
      session.deviceId !== (record.deviceId ?? session.deviceId) ||
      session.operatorName !== (record.operatorName ?? session.operatorName) ||
      session.state !== nextState ||
      session.resumable !==
        (nextState === 'abandoned' ? true : nextState === 'result-received' ? false : record.resumable) ||
      session.resultReceived !== nextResultReceived ||
      session.progressSequence !== (nextProgressSequence < 0 ? undefined : nextProgressSequence) ||
      session.lastSeenAt !== lastSeenAt
    ) {
      session.roomId = record.roomId || session.roomId;
      session.matchId = record.matchId ?? session.matchId;
      session.deviceId = record.deviceId ?? session.deviceId;
      session.operatorName = record.operatorName ?? session.operatorName;
      session.state = nextState;
      session.resumable =
        nextState === 'abandoned' ? true : nextState === 'result-received' ? false : record.resumable;
      session.resultReceived = nextResultReceived;
      session.progressSequence = nextProgressSequence < 0 ? undefined : nextProgressSequence;
      session.lastSeenAt = lastSeenAt;
      changed = true;
    }
    if ((nextState === 'abandoned' || nextState === 'result-received') && session.progress !== null) {
      session.progress = null;
      changed = true;
    }
    if (nextState === 'abandoned' && markRoomAvailableIfIdle(state, session.roomId)) changed = true;
  }
  return changed;
}

function nativeSessionState(
  record: NativeSessionSnapshot,
  current: DirectorState['qbtcpSessions'][number]['state'] | undefined,
): DirectorState['qbtcpSessions'][number]['state'] {
  if (record.resultReceived || record.status === 'final-received') return 'result-received';
  if (record.status === 'abandoned') return current === 'result-received' ? current : 'abandoned';
  if (current === 'result-received' || current === 'abandoned') return current;
  return current ?? 'paired';
}

function applyNativePresence(state: DirectorState, snapshot: NativeServerSnapshot): boolean {
  let changed = false;
  for (const presence of snapshot.presence) {
    const existing = presence.sessionId
      ? state.qbtcpSessions.find((session) => session.sessionId === presence.sessionId)
      : (state.qbtcpSessions.find(
          (session) => session.roomId === presence.roomId && session.deviceId === presence.deviceId,
        ) ??
        (() => {
          // Older native snapshots may emit presence before the session snapshot is visible. A
          // single unnamed session in the room is safe to reconcile; multiple candidates must
          // remain unresolved rather than assigning one device to another session.
          const candidates = state.qbtcpSessions.filter(
            (session) => session.roomId === presence.roomId && !session.deviceId,
          );
          return candidates.length === 1 ? candidates[0] : undefined;
        })());
    // Presence without a server-issued session id cannot be safely joined to a session. Do not
    // invent an identity that would later duplicate the real session.
    if (!existing && !presence.sessionId) continue;
    const session = existing ?? {
      roomId: presence.roomId,
      sessionId: presence.sessionId as string,
      deviceId: presence.deviceId,
      state: 'paired' as const,
      lastSeenAt: presence.observedAt,
      progress: null,
      helpRequestId: null,
    };
    if (!existing) {
      state.qbtcpSessions.push(session);
      changed = true;
    }
    const terminal = session.state === 'result-received' || session.state === 'abandoned';
    const nextState =
      !terminal && presence.update.ready === true && session.state === 'paired' ? 'assigned' : session.state;
    const lastSeenAt = newerTimestamp(session.lastSeenAt, presence.observedAt)
      ? presence.observedAt
      : session.lastSeenAt;
    if (
      session.roomId !== presence.roomId ||
      session.deviceId !== presence.deviceId ||
      (presence.operatorName !== undefined && session.operatorName !== presence.operatorName) ||
      session.lastSeenAt !== lastSeenAt ||
      session.state !== nextState
    ) {
      session.roomId = presence.roomId;
      session.deviceId = presence.deviceId;
      if (presence.operatorName !== undefined) session.operatorName = presence.operatorName;
      session.lastSeenAt = lastSeenAt;
      session.state = nextState;
      changed = true;
    }
  }
  return changed;
}

function applyNativeProgress(state: DirectorState, records: NativeProgressSnapshot[]): boolean {
  let changed = false;
  for (const record of records) {
    let session = state.qbtcpSessions.find((entry) => entry.sessionId === record.sessionId);
    if (session && (session.state === 'result-received' || session.state === 'abandoned')) continue;
    const sequence = Number.isInteger(record.sequence) && record.sequence >= 0 ? record.sequence : 0;
    if (session && sequence <= (session.progressSequence ?? -1)) continue;
    const summary = progressSummary(record.matchState);
    if (!session) {
      session = {
        roomId: record.roomId,
        sessionId: record.sessionId,
        deviceId: '',
        state: 'live',
        lastSeenAt: record.receivedAt,
        progressSequence: sequence,
        progress: summary,
        helpRequestId: null,
      };
      state.qbtcpSessions.push(session);
      changed = true;
    } else {
      session.roomId = record.roomId;
      session.lastSeenAt = newerTimestamp(session.lastSeenAt, record.receivedAt)
        ? record.receivedAt
        : session.lastSeenAt;
      session.state = 'live';
      session.progressSequence = sequence;
      session.progress = summary;
      changed = true;
    }
    const room = state.rooms.find((entry) => entry.id === record.roomId);
    if (room && room.status !== 'live' && room.status !== 'help') {
      room.status = 'live';
      changed = true;
    }
  }
  return changed;
}

function applyNativeHelp(state: DirectorState, records: NativeHelpSnapshot[]): boolean {
  let changed = false;
  const snapshotRequestIds = new Set(records.map((record) => record.id));
  const openHelpRooms = new Set(
    records.filter((record) => record.status === 'open').map((record) => record.roomId),
  );
  // Help state is maintained by the native server and is not durable across a server restart. If
  // a persisted Director request is absent from the authoritative snapshot, close its local copy
  // and release the room/session link instead of leaving the operations page stuck on an alert
  // that the current server can no longer service.
  for (const request of state.qbtcpHelpRequests) {
    if (request.status !== 'open' || snapshotRequestIds.has(request.id)) continue;
    request.status = 'cancelled';
    request.updatedAt = isoNow();
    changed = true;
    const session = state.qbtcpSessions.find((entry) => entry.helpRequestId === request.id);
    if (session) {
      session.helpRequestId = null;
      changed = true;
    }
    if (restoreRoomStatusAfterHelp(state, request.roomId)) changed = true;
  }
  for (const record of records) {
    const current = state.qbtcpHelpRequests.find((request) => request.id === record.id);
    const next = {
      id: record.id,
      roomId: record.roomId,
      roomName: record.roomName,
      category: record.category,
      message: record.message,
      ...(record.currentMatchup ? { currentMatchup: structuredClone(record.currentMatchup) } : {}),
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      deviceId: record.deviceId,
      operatorName: record.operatorName,
    };
    if (!current) {
      state.qbtcpHelpRequests.push(next);
      changed = true;
    } else if (JSON.stringify(current) !== JSON.stringify(next)) {
      Object.assign(current, next);
      changed = true;
    }
    if (record.status === 'open') {
      const room = state.rooms.find((entry) => entry.id === record.roomId);
      if (room && room.status !== 'help') {
        room.status = 'help';
        changed = true;
      }
    } else if (!openHelpRooms.has(record.roomId) && restoreRoomStatusAfterHelp(state, record.roomId)) {
      changed = true;
    }
    const session = state.qbtcpSessions.find(
      (entry) => entry.roomId === record.roomId && entry.deviceId === record.deviceId,
    );
    if (session && session.helpRequestId !== (record.status === 'open' ? record.id : null)) {
      session.helpRequestId = record.status === 'open' ? record.id : null;
      changed = true;
    }
  }
  return changed;
}

function applyNativeRosterAmendments(
  state: DirectorState,
  records: NativeRosterAmendmentSnapshot[],
): boolean {
  let changed = false;
  for (const record of records) {
    const exists = state.qbtcpRosterAmendments.some(
      (entry) =>
        entry.sessionId === record.sessionId &&
        JSON.stringify(entry.amendment) === JSON.stringify(record.amendment),
    );
    if (!exists) {
      state.qbtcpRosterAmendments.push({
        sessionId: record.sessionId,
        amendment: structuredClone(record.amendment),
      });
      const playerId = stringValue(record.amendment.playerId);
      const teamId = stringValue(record.amendment.teamId);
      const knownPlayer = playerId ? state.players.find((player) => player.id === playerId) : undefined;
      const knownTeam = teamId ? state.teams.find((team) => team.id === teamId) : undefined;
      state.audit.push({
        id: newDirectorId('audit'),
        at: isoNow(),
        actor: 'QBTCP',
        type: 'roster-amendment',
        summary: `Received a roster amendment for ${stringValue(record.amendment.playerName) ?? 'an unrecognized player'}.`,
        entityId: knownPlayer?.id ?? knownTeam?.id ?? record.sessionId,
        details: {
          sessionId: record.sessionId,
          amendment: structuredClone(record.amendment),
          reviewRequired: true,
          matchedPlayerId: knownPlayer?.id,
          matchedTeamId: knownTeam?.id,
        },
      });
      changed = true;
    }
  }
  return changed;
}

function restoreRoomStatusAfterHelp(state: DirectorState, roomId: DirectorId): boolean {
  const room = state.rooms.find((entry) => entry.id === roomId);
  if (!room || room.status !== 'help') return false;
  const liveSession = state.qbtcpSessions.some(
    (session) => session.roomId === roomId && session.state === 'live',
  );
  const liveGame = state.scheduledGames.some((game) => game.roomId === roomId && game.status === 'live');
  const finishedGame = state.scheduledGames.some(
    (game) => game.roomId === roomId && ['accepted', 'cancelled'].includes(game.status),
  );
  room.status =
    liveSession || liveGame ? 'live' : finishedGame ? 'finished' : room.available ? 'available' : 'offline';
  return true;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isPhaseKind(value: unknown): value is NonNullable<DirectorState['phases'][number]>['kind'] {
  return (
    value === 'preliminary' ||
    value === 'playoff' ||
    value === 'final' ||
    value === 'placement' ||
    value === 'custom'
  );
}

function isDirectorTiebreaker(
  value: unknown,
): value is NonNullable<DirectorState['tournament']>['rules']['tiebreakers'][number] {
  return (
    value === 'head-to-head' ||
    value === 'record' ||
    value === 'points' ||
    value === 'margin' ||
    value === 'powers' ||
    value === 'gets' ||
    value === 'playoff'
  );
}

function validateAdvancementRule(value: AdvancementRule | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!isRecordLike(value)) return 'Advancement settings are not valid.';
  if (!Number.isInteger(value.qualifiersPerPool) || value.qualifiersPerPool < 1) {
    return 'Qualifiers per pool must be a positive whole number.';
  }
  if (!Array.isArray(value.tiebreakers) || value.tiebreakers.length === 0) {
    return 'Advancement needs at least one standings tiebreaker.';
  }
  if (!value.tiebreakers.every(isDirectorTiebreaker)) {
    return 'Advancement contains an unsupported standings tiebreaker.';
  }
  if (new Set(value.tiebreakers).size !== value.tiebreakers.length) {
    return 'Advancement tiebreakers must not be repeated.';
  }
  if (typeof value.manualOverrideAllowed !== 'boolean') {
    return 'Manual advancement override must be enabled or disabled explicitly.';
  }
  return null;
}

function validateDirectorRuleChanges(
  changes: Partial<NonNullable<DirectorState['tournament']>['rules']>,
): string | null {
  if (
    changes.tossupValue !== undefined &&
    (!Number.isFinite(changes.tossupValue) || changes.tossupValue <= 0)
  ) {
    return 'Tossup value must be a finite positive number.';
  }
  if (changes.powerValue !== undefined && (!Number.isFinite(changes.powerValue) || changes.powerValue <= 0)) {
    return 'Power value must be a finite positive number.';
  }
  if (changes.negValue !== undefined && (!Number.isFinite(changes.negValue) || changes.negValue > 0)) {
    return 'Neg value must be a finite number of zero or less.';
  }
  if (changes.bonusValue !== undefined && (!Number.isFinite(changes.bonusValue) || changes.bonusValue < 0)) {
    return 'Bonus value must be a finite non-negative number.';
  }
  if (
    changes.tossupCount !== undefined &&
    (!Number.isInteger(changes.tossupCount) || changes.tossupCount < 1)
  ) {
    return 'Tossups must be a positive whole number.';
  }
  if (changes.bonusParts !== undefined && (!Number.isInteger(changes.bonusParts) || changes.bonusParts < 1)) {
    return 'Bonus parts must be a positive whole number.';
  }
  if (
    changes.maximumActivePlayers !== undefined &&
    (!Number.isInteger(changes.maximumActivePlayers) || changes.maximumActivePlayers < 1)
  ) {
    return 'Maximum active players must be a positive whole number.';
  }
  if (
    changes.regulationMinutes !== undefined &&
    (!Number.isFinite(changes.regulationMinutes) || changes.regulationMinutes <= 0)
  ) {
    return 'Regulation minutes must be a finite positive number.';
  }
  if (changes.tiebreakers !== undefined) {
    if (changes.tiebreakers.length === 0) return 'Configure at least one standings tiebreaker.';
    if (!changes.tiebreakers.every(isDirectorTiebreaker)) {
      return 'Tiebreakers contain an unsupported standings criterion.';
    }
    if (new Set(changes.tiebreakers).size !== changes.tiebreakers.length) {
      return 'Tiebreakers must not be repeated.';
    }
  }
  return null;
}

function markNativeSessionResult(
  state: DirectorState,
  snapshot: NativeServerSnapshot,
  sessionId: string,
  scheduled: ScheduledGame | undefined,
  now: string,
): void {
  const nativeSession = snapshot.sessions.find((entry) => entry.sessionId === sessionId);
  const progress = snapshot.progress.find((entry) => entry.sessionId === sessionId);
  const session = state.qbtcpSessions.find((entry) => entry.sessionId === sessionId);
  if (!session) {
    state.qbtcpSessions.push({
      roomId: nativeSession?.roomId ?? progress?.roomId ?? scheduled?.roomId ?? '',
      sessionId,
      matchId: nativeSession?.matchId,
      deviceId: nativeSession?.deviceId ?? '',
      operatorName: nativeSession?.operatorName,
      state: 'result-received',
      resumable: false,
      resultReceived: true,
      progressSequence: nativeSession?.progressSequence ?? progress?.sequence,
      lastSeenAt: now,
      progress: null,
      helpRequestId: null,
    });
  } else {
    session.state = 'result-received';
    session.resultReceived = true;
    session.resumable = false;
    session.progress = null;
    session.matchId = nativeSession?.matchId ?? session.matchId;
    session.lastSeenAt = now;
    if (progress && progress.sequence > (session.progressSequence ?? -1)) {
      session.progressSequence = progress.sequence;
    }
  }
  if (scheduled?.roomId) {
    const room = state.rooms.find((entry) => entry.id === scheduled.roomId);
    if (room && room.status !== 'finished') room.status = 'finished';
  }
}

/**
 * Fold QBTCP arrivals into the same pipeline every other transport uses.
 *
 * This function used to do its own matching, its own score extraction and its own duplicate check.
 * It does none of those now: it turns a `NativeResultSnapshot` into an `IncomingDocument` and hands
 * it to `assessIncomingDocument`, which is the same call a USB scan and a dropped file make. A
 * QBTCP result and its later USB backup therefore compare on the same fingerprint, computed the
 * same way, and the duplicate is recognised rather than accepted twice.
 *
 * The transport's own result id and warnings ride along for correlation with the server's log. They
 * do not decide anything; the assessment does.
 */
function applyNativeResults(state: DirectorState, snapshot: NativeServerSnapshot): boolean {
  let changed = false;
  for (const result of snapshot.results) {
    if (state.submissions.some((submission) => submission.transportResultId === result.id)) continue;
    const qbj = result.qbj ?? decodeRawQbj(result.rawBase64);
    const progress = snapshot.progress.find((entry) => entry.sessionId === result.sessionId);
    const nativeSession = snapshot.sessions.find((entry) => entry.sessionId === result.sessionId);
    const roomId = progress?.roomId ?? nativeSession?.roomId ?? '';
    const roomName = state.rooms.find((entry) => entry.id === roomId)?.name;
    const document: IncomingDocument = {
      sourceKind: 'qbtcp',
      sourceLabel: roomName ? `${roomName} (QBTCP)` : 'QBTCP',
      fileName: `${result.id}.qbj`,
      byteLength: result.rawBase64 ? Math.ceil((result.rawBase64.length * 3) / 4) : 0,
      digest: `qbtcp-${result.id}`,
      qbj,
      transportResultId: result.id,
      sessionId: result.sessionId,
      transportWarnings: result.warnings,
      // Older native servers did not repeat the authenticated tournament id in each result. The
      // server snapshot is already scoped to this Director, so retain the pre-Transfers behavior
      // for that case while still honoring an explicit mismatch below the shared pipeline.
      transportTournamentId: result.tournamentId ?? state.tournament?.id,
      transportMatchId: result.matchId,
      scheduledGameId: result.scheduledGameId,
      transportReviewRequired: result.reviewRequired,
    };
    const assessment = assessIncomingDocument(state, document);
    const scheduled = state.scheduledGames.find((entry) => entry.id === assessment.scheduledGameId);
    const now = isoNow();
    stageIncomingDocument(state, document, assessment);
    markNativeSessionResult(state, snapshot, result.sessionId, scheduled, now);
    changed = true;
  }
  return changed;
}

function decodeRawQbj(value: string | undefined): unknown {
  if (!value || typeof atob === 'undefined') return undefined;
  try {
    return JSON.parse(atob(value));
  } catch {
    return undefined;
  }
}

function matchObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const root = value as Record<string, unknown>;
  if (root.type === 'Match') return root;
  return Array.isArray(root.objects)
    ? (root.objects.find((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'Match'),
      ) ?? undefined)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function newerTimestamp(current: string | undefined, candidate: string): boolean {
  const candidateTime = Date.parse(candidate);
  if (!Number.isFinite(candidateTime)) return false;
  const currentTime = current ? Date.parse(current) : Number.NaN;
  return !Number.isFinite(currentTime) || candidateTime > currentTime;
}

function progressSummary(value: unknown): NonNullable<DirectorState['qbtcpSessions'][number]['progress']> {
  const match = matchObject(value);
  const entries = Array.isArray(match?.match_teams) ? match.match_teams : [];
  const points = entries.map((entry) => {
    if (!entry || typeof entry !== 'object') return undefined;
    return finiteNumber((entry as Record<string, unknown>).points);
  });
  return {
    tossupsRead: finiteNumber(match?.tossups_read) ?? 0,
    leftScore: points[0] ?? 0,
    rightScore: points[1] ?? 0,
  };
}
