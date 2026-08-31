/**
 * QBSheet's exact, credential-free transfer file.
 *
 * QBJ remains the interoperable result format. This file is deliberately a separate envelope for
 * moving the state of this scorer to another device: the frozen game definition, event journal,
 * action-level undo/redo, and transfer-safe room clocks. The serializer is an allowlist rather than
 * a record dump so a connection token, browser id, or an accidental future field cannot hitch a
 * ride onto a USB stick.
 */
import { GameDefinitionOrigin, IGameDefinition, IQbjIdentity } from '../game/GameDefinition';
import {
  gamePackageFormat,
  IGamePackage,
  IGamePackageTeam,
  IGamePackage as PackageShape,
} from '../game/GamePackage';
import { validateGamePackage } from '../game/GamePackageValidation';
import { IRoomProcedure } from '../scoring/RoomProcedure';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { IGameSetup } from '../scoring/deriveGame';
import { ScoreEvent } from '../scoring/ScoreEvents';
import { validEvent, validSetup } from './ScorerRecovery';
import { IGameSessionHistory } from './GameSession';
import { IRoomClockState, normalizeRoomClock } from './RoomClock';
import {
  DisplaySideMapping,
  ISerializedDisplaySideMapping,
  parseDisplaySideMapping,
  serializeDisplaySideMapping,
} from './DisplaySideMapping';
import { PlayerSeating } from './PlayerSeating';
import { validateCorrectedHistory } from '../scoring/validateScoresheet';

/** Top-level discriminator. It must never be confused with an official QBJ document. */
export const qbsheetBackupKind = 'qbsheet-backup' as const;
/** Bump only when the backup shape can no longer be interpreted safely. */
export const qbsheetBackupVersion = 1;
/** The explicit, QBSheet-specific transfer extension. */
export const qbsheetBackupFileExtension = '.qbsheet';
/** Keep a broken or unexpectedly huge transfer from consuming a Chromebook's memory. */
export const maxQbsheetBackupBytes = 8 * 1024 * 1024;

export interface IQbsheetBackupDisplayState {
  /** Presentation-only mapping. Canonical event teams are never changed. */
  mapping?: DisplaySideMapping;
  /** Presentation-only player row/keyboard order, scoped to known roster names. */
  seating?: PlayerSeating;
}

export interface IQbsheetBackup {
  kind: typeof qbsheetBackupKind;
  version: number;
  /** Sanitized game definition. It intentionally has no `connected` or `gameKey` field. */
  package: IGamePackage;
  setup: IGameSetup;
  events: ScoreEvent[];
  /** Optional for defensive compatibility with backups that predate action metadata. */
  history?: IGameSessionHistory;
  /** Segment ids map to paused-at-export clock states. */
  clocks?: Record<string, IRoomClockState>;
  displaySideMapping?: ISerializedDisplaySideMapping;
  playerSeating?: PlayerSeating;
}

export interface IQbsheetBackupInput {
  gamePackage: IGamePackage;
  setup: IGameSetup;
  events: readonly ScoreEvent[];
  history?: IGameSessionHistory;
  clocks?: Readonly<Record<string, IRoomClockState>>;
  display?: IQbsheetBackupDisplayState;
}

