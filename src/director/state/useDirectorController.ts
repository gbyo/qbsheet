import { useCallback, useEffect, useRef, useState } from 'react';
import {
  closeRound,
  defaultRules,
  emptyDirectorState,
  generateRoundRobinRound,
  isoNow,
  newDirectorId,
  type DirectorId,
  type DirectorState,
  type GameRecord,
  type PlayerGameStat,
  type ResultSubmission,
  type TeamGameScore,
} from '../domain';
import { createDirectorRepository, type DirectorRepository } from '../persistence';
import {
  readNativeServerSnapshot,
  type NativeProgressSnapshot,
  type NativeServerSnapshot,
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
  ): void;
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
  };
  prepareRound(roundId: DirectorId): void;
  releaseRound(roundId: DirectorId): void;
  closeRound(roundId: DirectorId): void;
  addManualResult(input: ManualResultInput): void;
  acceptSubmission(submissionId: DirectorId, actor?: string): void;
  rejectSubmission(submissionId: DirectorId, reason?: string): void;
  editAcceptedResult(gameId: DirectorId, scores: TeamGameScore[], note?: string): void;
  addProtest(
    gameId: DirectorId,
    description: string,
    category?: 'tossup' | 'bonus' | 'procedure' | 'other',
  ): void;
  ruleProtest(protestId: DirectorId, ruling: string, scoreAdjustment?: number): void;
  syncQbtcp(): Promise<void>;
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
  const saveQueueRef = useRef(Promise.resolve());
  const saveSequenceRef = useRef(0);

  useEffect(() => {
    let active = true;
    void repositoryRef.current
      .load()
      .then((loaded) => {
        if (!active) return;
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

  const persist = useCallback((next: DirectorState) => {
    const sequence = saveSequenceRef.current + 1;
    saveSequenceRef.current = sequence;
    setSaving(true);
    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(() => repositoryRef.current.save(next))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : 'Director storage could not be saved.'),
      )
      .finally(() => {
        if (saveSequenceRef.current === sequence) setSaving(false);
      });
  }, []);

  const commit = useCallback(
    (mutator: (draft: DirectorState) => void) => {
      setState((previous) => {
        const next = structuredClone(previous);
        mutator(next);
        next.metadata.lastSavedAt = isoNow();
        persist(next);
        return next;
      });
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
    ) =>
      commit((draft) => {
        const now = isoNow();
        const existingNames = new Set(draft.packets.map((packet) => packet.name.trim().toLocaleLowerCase()));
        for (const input of packets) {
          const name = input.name.trim();
          if (!name || existingNames.has(name.toLocaleLowerCase())) continue;
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
          existingNames.add(name.toLocaleLowerCase());
          draft.audit.push({
            id: newDirectorId('audit'),
            at: now,
            actor: 'Director',
            type: 'packet-changed',
            summary: `Imported ${name}.`,
            entityId: packetId,
          });
        }
      }),
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
        const format =
          draft.formats.find((entry) => entry.id === draft.tournament?.formatId) ?? draft.formats[0];
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
        const format =
          draft.formats.find((entry) => entry.id === draft.tournament?.formatId) ?? draft.formats[0];
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

  const generateSchedule = useCallback(
    (options: { seed?: number; avoidRematches?: boolean; avoidSameOrganization?: boolean } = {}) => {
      let conflicts: string[] = [];
      commit((draft) => {
        if (!draft.tournament || draft.teams.filter((team) => team.status === 'confirmed').length < 2) {
          conflicts = ['Add at least two confirmed teams before generating a schedule.'];
          return;
        }
        const phase = draft.phases[0];
        const packet = draft.packets[0];
        const generated = generateRoundRobinRound(draft, {
          phaseId: phase?.id,
          packetId: packet?.id ?? null,
          roomIds: draft.rooms.filter((room) => room.available).map((room) => room.id),
          avoidRematches: options.avoidRematches ?? draft.formats[0]?.avoidRematches ?? true,
          avoidSameOrganization:
            options.avoidSameOrganization ?? draft.formats[0]?.avoidSameOrganization ?? false,
          allowByes: draft.formats[0]?.allowByes ?? true,
          seed: options.seed,
        });
        conflicts = generated.conflicts.map((conflict) => conflict.message);
        draft.rounds.push(generated.round);
        draft.scheduledGames.push(...generated.games);
        if (phase) {
          phase.roundIds.push(generated.round.id);
          phase.status = 'active';
        }
        if (draft.tournament) {
          draft.tournament.currentRoundId = generated.round.id;
          draft.tournament.status = 'running';
          draft.tournament.updatedAt = isoNow();
        }
        if (packet) {
          packet.assignedRoundIds.push(generated.round.id);
          generated.games.forEach((game) => packet.assignedGameIds.push(game.id));
        }
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'schedule-generated',
          summary: `Generated ${generated.round.name}.`,
          entityId: generated.round.id,
          details: { conflicts },
        });
      });
      return { conflicts };
    },
    [commit],
  );

  const prepareRound = useCallback(
    (roundId: DirectorId) =>
      commit((draft) => {
        const round = draft.rounds.find((entry) => entry.id === roundId);
        if (!round || round.status === 'closed') return;
        round.status = 'prepared';
      }),
    [commit],
  );

  const releaseRound = useCallback(
    (roundId: DirectorId) =>
      commit((draft) => {
        const round = draft.rounds.find((entry) => entry.id === roundId);
        if (!round || round.status === 'closed') return;
        round.status = 'released';
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
      }),
    [commit],
  );

  const closeRoundAction = useCallback(
    (roundId: DirectorId) =>
      commit((draft) => {
        const round = draft.rounds.find((entry) => entry.id === roundId);
        if (!round) return;
        const unresolved = draft.scheduledGames.some(
          (game) => game.roundId === roundId && !game.bye && !['accepted', 'cancelled'].includes(game.status),
        );
        if (unresolved) return;
        Object.assign(round, closeRound(round));
      }),
    [commit],
  );

  const addManualResult = useCallback(
    (input: ManualResultInput) =>
      commit((draft) => {
        const scheduled = draft.scheduledGames.find((game) => game.id === input.scheduledGameId);
        if (!scheduled || scheduled.bye) return;
        const gameId = newDirectorId('game-record');
        const now = isoNow();
        const game: GameRecord = {
          id: gameId,
          scheduledGameId: scheduled.id,
          roundId: scheduled.roundId,
          packetId: scheduled.packetId,
          status: 'accepted',
          scores: input.scores,
          playerStats: [],
          source: 'manual',
          finishedAt: now,
          acceptedAt: now,
          note: input.note,
        };
        draft.games.push(game);
        scheduled.status = 'accepted';
        if (scheduled.packetId) {
          const packet = draft.packets.find((entry) => entry.id === scheduled.packetId);
          if (packet && !packet.usedGameIds.includes(game.id)) packet.usedGameIds.push(game.id);
        }
        const fingerprint = fingerprintForScores(input.scores);
        const submission: ResultSubmission = {
          id: newDirectorId('submission'),
          gameId,
          receivedAt: now,
          fingerprint,
          status: 'accepted',
          rawSubmission: { source: 'manual', game },
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
        });
      }),
    [commit],
  );

  const acceptSubmission = useCallback(
    (submissionId: DirectorId, actor = 'Director') =>
      commit((draft) => {
        const submission = draft.submissions.find((entry) => entry.id === submissionId);
        if (!submission || (submission.status !== 'received' && submission.status !== 'review')) return;
        submission.status = 'accepted';
        submission.acceptedBy = actor;
        submission.acceptedAt = isoNow();
        const game = draft.games.find((entry) => entry.id === submission.gameId);
        if (game) {
          game.status = 'accepted';
          game.acceptedAt = submission.acceptedAt;
          const scheduled = draft.scheduledGames.find((entry) => entry.id === game.scheduledGameId);
          if (scheduled) scheduled.status = 'accepted';
          if (scheduled?.packetId) {
            const packet = draft.packets.find((entry) => entry.id === scheduled.packetId);
            if (packet && !packet.usedGameIds.includes(game.id)) packet.usedGameIds.push(game.id);
          }
        }
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor,
          type: 'result-accepted',
          summary: `Accepted result ${submissionId}.`,
          entityId: submission.gameId,
        });
      }),
    [commit],
  );

  const rejectSubmission = useCallback(
    (submissionId: DirectorId, reason = 'Rejected by director') =>
      commit((draft) => {
        const submission = draft.submissions.find((entry) => entry.id === submissionId);
        if (!submission) return;
        submission.status = 'rejected';
        submission.reason = reason;
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'result-edited',
          summary: `Rejected result ${submissionId}.`,
          entityId: submission.gameId,
          details: { reason },
        });
      }),
    [commit],
  );

  const editAcceptedResult = useCallback(
    (gameId: DirectorId, scores: TeamGameScore[], note?: string) =>
      commit((draft) => {
        const game = draft.games.find((entry) => entry.id === gameId);
        if (!game) return;
        const previous = structuredClone(game);
        game.scores = scores;
        game.note = note;
        const previousSubmission = [...draft.submissions]
          .reverse()
          .find((entry: ResultSubmission) => entry.gameId === gameId);
        const replacement: ResultSubmission = {
          id: newDirectorId('submission'),
          gameId,
          receivedAt: isoNow(),
          fingerprint: fingerprintForScores(scores),
          status: 'accepted',
          rawSubmission: { editedFrom: previous, scores },
          acceptedBy: 'Director',
          acceptedAt: isoNow(),
          supersedesSubmissionId: previousSubmission?.id,
        };
        draft.submissions.push(replacement);
        draft.audit.push({
          id: newDirectorId('audit'),
          at: isoNow(),
          actor: 'Director',
          type: 'result-edited',
          summary: `Edited result ${gameId}; original retained.`,
          entityId: gameId,
        });
      }),
    [commit],
  );

  const addProtest = useCallback(
    (
      gameId: DirectorId,
      description: string,
      category: 'tossup' | 'bonus' | 'procedure' | 'other' = 'other',
    ) =>
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
      }),
    [commit],
  );

  const ruleProtest = useCallback(
    (protestId: DirectorId, ruling: string, scoreAdjustment = 0) =>
      commit((draft) => {
        const protest = draft.protests.find((entry) => entry.id === protestId);
        if (!protest) return;
        protest.status = 'ruled';
        protest.ruling = ruling.trim();
        protest.scoreAdjustment = scoreAdjustment;
        protest.updatedAt = isoNow();
        draft.audit.push({
          id: newDirectorId('audit'),
          at: protest.updatedAt,
          actor: 'Director',
          type: 'protest-ruled',
          summary: 'Ruled on a protest.',
          entityId: protestId,
          details: { scoreAdjustment },
        });
      }),
    [commit],
  );

  const syncQbtcp = useCallback(async () => {
    const snapshot = await readNativeServerSnapshot();
    if (!snapshot) return;
    setState((previous) => {
      const next = structuredClone(previous);
      let changed = applyNativePresence(next, snapshot);
      changed = applyNativeProgress(next, snapshot.progress) || changed;
      changed = applyNativeResults(next, snapshot) || changed;
      if (!changed) return previous;
      next.metadata.lastSavedAt = isoNow();
      persist(next);
      return next;
    });
  }, [persist]);

  const checkpoint = useCallback(
    async (reason: string) => {
      const next = structuredClone(state);
      next.metadata.lastCheckpointAt = isoNow();
      await repositoryRef.current.checkpoint(next, reason);
      setState(next);
    },
    [state],
  );

  const exportSnapshot = useCallback(() => JSON.stringify(state, null, 2), [state]);

  const importSnapshot = useCallback(
    (value: unknown) => {
      const candidate =
        value && typeof value === 'object' && 'state' in value ? (value as { state?: unknown }).state : value;
      if (!candidate || typeof candidate !== 'object' || !('schemaVersion' in candidate)) return false;
      const imported = candidate as DirectorState;
      if (
        typeof imported.schemaVersion !== 'number' ||
        !Array.isArray(imported.teams) ||
        !Array.isArray(imported.scheduledGames)
      )
        return false;
      const next = structuredClone(imported);
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
        lastSavedAt: isoNow(),
      };
      setState(next);
      persist(next);
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
    checkpoint,
    exportSnapshot,
    importSnapshot,
  };
}

