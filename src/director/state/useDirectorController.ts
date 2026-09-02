import { useCallback, useEffect, useRef, useState } from 'react';
import {
  closeRound,
  defaultRules,
  emptyDirectorState,
  generateDirectorRound,
  isoNow,
  newDirectorId,
  scheduleIsValid,
  type DirectorId,
  type DirectorState,
  type DetailedStatsStatus,
  type GameRecord,
  type PlayerGameStat,
  type ProtestScoreAdjustment,
  type ResultSubmission,
  type ScheduledGame,
  type TeamGameScore,
} from '../domain';
import { createDirectorRepository, normalizeDirectorState, type DirectorRepository } from '../persistence';
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
}

export interface NewStaffInput {
  name: string;
  roles?: NonNullable<DirectorState['staff'][number]>['roles'];
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
  ): void;
  addTeam(input: NewTeamInput): void;
  addImportedTeams(teams: ImportedTeamInput[]): { inserted: number; skipped: number };
  updateTeam(teamId: DirectorId, changes: Partial<NewTeamInput>): void;
  dropTeam(teamId: DirectorId, reason?: string): void;
  restoreTeam(teamId: DirectorId): void;
  addPlayer(teamId: DirectorId, name: string, captain?: boolean): void;
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
  ): void;
  addStaff(input: NewStaffInput): void;
  addEquipment(input: NewEquipmentInput): void;
  addPacket(name: string, source?: 'manual' | 'qbj' | 'imported'): void;
  addPackets(
    packets: Array<{
      name: string;
      source?: 'manual' | 'qbj' | 'imported';
      tiebreaker?: boolean;
      notes?: string;
    }>,
  ): { inserted: number; skipped: number };
  selectPhase(phaseId: DirectorId): void;
  selectPacket(packetId: DirectorId): void;
  updateFormat(
    changes: Partial<
      Pick<
        NonNullable<DirectorState['formats'][number]>,
        'name' | 'kind' | 'avoidRematches' | 'avoidSameOrganization' | 'allowByes' | 'roundsPerTeam'
      >
    >,
  ): void;
  addPhase(name: string, kind?: NonNullable<DirectorState['phases'][number]>['kind']): void;
  updateRules(changes: Partial<NonNullable<DirectorState['tournament']>['rules']>): void;
  generateSchedule(options?: { seed?: number; avoidRematches?: boolean; avoidSameOrganization?: boolean }): {
    conflicts: string[];
    generated: boolean;
  };
  prepareRound(roundId: DirectorId): boolean;
  releaseRound(roundId: DirectorId): boolean;
  closeRound(roundId: DirectorId): boolean;
  addManualResult(input: ManualResultInput): boolean;
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
        if (stateRevisionRef.current === revision) {
          stateRef.current = persisted;
          setState(persisted);
          setError(null);
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
    ) => {
      commit((draft) => {
        if (!draft.tournament) return;
        draft.tournament = { ...draft.tournament, ...changes, updatedAt: isoNow() };
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'tournament-updated',
          summary: 'Tournament details updated.',
          entityId: draft.tournament.id,
        });
      });
    },
    [commit],
  );

  const addTeam = useCallback(
    (input: NewTeamInput) => {
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
          displayName: input.displayName.trim() || `Team ${draft.teams.length + 1}`,
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
          summary: `Added ${input.displayName.trim() || 'new team'}.`,
          entityId: teamId,
        });
      });
    },
    [commit],
  );

  const addImportedTeams = useCallback(
    (inputs: ImportedTeamInput[]): { inserted: number; skipped: number } => {
      let inserted = 0;
      let skipped = 0;
      commit((draft) => {
        const teamIds = new Set(draft.teams.map((team) => team.id));
        const teamNames = new Set(draft.teams.map((team) => team.displayName.toLocaleLowerCase()));
        const playerIds = new Set(draft.players.map((player) => player.id));
        for (const input of inputs) {
          const name = input.displayName.trim();
          if (!name || (input.id && teamIds.has(input.id)) || teamNames.has(name.toLocaleLowerCase())) {
            skipped += 1;
            continue;
          }
          const now = isoNow();
          const teamId = input.id?.trim() || newDirectorId('team');
          if (teamIds.has(teamId)) {
            skipped += 1;
            continue;
          }
          const organizationName = input.organizationId?.trim();
          let organizationId: DirectorId | null = organizationName || null;
          if (organizationName) {
            const organization = draft.organizations.find(
              (candidate) =>
                candidate.id === organizationName ||
                candidate.name.toLocaleLowerCase() === organizationName.toLocaleLowerCase(),
            );
            if (organization) organizationId = organization.id;
            else draft.organizations.push({ id: organizationName, name: organizationName });
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
    (teamId: DirectorId, changes: Partial<NewTeamInput>) => {
      commit((draft) => {
        const team = draft.teams.find((entry) => entry.id === teamId);
        if (!team) return;
        Object.assign(team, {
          ...changes,
          displayName: changes.displayName?.trim() ?? team.displayName,
          updatedAt: isoNow(),
        });
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'team-changed',
          summary: `Updated ${team.displayName}.`,
          entityId: teamId,
        });
      });
    },
    [commit],
  );

  const dropTeam = useCallback(
    (teamId: DirectorId, reason = 'Dropped by director') => {
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
    },
    [commit],
  );

  const restoreTeam = useCallback(
    (teamId: DirectorId) =>
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
      }),
    [commit],
  );

  const addPlayer = useCallback(
    (teamId: DirectorId, name: string, captain = false) => {
      if (!name.trim()) return;
      commit((draft) => {
        const playerId = newDirectorId('player');
        if (captain)
          draft.players
            .filter((player) => player.teamId === teamId)
            .forEach((player) => (player.captain = false));
        draft.players.push({ id: playerId, teamId, name: name.trim(), captain, active: true });
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'team-changed',
          summary: `Added ${name.trim()} to a roster.`,
          entityId: playerId,
        });
      });
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
    ) =>
      commit((draft) => {
        const room = draft.rooms.find((entry) => entry.id === roomId);
        if (!room) return;
        Object.assign(room, changes);
        if (changes.available === false) {
          room.status = 'offline';
          for (const session of draft.qbtcpSessions.filter((entry) => entry.roomId === roomId)) {
            if (session.state !== 'result-received') {
              session.state = 'abandoned';
              session.progress = null;
              session.resumable = true;
            }
          }
          for (const request of draft.qbtcpHelpRequests.filter(
            (entry) => entry.roomId === roomId && entry.status === 'open',
          )) {
            request.status = 'cancelled';
            request.updatedAt = isoNow();
          }
        } else if (changes.available === true && room.status === 'offline') {
          room.status = 'available';
        }
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'room-changed',
          summary: `Updated ${room.name}.`,
          entityId: roomId,
        });
      }),
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

  const addPacket = useCallback(
    (name: string, source: 'manual' | 'qbj' | 'imported' = 'manual') =>
      commit((draft) => {
        const packetId = newDirectorId('packet');
        draft.packets.push({
          id: packetId,
          name: name.trim() || `Packet ${draft.packets.length + 1}`,
          source,
          assignedRoundIds: [],
          assignedGameIds: [],
          usedGameIds: [],
          replacementForPacketId: null,
          tiebreaker: false,
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
          summary: `Added ${name.trim() || `Packet ${draft.packets.length}`}.`,
          entityId: packetId,
        });
      }),
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

  const updateFormat = useCallback(
    (
      changes: Partial<
        Pick<
          NonNullable<DirectorState['formats'][number]>,
          'name' | 'kind' | 'avoidRematches' | 'avoidSameOrganization' | 'allowByes' | 'roundsPerTeam'
        >
      >,
    ) =>
      commit((draft) => {
        const formatId = draft.tournament?.formatId;
        const format = formatId ? draft.formats.find((entry) => entry.id === formatId) : undefined;
        if (!format) return;
        Object.assign(format, changes);
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'format-changed',
          summary: `Updated ${format.name}.`,
          entityId: format.id,
        });
      }),
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

  const updateRules = useCallback(
    (changes: Partial<NonNullable<DirectorState['tournament']>['rules']>) =>
      commit((draft) => {
        if (!draft.tournament) return;
        draft.tournament.rules = { ...draft.tournament.rules, ...changes };
        draft.tournament.updatedAt = isoNow();
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'tournament-updated',
          summary: 'Scoring rules updated.',
          entityId: draft.tournament.id,
        });
      }),
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
      if (games.length === 0 || !scheduleIsValid(games)) {
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
      const round = stateRef.current.rounds.find((entry) => entry.id === roundId);
      if (!round || round.status !== 'prepared') {
        setError('Only a prepared round can be released.');
        return false;
      }
      const games = stateRef.current.scheduledGames.filter((game) => game.roundId === roundId);
      const roomIds = games.filter((game) => !game.bye).map((game) => game.roomId);
      const duplicateRoom = roomIds.filter((roomId, index) => roomId && roomIds.indexOf(roomId) !== index)[0];
      const invalidRoom = games.find((game) => {
        if (game.bye) return false;
        if (!game.roomId) return true;
        const room = stateRef.current.rooms.find((entry) => entry.id === game.roomId);
        return !room || !room.available || room.status !== 'available';
      });
      if (
        !scheduleIsValid(games) ||
        games.length === 0 ||
        roomIds.some((roomId) => roomId === null) ||
        duplicateRoom ||
        invalidRoom
      ) {
        setError(
          duplicateRoom
            ? 'A room can only host one game in a round.'
            : 'This round cannot be released until every game has a valid matchup and available room.',
        );
        return false;
      }
      commit((draft) => {
        const round = draft.rounds.find((entry) => entry.id === roundId);
        if (!round || round.status !== 'prepared') return;
        round.status = 'released';
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
        canonicalAcceptedGame(snapshot, scheduled.id)?.id !== gameId
      ) {
        setError('A protest must target the current canonical accepted result.');
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

  const syncQbtcp = useCallback(async () => {
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
  }, [persist]);

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
    removePlayer,
    addRoom,
    updateRoom,
    addStaff,
    addEquipment,
    addPacket,
    addPackets,
    addImportedTeams,
    selectPhase,
    selectPacket,
    updateFormat,
    addPhase,
    updateRules,
    generateSchedule,
    prepareRound,
    releaseRound,
    closeRound: closeRoundAction,
    addManualResult,
    acceptSubmission,
    rejectSubmission,
    editAcceptedResult,
    addProtest,
    ruleProtest,
    syncQbtcp,
    qbtcpHealth,
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
        resumable: record.resumable,
        resultReceived: record.resultReceived,
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
      session.resumable !== record.resumable ||
      session.resultReceived !== nextResultReceived ||
      session.progressSequence !== (nextProgressSequence < 0 ? undefined : nextProgressSequence) ||
      session.lastSeenAt !== lastSeenAt
    ) {
      session.roomId = record.roomId || session.roomId;
      session.matchId = record.matchId ?? session.matchId;
      session.deviceId = record.deviceId ?? session.deviceId;
      session.operatorName = record.operatorName ?? session.operatorName;
      session.state = nextState;
      session.resumable = record.resumable;
      session.resultReceived = nextResultReceived;
      session.progressSequence = nextProgressSequence < 0 ? undefined : nextProgressSequence;
      session.lastSeenAt = lastSeenAt;
      changed = true;
    }
    if (nextState === 'abandoned' && session.progress !== null) {
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
      : state.qbtcpSessions.find(
          (session) => session.roomId === presence.roomId && session.deviceId === presence.deviceId,
        );
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
    if (room && room.available && room.status !== 'live') {
      room.status = 'live';
      changed = true;
    }
  }
  return changed;
}

function applyNativeHelp(state: DirectorState, records: NativeHelpSnapshot[]): boolean {
  let changed = false;
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
      changed = true;
    }
  }
  return changed;
}

