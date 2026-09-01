/**
 * A game file is untrusted input, and is treated like one.
 *
 * The file arrives by whatever route the tournament chose — a shared folder, a USB stick, an email
 * attachment, a download from a server on a hotel Wi-Fi. Nothing about that route is a guarantee,
 * and the failure this exists to prevent is not a security breach so much as a room that is forty
 * minutes into a game before discovering the roster was truncated or the bonus structure was
 * nonsense.
 *
 * # Refuse, completely, with a reason
 *
 * A malformed package never partially starts a game. There is no repair, no defaulting, no "best
 * effort" reading: a package is either something a room can score a real game against or it is a
 * file with problems, listed, that somebody has to fix upstream. Half a roster is worse than no
 * roster, because a room can notice no roster.
 *
 * The one deliberate exception is `procedure`, which describes how a room *conducts* a game rather
 * than what anything is worth. A malformed procedure is normalized to "the room runs none of it"
 * by `readRoomProcedure`, because the worst case is a room that does not offer a halftime break it
 * was supposed to — recoverable — against a room that cannot open the file at all, which is not.
 *
 * # Bounds before content
 *
 * Every length is capped before anything is walked, and the caps are far above any real tournament
 * and far below anything that would cost a Chromebook its memory. A 200-megabyte array of strings
 * is a denial of service against a room, whatever the intent behind it was.
 */
import {
  IGamePackage,
  IGamePackageTeam,
  gamePackageFormat,
  gamePackageProducer,
  gamePackageVersion,
} from './GamePackage';
import { playerNameMaxLength } from './Roster';
import {
  IScorekeeperFormat,
  scorekeeperFormatProblems,
  scorekeeperFormatVersion,
} from '../scoring/ScorekeeperFormat';
import { isKnownRoomProcedureVersion, readRoomProcedure } from '../scoring/RoomProcedure';

/**
 * Largest game file that will even be read into memory.
 *
 * A real package is a few kilobytes: two rosters, a rule set, and some labels. A megabyte is three
 * orders of magnitude of headroom and still small enough that a refusal is instant.
 */
export const maxGamePackageBytes = 1024 * 1024;

/** Caps chosen to be absurd for a real tournament and cheap to check. */
export const maxPlayersPerTeam = 200;
export const maxTextLength = 500;
export const maxAnswerTypes = 50;
export const maxHandoffInstructionLength = 2000;

export type GamePackageValidation = { ok: true; value: IGamePackage } | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlankString(value: unknown, max = maxTextLength): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate the parts of a scoring format a game actually depends on.
 *
 * `scorekeeperFormatProblems` already says whether a format describes a playable game, but it
 * assumes it was handed a well-formed object. This runs first and checks that it was.
 */
function formatStructureProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObject(value)) return ['The scoring rules are missing or are not an object.'];
  const format = value as Partial<IScorekeeperFormat>;

  if (format.version !== scorekeeperFormatVersion) {
    return [`The scoring rules are version ${String(format.version)}, which this scoresheet cannot read.`];
  }
  if (typeof format.name !== 'string') problems.push('The scoring rules have no name.');

  if (!Array.isArray(format.answerTypes)) {
    problems.push('The scoring rules have no answer types.');
  } else if (format.answerTypes.length > maxAnswerTypes) {
    problems.push('The scoring rules list an implausible number of answer types.');
  } else {
    format.answerTypes.forEach((answerType, position) => {
      if (!isPlainObject(answerType)) {
        problems.push(`Answer type ${position + 1} is not an object.`);
        return;
      }
      if (answerType.index !== position) {
        problems.push(`Answer type ${position + 1} is out of order or has the wrong index.`);
      }
      if (!finiteNumber(answerType.value)) {
        problems.push(`Answer type ${position + 1} has no point value.`);
      }
      if (typeof answerType.label !== 'string' || typeof answerType.shortLabel !== 'string') {
        problems.push(`Answer type ${position + 1} has no label.`);
      }
    });
  }

  for (const [section, fields] of [
    ['regulation', ['tossupCount', 'maximumTossupCount']],
    ['bonus', ['divisor', 'minimumParts', 'maximumParts', 'maximumScore']],
    ['overtime', ['minimumQuestionCount']],
    ['lightning', ['countPerTeam', 'divisor']],
    ['players', ['maximumActive']],
  ] as const) {
    const block = (format as Record<string, unknown>)[section];
    if (!isPlainObject(block)) {
      problems.push(`The scoring rules have no ${section} section.`);
      continue;
    }
    for (const field of fields) {
      if (!finiteNumber(block[field]))
        problems.push(`The scoring rules' ${section}.${field} is not a number.`);
    }
  }

  if (!finiteNumber(format.totalDivisor)) problems.push("The scoring rules' totalDivisor is not a number.");

  if (problems.length > 0) return problems;
  // Structurally sound. Now ask whether it describes a game anybody could play.
  return scorekeeperFormatProblems(format as IScorekeeperFormat);
}