export type QbsheetBackupReadResult = { ok: true; value: IQbsheetBackup } | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function cloneIdentity(value: unknown): IQbjIdentity | undefined {
  if (!isPlainObject(value)) return undefined;
  const raw = value as Partial<IQbjIdentity>;
  const strings = [
    'tournamentId',
    'matchId',
    'phaseId',
    'roundId',
    'roundQbjName',
    'phaseName',
    'scoringRulesId',
  ];
  const result: IQbjIdentity = {};
  for (const field of strings) {
    const next = optionalString(raw[field as keyof IQbjIdentity]);
    if (next !== undefined) result[field as keyof IQbjIdentity] = next as never;
  }
  for (const field of ['teamIds', 'registrationIds'] as const) {
    const block = raw[field];
    if (!isPlainObject(block)) continue;
    const next: { left?: string; right?: string } = {};
    if (typeof block.left === 'string' && block.left !== '') next.left = block.left;
    if (typeof block.right === 'string' && block.right !== '') next.right = block.right;
    if (next.left !== undefined || next.right !== undefined) result[field] = next;
  }
  if (isPlainObject(raw.playerIds)) {
    const playerIds: Record<string, string> = {};
    for (const [key, id] of Object.entries(raw.playerIds)) {
      if (typeof id === 'string' && id !== '') playerIds[key] = id;
    }
    if (Object.keys(playerIds).length > 0) result.playerIds = playerIds;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function cloneFormat(value: IScorekeeperFormat): IScorekeeperFormat {
  return {
    version: value.version,
    name: value.name,
    answerTypes: value.answerTypes.map((answerType) => ({
      index: answerType.index,
      value: answerType.value,
      label: answerType.label,
      shortLabel: answerType.shortLabel,
      isPower: answerType.isPower,
      isNeg: answerType.isNeg,
      awardsBonus: answerType.awardsBonus,
      qbjId: answerType.qbjId,
    })),
    regulation: {
      timed: value.regulation.timed,
      tossupCount: value.regulation.tossupCount,
      maximumTossupCount: value.regulation.maximumTossupCount,
    },
    bonus: {
      enabled: value.bonus.enabled,
      bounceBack: value.bonus.bounceBack,
      regular: value.bonus.regular,
      divisor: value.bonus.divisor,
      minimumParts: value.bonus.minimumParts,
      maximumParts: value.bonus.maximumParts,
      ...(value.bonus.pointsPerPart === undefined ? {} : { pointsPerPart: value.bonus.pointsPerPart }),
      maximumScore: value.bonus.maximumScore,
    },
    overtime: {
      minimumQuestionCount: value.overtime.minimumQuestionCount,
      suddenDeath: value.overtime.suddenDeath,
      includesBonuses: value.overtime.includesBonuses,
    },
    lightning: {
      enabled: value.lightning.enabled,
      countPerTeam: value.lightning.countPerTeam,
      divisor: value.lightning.divisor,
    },
    players: { maximumActive: value.players.maximumActive },
    totalDivisor: value.totalDivisor,
  };
}

function cloneProcedure(value: IRoomProcedure): IRoomProcedure {
  return {
    version: value.version,
    halves: value.halves,
    ...(value.breaks
      ? {
          breaks: value.breaks.map((roomBreak) => ({
            afterTossup: roomBreak.afterTossup,
            ...(roomBreak.label === undefined ? {} : { label: roomBreak.label }),
          })),
        }
      : {}),
    ...(value.halfLengthMinutes === undefined ? {} : { halfLengthMinutes: value.halfLengthMinutes }),
    timeoutsPerTeam: value.timeoutsPerTeam,
    ...(value.timeoutDurationSeconds === undefined
      ? {}
      : { timeoutDurationSeconds: value.timeoutDurationSeconds }),
    ...(value.protestCheckpoints === undefined ? {} : { protestCheckpoints: value.protestCheckpoints }),
    ...(value.substitutionPolicy === undefined ? {} : { substitutionPolicy: value.substitutionPolicy }),
  };
}

function cloneTeam(value: IGamePackageTeam): IGamePackageTeam {
  return {
    name: value.name,
    players: value.players.map((player) => ({ name: player.name })),
    ...(value.startingLineup ? { startingLineup: value.startingLineup.slice() } : {}),
  };
}

/** Explicitly copy the package fields that define a game, and only those fields. */
function serializePackage(value: IGamePackage): IGamePackage {
  const definition = value as IGameDefinition;
  return {
    format: gamePackageFormat,
    version: value.version,
    ...(value.producer ? { producer: 'QBSheet' as const } : {}),
    tournament: {
      ...(value.tournament.key ? { key: value.tournament.key } : {}),
      name: value.tournament.name,
    },
    ...(value.scheduledMatchId ? { scheduledMatchId: value.scheduledMatchId } : {}),
    round: {
      number: value.round.number,
      name: value.round.name,
      revision: value.round.revision,
      ...(value.round.packetName ? { packetName: value.round.packetName } : {}),
    },
    ...(value.room && (value.room.id || value.room.name)
      ? {
          room: {
            ...(value.room.id ? { id: value.room.id } : {}),
            ...(value.room.name ? { name: value.room.name } : {}),
          },
        }
      : {}),
    left: cloneTeam(value.left),
    right: cloneTeam(value.right),
    scorekeeperFormat: cloneFormat(value.scorekeeperFormat),
    ...(value.procedure ? { procedure: cloneProcedure(value.procedure) } : {}),
    ...(value.handoffInstruction ? { handoffInstruction: value.handoffInstruction } : {}),
    ...(definition.origin !== undefined ? { origin: definition.origin } : {}),
    ...(definition.assumptions ? { assumptions: definition.assumptions.slice() } : {}),
    ...(definition.qbjIdentity ? { qbjIdentity: cloneIdentity(definition.qbjIdentity) } : {}),
  } as IGameDefinition;
}

function cloneSetup(value: IGameSetup): IGameSetup {
  return {
    left: {
      name: value.left.name,
      players: value.left.players.slice(),
      ...(value.left.startingLineup ? { startingLineup: value.left.startingLineup.slice() } : {}),
    },
    right: {
      name: value.right.name,
      players: value.right.players.slice(),
      ...(value.right.startingLineup ? { startingLineup: value.right.startingLineup.slice() } : {}),
    },
  };
}

/**
 * The names presentation state may safely contain.
 *
 * A roster can grow locally after the package was assigned. Those additions live in the event
 * history, not in the frozen package, so checking the package alone would silently discard the
 * seating a scorekeeper just arranged for a legitimate substitute. Setup covers definition-level
 * corrections; roster-add events cover the rest. Nothing outside those explicit sources is
 * admitted to the portable preference.
 */
function knownRosterNames(
  packageValue: IGamePackage,
  setup?: IGameSetup,
  events: readonly ScoreEvent[] = [],
): Record<'left' | 'right', Set<string>> {
  const names: Record<'left' | 'right', Set<string>> = {
    left: new Set([
      ...packageValue.left.players.map((player) => player.name),
      ...(setup?.left.players ?? []),
    ]),
    right: new Set([
      ...packageValue.right.players.map((player) => player.name),
      ...(setup?.right.players ?? []),
    ]),
  };
  for (const event of events) {
    if (event.type === 'roster-add') names[event.team].add(event.playerName);
  }
  return names;
}

function cloneSeating(
  value: unknown,
  packageValue: IGamePackage,
  setup?: IGameSetup,
  events: readonly ScoreEvent[] = [],
): PlayerSeating | undefined {
  if (!isPlainObject(value)) return undefined;
  const rosterNames = knownRosterNames(packageValue, setup, events);
  const copySide = (side: 'left' | 'right'): string[] => {
    const raw = value[side];
    if (!Array.isArray(raw)) return [];
    return Array.from(
      new Set(raw.filter((name): name is string => typeof name === 'string' && rosterNames[side].has(name))),
    );
  };
  const seating = { left: copySide('left'), right: copySide('right') };
  return seating.left.length > 0 || seating.right.length > 0 ? seating : undefined;
}

/** Copy every event union member through an explicit field list. */
export function serializeScoreEvent(event: ScoreEvent): ScoreEvent {
  const base = { id: event.id, questionNumber: event.questionNumber };
  switch (event.type) {
    case 'tossup-buzz':
      return {
        ...base,
        type: event.type,
        team: event.team,
        playerName: event.playerName,
        answerTypeIndex: event.answerTypeIndex,
      };
    case 'tossup-no-penalty':
      return {
        ...base,
        type: event.type,
        team: event.team,
        ...(event.playerName === undefined ? {} : { playerName: event.playerName }),
      };
    case 'tossup-reading-resumed':
    case 'tossup-readout':
    case 'tossup-dead':
    case 'half-resume':
    case 'begin-overtime':
    case 'begin-sudden-death':
    case 'timeout-resume':
      return { ...base, type: event.type };
    case 'bonus':
      return {
        ...base,
        type: event.type,
        team: event.team,
        ...(event.parts
          ? {
              parts: event.parts.map((part) => ({
                controlledPoints: part.controlledPoints,
                ...(part.bouncebackPoints === undefined ? {} : { bouncebackPoints: part.bouncebackPoints }),
              })),
            }
          : {}),
        ...(event.controlledPoints === undefined ? {} : { controlledPoints: event.controlledPoints }),
        ...(event.bouncebackPoints === undefined ? {} : { bouncebackPoints: event.bouncebackPoints }),
      };
    case 'lightning':
      return { ...base, type: event.type, team: event.team, points: event.points };
    case 'roster-add':
      return { ...base, type: event.type, team: event.team, playerName: event.playerName };
    case 'substitution':
      return { ...base, type: event.type, team: event.team, activePlayers: event.activePlayers.slice() };
    case 'end-regulation':
      return {
        ...base,
        type: event.type,
        ...(event.lastRegulationQuestion === undefined
          ? {}
          : { lastRegulationQuestion: event.lastRegulationQuestion }),
      };
    case 'half-break':
      return { ...base, type: event.type, lastQuestion: event.lastQuestion };
    case 'timeout':
      return { ...base, type: event.type, team: event.team };
    case 'timeout-start':
      return {
        ...base,
        type: event.type,
        team: event.team,
        ...(event.startedAt === undefined ? {} : { startedAt: event.startedAt }),
      };
    case 'protest':
      return {
        ...base,
        type: event.type,
        team: event.team,
        subject: event.subject,
        description: event.description,
        status: event.status,
        ...(event.resolution === undefined ? {} : { resolution: event.resolution }),
      };
    case 'question-void':
      return { ...base, type: event.type, scope: event.scope, reason: event.reason };
    case 'end-game-early':
      return { ...base, type: event.type, reason: event.reason, tossupsRead: event.tossupsRead };
    case 'adjustment':
      return {
        ...base,
        type: event.type,
        team: event.team,
        points: event.points,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      };
    case 'forfeit':
      return { ...base, type: event.type, teams: event.teams.slice() };
    case 'procedure-exception':
      return {
        ...base,
        type: event.type,
        allowance: event.allowance,
        authority: event.authority,
        reason: event.reason,
        ...(event.team === undefined ? {} : { team: event.team }),
        ...(event.playerName === undefined ? {} : { playerName: event.playerName }),
      };
    case 'note':
      return {
        ...base,
        type: event.type,
        text: event.text,
        ...(event.flagged === undefined ? {} : { flagged: event.flagged }),
      };
  }
}

function cloneHistory(
  value: IGameSessionHistory | undefined,
  events: readonly ScoreEvent[],
): IGameSessionHistory | undefined {
  if (!value) return undefined;
  const undo = value.undo.slice();
  const redo = value.redo.map((frame) => frame.map(serializeScoreEvent));
  const valid =
    undo.every((frame) => Number.isInteger(frame) && frame > 0) &&
    undo.reduce((sum, frame) => sum + frame, 0) <= events.length &&
    redo.every((frame) => frame.length > 0 && frame.every(validEvent));
  return valid ? { undo, redo } : undefined;
}

function cloneClock(value: IRoomClockState): IRoomClockState {
  const normalized = normalizeRoomClock(value, value.durationMs);
  if (normalized.status !== 'running') return normalized;
  // A backup should never carry a running timestamp across devices. Preserve the exact accumulated
  // amount and make the destination start paused rather than charging transfer time.
  return {
    version: normalized.version,
    durationMs: normalized.durationMs,
    status: 'paused',
    accumulatedMs: normalized.accumulatedMs,
    pauseReason: 'manual',
  };
}

function cloneClocks(
  value: Readonly<Record<string, IRoomClockState>> | undefined,
): Record<string, IRoomClockState> | undefined {
  if (!value) return undefined;
  const clocks: Record<string, IRoomClockState> = {};
  for (const [segment, state] of Object.entries(value)) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) continue;
    if (
      !isPlainObject(state) ||
      typeof state.durationMs !== 'number' ||
      !Number.isFinite(state.durationMs) ||
      state.durationMs < 0
    )
      continue;
    clocks[segment] = cloneClock(state);
  }
  return Object.keys(clocks).length > 0 ? clocks : undefined;
}