interface DuplicateResultReference {
  gameId: DirectorId;
  submissionId: DirectorId;
}

function findDuplicateResult(
  state: DirectorState,
  scheduledGameId: DirectorId | undefined,
  fingerprint: string,
  scoreFingerprint: string | undefined,
): DuplicateResultReference | undefined {
  if (!scheduledGameId) return undefined;
  for (const submission of state.submissions) {
    if (submission.status === 'rejected') continue;
    const game = state.games.find((entry) => entry.id === submission.gameId);
    if (!game || game.scheduledGameId !== scheduledGameId) continue;
    if (
      submission.fingerprint === fingerprint ||
      (scoreFingerprint && submission.fingerprint === scoreFingerprint)
    ) {
      return { gameId: game.id, submissionId: submission.id };
    }
  }
  return undefined;
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
      resumable: nativeSession?.resumable,
      resultReceived: true,
      progressSequence: nativeSession?.progressSequence ?? progress?.sequence,
      lastSeenAt: now,
      progress: progress ? progressSummary(progress.matchState) : null,
      helpRequestId: null,
    });
  } else {
    session.state = 'result-received';
    session.resultReceived = true;
    session.resumable = nativeSession?.resumable ?? session.resumable;
    session.matchId = nativeSession?.matchId ?? session.matchId;
    session.lastSeenAt = now;
    if (progress && progress.sequence > (session.progressSequence ?? -1)) {
      session.progressSequence = progress.sequence;
      session.progress = progressSummary(progress.matchState);
    }
  }
  if (scheduled?.roomId) {
    const room = state.rooms.find((entry) => entry.id === scheduled.roomId);
    if (room && room.status !== 'finished') room.status = 'finished';
  }
}