function teamProblems(value: unknown, side: 'left' | 'right', maximumActive: number): string[] {
  const problems: string[] = [];
  if (!isPlainObject(value)) return [`The ${side} team is missing.`];
  const team = value as Partial<IGamePackageTeam>;

  if (!nonBlankString(team.name)) problems.push(`The ${side} team has no name.`);

  if (!Array.isArray(team.players)) {
    problems.push(`The ${side} team has no roster.`);
    return problems;
  }
  if (team.players.length === 0) problems.push(`The ${side} team's roster is empty.`);
  if (team.players.length > maxPlayersPerTeam) {
    problems.push(`The ${side} team's roster lists an implausible number of players.`);
    return problems;
  }

  const seen = new Set<string>();
  team.players.forEach((player, position) => {
    if (!isPlainObject(player) || !nonBlankString(player.name, playerNameMaxLength)) {
      problems.push(`Player ${position + 1} on the ${side} team has no usable name.`);
      return;
    }
    if (seen.has(player.name)) {
      problems.push(`The ${side} team lists "${player.name}" more than once.`);
    }
    seen.add(player.name);
  });

  if (team.startingLineup !== undefined) {
    if (!Array.isArray(team.startingLineup)) {
      problems.push(`The ${side} team's starting lineup is not a list.`);
    } else if (team.startingLineup.length === 0) {
      problems.push(`The ${side} team's starting lineup is empty.`);
    } else if (team.startingLineup.length > maximumActive) {
      problems.push(`The ${side} team's starting lineup has more than ${maximumActive} players in it.`);
    } else {
      const started = new Set<string>();
      team.startingLineup.forEach((name) => {
        if (typeof name !== 'string' || !seen.has(name)) {
          problems.push(`The ${side} team's starting lineup names somebody who is not on the roster.`);
          return;
        }
        if (started.has(name)) {
          problems.push(`The ${side} team's starting lineup names "${name}" twice.`);
        }
        started.add(name);
      });
    }
  }

  return problems;
}

/**
 * Read an already-parsed value as a game package.
 *
 * @param value anything at all — this is the boundary
 */