/** Build a sanitized transfer object. */
export function createQbsheetBackup(input: IQbsheetBackupInput): IQbsheetBackup {
  const events = input.events.map(serializeScoreEvent);
  const history = cloneHistory(input.history, events);
  const displaySideMapping = input.display?.mapping
    ? serializeDisplaySideMapping(input.display.mapping)
    : undefined;
  const packageValue = serializePackage(input.gamePackage);
  const playerSeating = cloneSeating(input.display?.seating, packageValue, input.setup, events);
  const clocks = cloneClocks(input.clocks);
  return {
    kind: qbsheetBackupKind,
    version: qbsheetBackupVersion,
    package: packageValue,
    setup: cloneSetup(input.setup),
    events,
    ...(history ? { history } : {}),
    ...(clocks ? { clocks } : {}),
    ...(displaySideMapping ? { displaySideMapping } : {}),
    ...(playerSeating ? { playerSeating } : {}),
  };
}

/** Serialize after rebuilding the allowlisted shape, even if a caller hands us an object with extras. */
export function serializeQbsheetBackup(backup: IQbsheetBackup): string {
  return JSON.stringify(
    createQbsheetBackup({
      gamePackage: backup.package,
      setup: backup.setup,
      events: backup.events,
      history: backup.history,
      clocks: backup.clocks,
      display: backup.displaySideMapping
        ? {
            mapping: parseDisplaySideMapping(backup.displaySideMapping) ?? undefined,
            seating: backup.playerSeating,
          }
        : { seating: backup.playerSeating },
    }),
    null,
    2,
  );
}