function applyNativeResults(state: DirectorState, snapshot: NativeServerSnapshot): boolean {
  let changed = false;
  for (const result of snapshot.results) {
    if (state.submissions.some((submission) => submission.transportResultId === result.id)) continue;
    const qbj = result.qbj ?? decodeRawQbj(result.rawBase64);
    const matchId = result.matchId ?? matchIdentity(qbj);
    const belongsToTournament =
      result.tournamentId === undefined || result.tournamentId === state.tournament?.id;
    // A native result may carry the assignment identity established when the room was issued.
    // Once present, an invalid assignment is deliberately not rescued by a room or match-name
    // fallback: associating a result with the wrong reused room is worse than review-only state.
    const scheduled = !belongsToTournament
      ? undefined
      : result.scheduledGameId !== undefined
        ? state.scheduledGames.find((game) => game.id === result.scheduledGameId)
        : findScheduledByMatchId(state, matchId);
    const parsed = resultScores(qbj, state, scheduled);
    const scoreFingerprint = parsed.scores.length === 2 ? fingerprintForScores(parsed.scores) : undefined;
    const fingerprint = result.fingerprint || scoreFingerprint || result.id;
    const now = isoNow();
    const warnings = [
      ...(belongsToTournament
        ? []
        : ['The QBTCP result belongs to a different tournament; it remains in review.']),
      ...result.warnings,
      ...parsed.warnings,
    ];
    const rawSubmission = {
      protocol: 'QBTCP v1',
      association: scheduled ? 'matched' : 'unmatched',
      resultId: result.id,
      matchId,
      scheduledGameId: result.scheduledGameId,
      fingerprint,
      reviewRequired: result.reviewRequired,
      qbj,
      rawBase64: result.rawBase64,
    };
    const duplicate = findDuplicateResult(state, scheduled?.id, fingerprint, scoreFingerprint);
    if (duplicate) {
      state.submissions.push({
        id: newDirectorId('submission'),
        gameId: duplicate.gameId,
        transportResultId: result.id,
        sessionId: result.sessionId,
        receivedAt: now,
        fingerprint,
        status: 'duplicate',
        rawSubmission,
        warnings,
        conflictWith: duplicate.submissionId,
        reason: 'The same result was already retained for this scheduled game.',
      });
      markNativeSessionResult(state, snapshot, result.sessionId, scheduled, now);
      state.audit.push({
        id: newDirectorId('audit'),
        at: now,
        actor: 'QBTCP',
        type: 'result-received',
        summary: `Ignored a duplicate result for ${scheduled ? gameLabel(state, scheduled.id) : (matchId ?? 'an unmatched game')}.`,
        entityId: duplicate.gameId,
        details: {
          transportResultId: result.id,
          duplicateOf: duplicate.submissionId,
          scheduledGameId: scheduled?.id,
        },
      });
      changed = true;
      continue;
    }
    const canonical = scheduled ? canonicalAcceptedGame(state, scheduled.id) : undefined;
    const canonicalSubmission = canonical ? currentAcceptedSubmission(state, canonical.id) : undefined;
    const pendingCandidate = scheduled
      ? state.games.find(
          (game) =>
            game.scheduledGameId === scheduled.id &&
            game.status !== 'accepted' &&
            game.status !== 'rejected' &&
            game.status !== 'cancelled' &&
            game.source === 'qbtcp',
        )
      : undefined;
    const existingCandidate = canonical ?? pendingCandidate;
    const gameId = existingCandidate?.id ?? newDirectorId('game-record');
    const reviewRequired =
      result.reviewRequired ||
      !scheduled ||
      parsed.scores.length !== 2 ||
      warnings.length > 0 ||
      Boolean(canonical);
    if (!existingCandidate) {
      const game: GameRecord = {
        id: gameId,
        scheduledGameId: scheduled?.id ?? matchId ?? `unmatched-${result.id}`,
        roundId: scheduled?.roundId ?? 'unmatched-round',
        packetId: scheduled ? effectivePacketId(state, scheduled) : null,
        status: 'submitted',
        scores: parsed.scores,
        playerStats: parsed.playerStats,
        source: 'qbtcp',
        detailedStats: parsed.detailedStats,
        transportResultId: result.id,
        rawQbj: qbj,
        finishedAt: now,
      };
      state.games.push(game);
    }
    state.submissions.push({
      id: newDirectorId('submission'),
      gameId,
      transportResultId: result.id,
      sessionId: result.sessionId,
      receivedAt: now,
      fingerprint,
      status: reviewRequired ? 'review' : 'received',
      rawSubmission,
      warnings,
      conflictWith: result.conflictWith ?? canonicalSubmission?.id,
    });
    if (scheduled && !canonical) scheduled.status = 'submitted';
    markNativeSessionResult(state, snapshot, result.sessionId, scheduled, now);
    state.audit.push({
      id: newDirectorId('audit'),
      at: now,
      actor: 'QBTCP',
      type: 'result-received',
      summary: `Received a result for ${scheduled ? gameLabel(state, scheduled.id) : (matchId ?? 'an unmatched game')}.`,
      entityId: gameId,
      details: {
        transportResultId: result.id,
        warnings,
        conflictWith: result.conflictWith ?? canonicalSubmission?.id,
        scheduledGameId: scheduled?.id,
      },
    });
    changed = true;
  }
  return changed;
}