function fingerprintForScores(scores: TeamGameScore[]): string {
  return scores
    .map(
      (score) =>
        `${score.teamId}:${score.score}:${score.powers}:${score.gets}:${score.negs}:${score.bonusPoints}`,
    )
    .sort()
    .join('|');
}

function applyNativePresence(state: DirectorState, snapshot: NativeServerSnapshot): boolean {
  let changed = false;
  for (const presence of snapshot.presence) {
    const existing = state.qbtcpSessions.find(
      (session) => session.roomId === presence.roomId && session.deviceId === presence.deviceId,
    );
    const sessionId = existing?.sessionId ?? `qbtcp-${presence.roomId}-${presence.deviceId}`;
    const session = existing ?? {
      roomId: presence.roomId,
      sessionId,
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
    const nextState =
      presence.update.ready === true && session.state === 'paired' ? 'assigned' : session.state;
    if (
      session.operatorName !== presence.operatorName ||
      session.lastSeenAt !== presence.observedAt ||
      session.state !== nextState
    ) {
      session.operatorName = presence.operatorName;
      session.lastSeenAt = presence.observedAt;
      session.state = nextState;
      changed = true;
    }
  }
  return changed;
}

function applyNativeProgress(state: DirectorState, records: NativeProgressSnapshot[]): boolean {
  let changed = false;
  for (const record of records) {
    const summary = progressSummary(record.matchState, state, record.roomId);
    let session = state.qbtcpSessions.find((entry) => entry.sessionId === record.sessionId);
    if (!session) {
      session = {
        roomId: record.roomId,
        sessionId: record.sessionId,
        deviceId: '',
        state: 'live',
        lastSeenAt: record.receivedAt,
        progress: summary,
        helpRequestId: null,
      };
      state.qbtcpSessions.push(session);
      changed = true;
    } else if (
      session.roomId !== record.roomId ||
      session.lastSeenAt !== record.receivedAt ||
      session.state !== 'live' ||
      JSON.stringify(session.progress) !== JSON.stringify(summary)
    ) {
      session.roomId = record.roomId;
      session.lastSeenAt = record.receivedAt;
      session.state = 'live';
      session.progress = summary;
      changed = true;
    }
    const room = state.rooms.find((entry) => entry.id === record.roomId);
    if (room && room.status !== 'live') {
      room.status = 'live';
      changed = true;
    }
  }
  return changed;
}

function applyNativeResults(state: DirectorState, snapshot: NativeServerSnapshot): boolean {
  let changed = false;
  for (const result of snapshot.results) {
    if (state.submissions.some((submission) => submission.transportResultId === result.id)) continue;
    const qbj = result.qbj ?? decodeRawQbj(result.rawBase64);
    const matchId = result.matchId ?? matchIdentity(qbj);
    const scheduled = findScheduledByMatchId(state, matchId);
    const parsed = resultScores(qbj, state, scheduled);
    const gameId = newDirectorId('game-record');
    const now = isoNow();
    const game: GameRecord = {
      id: gameId,
      scheduledGameId: scheduled?.id ?? matchId ?? `unmatched-${result.id}`,
      roundId: scheduled?.roundId ?? 'unmatched-round',
      packetId: scheduled?.packetId ?? null,
      status: 'submitted',
      scores: parsed.scores,
      playerStats: parsed.playerStats,
      source: 'qbtcp',
      transportResultId: result.id,
      rawQbj: qbj,
      finishedAt: now,
    };
    state.games.push(game);
    state.submissions.push({
      id: newDirectorId('submission'),
      gameId,
      transportResultId: result.id,
      sessionId: result.sessionId,
      receivedAt: now,
      fingerprint: result.fingerprint,
      status: result.reviewRequired ? 'review' : 'received',
      rawSubmission: {
        protocol: 'QBTCP v1',
        resultId: result.id,
        qbj,
        rawBase64: result.rawBase64,
      },
      warnings: result.warnings,
      conflictWith: result.conflictWith,
    });
    if (scheduled && scheduled.status !== 'accepted') scheduled.status = 'submitted';
    const session = state.qbtcpSessions.find((entry) => entry.sessionId === result.sessionId);
    if (session) {
      session.state = 'result-received';
      session.lastSeenAt = now;
    } else {
      const progress = snapshot.progress.find((entry) => entry.sessionId === result.sessionId);
      state.qbtcpSessions.push({
        roomId: progress?.roomId ?? scheduled?.roomId ?? '',
        sessionId: result.sessionId,
        deviceId: '',
        state: 'result-received',
        lastSeenAt: now,
        progress: progress ? progressSummary(progress.matchState, state, progress.roomId) : null,
        helpRequestId: null,
      });
    }
    if (scheduled?.roomId) {
      const room = state.rooms.find((entry) => entry.id === scheduled.roomId);
      if (room && room.status !== 'finished') room.status = 'finished';
    }
    state.audit.push({
      id: newDirectorId('audit'),
      at: now,
      actor: 'QBTCP',
      type: 'result-received',
      summary: `Received a result for ${scheduled ? gameLabel(state, scheduled.id) : (matchId ?? 'an unmatched game')}.`,
      entityId: gameId,
      details: {
        transportResultId: result.id,
        warnings: result.warnings,
        conflictWith: result.conflictWith,
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
  return state.scheduledGames.find((game) => {
    const record = state.games.find((entry) => entry.scheduledGameId === game.id && entry.rawQbj);
    return matchIdentity(record?.rawQbj) === matchId;
  });
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
): { scores: TeamGameScore[]; playerStats: PlayerGameStat[] } {
  const match = matchObject(value);
  const entries = Array.isArray(match?.match_teams) ? match.match_teams : [];
  const scores = entries
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const teamId = resultTeamId(record.team, state, scheduled);
      const score = finiteNumber(record.points);
      if (!teamId || score === undefined) return null;
      const stats = teamAggregate(record, state);
      return { teamId, score, ...stats };
    })
    .filter((entry): entry is TeamGameScore => entry !== null);
  const playerStats = entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const teamId = resultTeamId(record.team, state, scheduled);
    if (!teamId || !Array.isArray(record.match_players)) return [];
    return record.match_players.flatMap((candidate): PlayerGameStat[] => {
      if (!candidate || typeof candidate !== 'object') return [];
      const playerRecord = candidate as Record<string, unknown>;
      const playerName = namedValue(playerRecord.player);
      const player = state.players.find(
        (entry) =>
          entry.teamId === teamId && entry.name.toLocaleLowerCase() === playerName?.toLocaleLowerCase(),
      );
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
          tossupsHeard: finiteNumber(playerRecord.tossups_heard)
            ? Number(playerRecord.tossups_heard)
            : powers + gets + negs,
        },
      ];
    });
  });
  return { scores, playerStats };
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
): string | undefined {
  const identity = namedIdentity(value);
  const candidates = [scheduled?.leftTeamId, scheduled?.rightTeamId].filter((entry): entry is string =>
    Boolean(entry),
  );
  if (identity && candidates.includes(identity)) return identity;
  const team = state.teams.find(
    (entry) =>
      entry.id === identity || entry.displayName.toLocaleLowerCase() === identity?.toLocaleLowerCase(),
  );
  return team?.id;
}

function namedIdentity(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === 'string') return record.$ref;
  if (typeof record.id === 'string') return record.id;
  return typeof record.name === 'string' ? record.name : undefined;
}

function namedValue(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' ? record.name : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function progressSummary(
  value: unknown,
  state: DirectorState,
  roomId: string,
): NonNullable<DirectorState['qbtcpSessions'][number]['progress']> {
  const match = matchObject(value);
  const entries = Array.isArray(match?.match_teams) ? match.match_teams : [];
  const scheduled = state.scheduledGames.find(
    (game) => game.roomId === roomId && game.status !== 'cancelled',
  );
  const points = entries.map((entry) => {
    if (!entry || typeof entry !== 'object') return undefined;
    return finiteNumber((entry as Record<string, unknown>).points);
  });
  return {
    tossupsRead: finiteNumber(match?.tossups_read) ?? 0,
    leftScore: points[0] ?? 0,
    rightScore: points[1] ?? (scheduled?.rightTeamId ? 0 : 0),
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