function readHistory(value: unknown, events: ScoreEvent[]): IGameSessionHistory | undefined {
  if (!isPlainObject(value) || !Array.isArray(value.undo) || !Array.isArray(value.redo)) return undefined;
  const undo = value.undo as unknown[];
  const redo = value.redo as unknown[];
  if (!undo.every((frame) => typeof frame === 'number' && Number.isInteger(frame) && frame > 0))
    return undefined;
  const undoFrames = undo as number[];
  if (undoFrames.reduce((sum, frame) => sum + frame, 0) > events.length) return undefined;
  if (
    !redo.every(
      (frame) => Array.isArray(frame) && frame.length > 0 && frame.every((event) => validEvent(event)),
    )
  )
    return undefined;
  return {
    undo: undoFrames,
    redo: redo.map((frame) => (frame as unknown[]).map((event) => serializeScoreEvent(event as ScoreEvent))),
  };
}

function readSetup(value: unknown): IGameSetup | null {
  if (!validSetup(value)) return null;
  return cloneSetup(value);
}

function readClocks(value: unknown): Record<string, IRoomClockState> | undefined {
  if (!isPlainObject(value)) return undefined;
  const clocks: Record<string, IRoomClockState> = {};
  for (const [segment, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment) || !isPlainObject(raw)) continue;
    const durationMs = raw.durationMs;
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) continue;
    const normalized = normalizeRoomClock(raw, durationMs);
    clocks[segment] = cloneClock(normalized);
  }
  return Object.keys(clocks).length > 0 ? clocks : undefined;
}