function findScheduledByMatchId(state: DirectorState, matchId: string | undefined) {
  if (!matchId) return undefined;
  const direct = state.scheduledGames.find((game) => game.id === matchId);
  if (direct) return direct;
  const candidates = state.scheduledGames.filter((game) => {
    const record = state.games.find((entry) => entry.scheduledGameId === game.id && entry.rawQbj);
    return matchIdentity(record?.rawQbj) === matchId;
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

function matchIdentity(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const root = value as { id?: unknown; type?: unknown; objects?: unknown };
  if (root.type === 'Match' && typeof root.id === 'string') return root.id;
  if (Array.isArray(root.objects)) {
    const match = root.objects.find((entry): entry is { type?: unknown; id?: unknown } =>
      Boolean(entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'Match'),
    );
    return match && typeof match.id === 'string' ? match.id : undefined;
  }
  return undefined;
}

function decodeRawQbj(value: string | undefined): unknown {
  if (!value || typeof atob === 'undefined') return undefined;
  try {
    return JSON.parse(atob(value));
  } catch {
    return undefined;
  }
}

function resultScores(
  value: unknown,
  state: DirectorState,
  scheduled: DirectorState['scheduledGames'][number] | undefined,
): {
  scores: TeamGameScore[];
  playerStats: PlayerGameStat[];
  detailedStats: 'complete' | 'incomplete' | 'unknown';
  warnings: string[];
} {
  const warnings: string[] = [];
  const match = matchObject(value);
  const entries = Array.isArray(match?.match_teams) ? match.match_teams : [];
  const scores = entries
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const teamId = resultTeamId(record.team, state, scheduled, warnings);
      const score = finiteNumber(record.points);
      if (!teamId) {
        warnings.push('A QBTCP team reference could not be matched to one scheduled team.');
        return null;
      }
      if (score === undefined) {
        warnings.push(`The QBTCP result for team ${teamId} has no finite final score.`);
        return null;
      }
      const stats = teamAggregate(record, state);
      return { teamId, score, ...stats };
    })
    .filter((entry): entry is TeamGameScore => entry !== null);
  const playerStats = entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const teamId = resultTeamId(record.team, state, scheduled, warnings);
    if (!teamId || !Array.isArray(record.match_players)) return [];
    return record.match_players.flatMap((candidate): PlayerGameStat[] => {
      if (!candidate || typeof candidate !== 'object') return [];
      const playerRecord = candidate as Record<string, unknown>;
      const player = resultPlayer(playerRecord.player, state, teamId, warnings);
      if (!player) return [];
      const counts = Array.isArray(playerRecord.answer_counts) ? playerRecord.answer_counts : [];
      let powers = 0;
      let gets = 0;
      let negs = 0;
      for (const count of counts) {
        if (!count || typeof count !== 'object') continue;
        const answer = (count as Record<string, unknown>).answer_type;
        const value =
          answer && typeof answer === 'object'
            ? finiteNumber((answer as Record<string, unknown>).value)
            : undefined;
        const number = finiteNumber((count as Record<string, unknown>).number)
          ? Number((count as Record<string, unknown>).number)
          : 0;
        if (value === undefined) continue;
        if (value === (state.tournament?.rules.powerValue ?? 15)) powers += number;
        else if (value === (state.tournament?.rules.tossupValue ?? 10)) gets += number;
        else if (value < 0) negs += number;
      }
      return [
        {
          playerId: player.id,
          teamId,
          powers,
          gets,
          negs,
          bonusPoints: 0,
          tossupsHeard: finiteNumber(playerRecord.tossups_heard) ? Number(playerRecord.tossups_heard) : null,
        },
      ];
    });
  });
  const hasPlayerPayload = entries.some((entry) =>
    Boolean(
      entry && typeof entry === 'object' && Array.isArray((entry as Record<string, unknown>).match_players),
    ),
  );
  const detailedStats = !hasPlayerPayload
    ? 'unknown'
    : playerStats.length === 0 || playerStats.some((stat) => stat.tossupsHeard === null)
      ? 'incomplete'
      : 'complete';
  return { scores, playerStats, detailedStats, warnings };
}