export function validateGamePackage(value: unknown): GamePackageValidation {
  if (!isPlainObject(value)) return { ok: false, errors: ['This file does not contain a game.'] };

  const raw = value as Partial<IGamePackage> & Record<string, unknown>;

  if (raw.format !== gamePackageFormat) {
    return {
      ok: false,
      errors: ['This is not a game file. Game files start with "format": "quizbowl-game".'],
    };
  }
  if (raw.version !== gamePackageVersion) {
    return {
      ok: false,
      errors: [
        `This game file is version ${String(raw.version)}. This scoresheet reads version ${gamePackageVersion}. Ask tournament control for a file this device can read, or update the scoresheet.`,
      ],
    };
  }

  if (raw.producer !== undefined && raw.producer !== gamePackageProducer) {
    return {
      ok: false,
      errors: [
        `This game file was produced by ${String(raw.producer)}, which this scoresheet cannot verify.`,
      ],
    };
  }

  const errors: string[] = [];

  if (!isPlainObject(raw.tournament) || !nonBlankString(raw.tournament.name)) {
    errors.push('The game file does not say which tournament this is.');
  } else if (raw.tournament.key !== undefined && !nonBlankString(raw.tournament.key)) {
    errors.push("The tournament's identifier is not usable.");
  }

  if (!isPlainObject(raw.round)) {
    errors.push('The game file does not say which round this is.');
  } else {
    const round = raw.round as Partial<IGamePackage['round']>;
    if (!finiteNumber(round.number)) errors.push('The round has no number.');
    if (!nonBlankString(round.name)) errors.push('The round has no name.');
    if (!Number.isInteger(round.revision) || Number(round.revision) < 1) {
      errors.push(
        'The round has no usable revision. A game file must say which issue of the pairings it came from.',
      );
    }
    if (
      round.assignmentRevision !== undefined &&
      (!Number.isInteger(round.assignmentRevision) || Number(round.assignmentRevision) < 1)
    ) {
      errors.push('The round assignment revision is not usable.');
    }
    if (round.packetName !== undefined && !nonBlankString(round.packetName)) {
      errors.push('The packet name is not usable.');
    }
  }

  if (raw.room !== undefined) {
    if (!isPlainObject(raw.room)) errors.push('The room is not an object.');
    else {
      if (raw.room.id !== undefined && !nonBlankString(raw.room.id))
        errors.push("The room's identifier is not usable.");
      if (raw.room.name !== undefined && !nonBlankString(raw.room.name))
        errors.push("The room's name is not usable.");
    }
  }

  if (raw.scheduledMatchId !== undefined && !nonBlankString(raw.scheduledMatchId)) {
    errors.push('The scheduled game identifier is not usable.');
  }

  if (raw.handoffInstruction !== undefined) {
    if (
      typeof raw.handoffInstruction !== 'string' ||
      raw.handoffInstruction.length > maxHandoffInstructionLength
    ) {
      errors.push('The result instructions are not usable.');
    }
  }

  const formatErrors = formatStructureProblems(raw.scorekeeperFormat);
  errors.push(...formatErrors);

  const maximumActive =
    formatErrors.length === 0
      ? (raw.scorekeeperFormat as IScorekeeperFormat).players.maximumActive
      : maxPlayersPerTeam;
  errors.push(...teamProblems(raw.left, 'left', maximumActive));
  errors.push(...teamProblems(raw.right, 'right', maximumActive));

  if (
    isPlainObject(raw.left) &&
    isPlainObject(raw.right) &&
    nonBlankString(raw.left.name) &&
    raw.left.name === raw.right.name
  ) {
    errors.push('Both teams in this game have the same name. A team cannot play itself.');
  }

  if (raw.procedure !== undefined && !isPlainObject(raw.procedure)) {
    errors.push('The room procedure is not an object.');
  } else if (isPlainObject(raw.procedure) && !isKnownRoomProcedureVersion(raw.procedure.version)) {
    errors.push('The room procedure was written by a version this scoresheet does not know.');
  }

  if (errors.length > 0) return { ok: false, errors };

  // Rebuild rather than passing the parsed object through, so nothing the file carried beyond the
  // schema reaches the rest of the application — including anything credential-shaped that a
  // mistaken exporter put there.
  const format = raw.scorekeeperFormat as IScorekeeperFormat;
  const readTeam = (team: IGamePackageTeam): IGamePackageTeam => ({
    name: team.name,
    players: team.players.map((player) => ({ name: player.name })),
    ...(team.startingLineup ? { startingLineup: [...team.startingLineup] } : {}),
  });
  const round = raw.round as IGamePackage['round'];
  const room = raw.room as IGamePackage['room'] | undefined;

  return {
    ok: true,
    value: {
      format: gamePackageFormat,
      version: gamePackageVersion,
      ...(raw.producer ? { producer: gamePackageProducer } : {}),
      tournament: {
        ...(raw.tournament!.key ? { key: raw.tournament!.key } : {}),
        name: raw.tournament!.name,
      },
      ...(raw.scheduledMatchId ? { scheduledMatchId: raw.scheduledMatchId } : {}),
      round: {
        number: round.number,
        name: round.name,
        revision: round.revision,
        ...(round.assignmentRevision !== undefined ? { assignmentRevision: round.assignmentRevision } : {}),
        ...(round.packetName ? { packetName: round.packetName } : {}),
      },
      ...(room && (room.id || room.name)
        ? { room: { ...(room.id ? { id: room.id } : {}), ...(room.name ? { name: room.name } : {}) } }
        : {}),
      left: readTeam(raw.left as IGamePackageTeam),
      right: readTeam(raw.right as IGamePackageTeam),
      scorekeeperFormat: format,
      ...(raw.procedure ? { procedure: readRoomProcedure(raw.procedure) } : {}),
      ...(raw.handoffInstruction ? { handoffInstruction: raw.handoffInstruction } : {}),
    },
  };
}

/**
 * Read a game file's text.
 *
 * Separate from `validateGamePackage` so the connected path, which never sees a file, does not have
 * to pretend it did.
 */
export function readGamePackageText(text: string): GamePackageValidation {
  if (text.length > maxGamePackageBytes) {
    return { ok: false, errors: ['That file is too large to be a game file.'] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['That file is not readable as JSON.'] };
  }
  return validateGamePackage(parsed);
}