function readDisplay(value: unknown): ISerializedDisplaySideMapping | undefined {
  const mapping = parseDisplaySideMapping(value);
  if (!mapping) return undefined;
  return serializeDisplaySideMapping(mapping);
}

function readSeating(
  value: unknown,
  packageValue: IGamePackage,
  setup: IGameSetup,
  events: readonly ScoreEvent[],
): PlayerSeating | undefined {
  return cloneSeating(value, packageValue, setup, events);
}

function restoreDefinitionMetadata(packageValue: PackageShape, raw: unknown): IGamePackage {
  if (!isPlainObject(raw)) return packageValue;
  const definition = raw as Partial<IGameDefinition>;
  const origins: GameDefinitionOrigin[] = ['qbj', 'qbj-match-only', 'qbg', 'legacy-assignment', 'manual'];
  const origin = origins.includes(definition.origin as GameDefinitionOrigin) ? definition.origin : undefined;
  const assumptions = Array.isArray(definition.assumptions)
    ? definition.assumptions.filter((item): item is string => typeof item === 'string' && item !== '')
    : undefined;
  const qbjIdentity = cloneIdentity(definition.qbjIdentity);
  return {
    ...packageValue,
    ...(origin ? { origin } : {}),
    ...(assumptions && assumptions.length > 0 ? { assumptions } : {}),
    ...(qbjIdentity ? { qbjIdentity } : {}),
  } as IGameDefinition;
}