function teamAggregate(
  entry: Record<string, unknown>,
  state: DirectorState,
): Omit<TeamGameScore, 'teamId' | 'score'> {
  let powers = 0;
  let gets = 0;
  let negs = 0;
  if (Array.isArray(entry.match_players)) {
    for (const candidate of entry.match_players) {
      if (!candidate || typeof candidate !== 'object') continue;
      const counts = (candidate as Record<string, unknown>).answer_counts;
      if (!Array.isArray(counts)) continue;
      for (const count of counts) {
        if (!count || typeof count !== 'object') continue;
        const answer = (count as Record<string, unknown>).answer_type;
        const value =
          answer && typeof answer === 'object'
            ? finiteNumber((answer as Record<string, unknown>).value)
            : undefined;
        const number = finiteNumber((count as Record<string, unknown>).number)
          ? Number((count as Record<string, unknown>).number)
          : 0;
        if (value === undefined) continue;
        if (value === (state.tournament?.rules.powerValue ?? 15)) powers += number;
        else if (value === (state.tournament?.rules.tossupValue ?? 10)) gets += number;
        else if (value < 0) negs += number;
      }
    }
  }
  const bouncebacks = finiteNumber(entry.bonus_bounceback_points) ? Number(entry.bonus_bounceback_points) : 0;
  const lightning = finiteNumber(entry.lightning_points) ? Number(entry.lightning_points) : 0;
  const tossupPoints =
    powers * (state.tournament?.rules.powerValue ?? 15) +
    gets * (state.tournament?.rules.tossupValue ?? 10) +
    negs * (state.tournament?.rules.negValue ?? -5);
  const points = finiteNumber(entry.points) ? Number(entry.points) : tossupPoints;
  return {
    powers,
    gets,
    negs,
    bonuses: finiteNumber(entry.bonuses) ? Number(entry.bonuses) : 0,
    bonusPoints: points - tossupPoints - bouncebacks - lightning,
    bouncebacks,
  };
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

function resultTeamId(
  value: unknown,
  state: DirectorState,
  scheduled: DirectorState['scheduledGames'][number] | undefined,
  warnings: string[] = [],
): string | undefined {
  const candidates = [scheduled?.leftTeamId, scheduled?.rightTeamId].filter((entry): entry is string =>
    Boolean(entry),
  );
  const identities = stableIdentities(value);
  if (identities.length > 1) {
    warnings.push('QBTCP team references disagree; the result remains in review.');
    return undefined;
  }
  const knownTeamIds = [
    ...new Set(identities.filter((identity) => state.teams.some((team) => team.id === identity))),
  ];
  const candidateIds = [...new Set(identities.filter((identity) => candidates.includes(identity)))];
  if (knownTeamIds.length > 1 || candidateIds.length > 1) {
    warnings.push('QBTCP team references disagree; the result remains in review.');
    return undefined;
  }
  if (knownTeamIds.length === 1) {
    const [teamId] = knownTeamIds;
    if (candidates.length > 0 && !candidates.includes(teamId)) {
      warnings.push(`QBTCP team reference ${teamId} does not match the scheduled assignment.`);
      return undefined;
    }
    return teamId;
  }
  if (candidateIds.length === 1) return candidateIds[0];
  if (identities.length > 0) {
    warnings.push(
      `QBTCP team reference ${identities.join(' / ')} is not registered in this tournament; the result remains in review.`,
    );
    return undefined;
  }
  const name = namedValue(value);
  if (!name) return undefined;
  const matches = state.teams.filter(
    (entry) =>
      (!candidates.length || candidates.includes(entry.id)) &&
      entry.displayName.toLocaleLowerCase() === name.toLocaleLowerCase(),
  );
  if (matches.length === 1) {
    warnings.push(`Matched team “${name}” by display name because no stable team reference was available.`);
    return matches[0].id;
  }
  if (matches.length > 1) warnings.push(`Team name “${name}” is ambiguous; the result remains in review.`);
  return undefined;
}

function resultPlayer(
  value: unknown,
  state: DirectorState,
  teamId: string,
  warnings: string[],
): DirectorState['players'][number] | undefined {
  const candidates = state.players.filter((player) => player.teamId === teamId);
  const identities = stableIdentities(value);
  if (identities.length > 1) {
    warnings.push('QBTCP player references disagree; that player stat was ignored.');
    return undefined;
  }
  const knownPlayers = [
    ...new Set(
      identities
        .map((identity) => state.players.find((player) => player.id === identity))
        .filter((player): player is DirectorState['players'][number] => Boolean(player)),
    ),
  ];
  const candidateIds = [
    ...new Set(identities.filter((identity) => candidates.some((player) => player.id === identity))),
  ];
  if (knownPlayers.length > 1 || candidateIds.length > 1) {
    warnings.push('QBTCP player references disagree; that player stat was ignored.');
    return undefined;
  }
  if (knownPlayers.length === 1) {
    const [player] = knownPlayers;
    if (player.teamId !== teamId) {
      warnings.push(`QBTCP player reference ${player.id} is registered to a different team.`);
      return undefined;
    }
    return player;
  }
  if (candidateIds.length === 1) {
    return candidates.find((candidate) => candidate.id === candidateIds[0]);
  }
  if (identities.length > 0) {
    warnings.push(
      `QBTCP player reference ${identities.join(' / ')} is not registered for this team; that player stat was ignored.`,
    );
    return undefined;
  }
  const name = namedValue(value);
  if (!name) return undefined;
  const matches = candidates.filter((player) => player.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (matches.length === 1) {
    warnings.push(`Matched player “${name}” by name because no stable player reference was available.`);
    return matches[0];
  }
  if (matches.length > 1) warnings.push(`Player name “${name}” is ambiguous; that player stat was ignored.`);
  return undefined;
}

function stableIdentities(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [
    ...new Set(
      [record.$ref, record.id].filter(
        (identity): identity is string => typeof identity === 'string' && identity.length > 0,
      ),
    ),
  ];
}

function namedValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' ? record.name : undefined;
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

function gameLabel(state: DirectorState, scheduledId: string): string {
  const scheduled = state.scheduledGames.find((game) => game.id === scheduledId);
  if (!scheduled) return scheduledId;
  const left = state.teams.find((team) => team.id === scheduled.leftTeamId)?.displayName ?? 'Team';
  const right = scheduled.rightTeamId
    ? (state.teams.find((team) => team.id === scheduled.rightTeamId)?.displayName ?? 'Team')
    : 'Bye';
  return `${left} vs ${right}`;
}