/** Read only this version of the QBSheet envelope. */
export function readQbsheetBackup(value: unknown): QbsheetBackupReadResult {
  if (!isPlainObject(value) || value.kind !== qbsheetBackupKind) {
    return { ok: false, errors: ['This is not a QBSheet backup.'] };
  }
  if (typeof value.version !== 'number' || !Number.isInteger(value.version)) {
    return { ok: false, errors: ['This QBSheet backup does not say which version it uses.'] };
  }
  if (value.version > qbsheetBackupVersion) {
    return {
      ok: false,
      errors: [
        `This QBSheet backup was made by a newer version (${value.version}). Update QBSheet before opening it.`,
      ],
    };
  }
  if (value.version < qbsheetBackupVersion) {
    return {
      ok: false,
      errors: [`This QBSheet backup uses version ${value.version}, which this QBSheet cannot read.`],
    };
  }
  const packageResult = validateGamePackage(value.package);
  if (!packageResult.ok)
    return {
      ok: false,
      errors: ['The QBSheet backup has an unusable game definition.', ...packageResult.errors],
    };
  const setup = readSetup(value.setup);
  if (!setup) return { ok: false, errors: ['The QBSheet backup has an unusable scoring roster.'] };
  if (
    setup.left.name !== packageResult.value.left.name ||
    setup.right.name !== packageResult.value.right.name
  ) {
    return { ok: false, errors: ['The QBSheet backup roster does not match its game definition.'] };
  }
  if (!Array.isArray(value.events) || !value.events.every(validEvent)) {
    return {
      ok: false,
      errors: ['The QBSheet backup has a malformed event history. No scoring history was imported.'],
    };
  }
  const events = value.events.map((event) => serializeScoreEvent(event));
  const history = readHistory(value.history, events);
  const clocks = readClocks(value.clocks);
  const displaySideMapping = readDisplay(value.displaySideMapping);
  const playerSeating = readSeating(value.playerSeating, packageResult.value, setup, events);
  const validation = validateCorrectedHistory(
    packageResult.value.scorekeeperFormat,
    setup,
    events,
    packageResult.value.procedure,
  );
  // A scorekeeper may add a late-arriving player from the starting-lineup prompt before choosing
  // either side's starters. Those roster-add events are real recovery history, while
  // `missing-lineup` is the expected prompt state rather than an impossible game. Permit exactly
  // that narrow pre-start case. A tossup or any other operation without a lineup still fails closed.
  const preLineupRosterEdits =
    events.length > 0 &&
    events.every((event) => event.type === 'roster-add') &&
    validation.blockers.length > 0 &&
    validation.blockers.every((blocker) => blocker.code === 'missing-lineup');
  if (events.length > 0 && validation.blockers.length > 0 && !preLineupRosterEdits) {
    return {
      ok: false,
      errors: ['The QBSheet backup contains an impossible event history. No scoring history was imported.'],
    };
  }
  return {
    ok: true,
    value: {
      kind: qbsheetBackupKind,
      version: qbsheetBackupVersion,
      package: restoreDefinitionMetadata(packageResult.value, value.package),
      setup,
      events,
      ...(history ? { history } : {}),
      ...(clocks ? { clocks } : {}),
      ...(displaySideMapping ? { displaySideMapping } : {}),
      ...(playerSeating ? { playerSeating } : {}),
    },
  };
}
