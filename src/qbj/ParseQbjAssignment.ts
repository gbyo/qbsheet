/**
 * The one parser. Every game this scoresheet scores comes through here.
 *
 * # Why one
 *
 * There are four ways a game arrives — an official QBJ file, a QBJ document delivered over QBTCP, a
 * bare Match from MODAQ, and a legacy `.qbg` — and the tempting design gives each its own reader.
 * That design is how a connected room and an offline room end up scoring subtly different games from
 * the same tournament: one path learns that lineups can be referenced rather than embedded, the
 * other does not, and the bug is invisible until somebody plays a substitution offline.
 *
 * So the QBTCP assignment body *is* a QBJ document, and it lands on the same function a file does.
 * The network path contributes credentials and a base URL; it contributes no parsing.
 *
 * # Two phases, because the UI needs the gap
 *
 * Reading is split from defining. `readQbjSource` says what is in the document — which matches are
 * in it, whether they look played — without committing to one. `defineGame` turns a chosen match
 * into something the scorer can run, and can be told what the scorekeeper supplied for the parts the
 * document omitted.
 *
 * The gap between them is where the game picker and the missing-rules prompt live. A single-call
 * parser would have to either guess at those or fail, and guessing at scoring rules is the failure
 * this whole migration exists to avoid.
 *
 * # Forgiving about shape, strict about meaning
 *
 * QBJ producers disagree about almost everything structural: whether a team is embedded or `$ref`'d,
 * whether `Round` carries its matches or `Match` carries its round, whether an id is present at all.
 * All of that is absorbed. What is not absorbed is a missing point value, a roster with two players
 * of the same name, or scoring rules that do not describe a playable game — because those change
 * what a game is worth, and a parser that repairs them produces a mis-scored game nobody knows to
 * look for.
 */
import { IGameDefinition, IQbjIdentity, playerIdentityKey } from '../game/GameDefinition';
import { gamePackageFormat, gamePackageVersion } from '../game/GamePackage';
import { IRosterPlayer, ITeamRoster, playerNameMaxLength } from '../game/Roster';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import {
  IQbjDocument,
  QbjObject,
  QbjReadResult,
  finiteNumber,
  indexById,
  isPlainObject,
  nonBlankString,
  objectsOfType,
  parseQbjText,
  readQbjShape,
  resolveRef,
  wholeNumber,
} from './QbjSerialization';
import { readQbjScoringRules } from './QbjScoringRules';
import { IQbtcpExtension, readQbtcpExtension, unsupportedProcedureMessage } from './QbtcpExtension';

const maxPlayersPerTeam = 200;
const maxMatches = 4000;

/** How much scoring content a match already carries. Decides how it is offered, never whether. */
export type MatchPlayState =
  /** Nothing scored. The normal case for an assignment, and the one preferred by the picker. */
  | 'unplayed'
  /** Some scoring content, short of a full game. Offered as a resume source, with a warning. */
  | 'partial'
  /** A finished result. Never opened silently. */
  | 'complete';

/** One scoreable match in a document, described well enough to choose between them. */
export interface IQbjMatchCandidate {
  /** Position in the document's object list. The handle `defineGame` is given. */
  index: number;
  matchId?: string;
  phaseName?: string;
  roundName?: string;
  roundNumber?: number;
  location?: string;
  leftName: string;
  rightName: string;
  state: MatchPlayState;
}

/** A document that has been read and understood, but not yet committed to a single game. */
export interface IQbjSource {
  /** Null for a Match-only import, which has no envelope to carry a tournament. */
  document: IQbjDocument | null;
  /** The bare match, for a Match-only import. */
  matchOnly: QbjObject | null;
  candidates: IQbjMatchCandidate[];
  tournamentName?: string;
  tournamentId?: string;
}

export type DefineGameResult =
  | { ok: true; definition: IGameDefinition }
  | {
      ok: false;
      errors: string[];
      /**
       * The document did not carry usable scoring rules.
       *
       * Distinguished from an ordinary error because it is answerable: the scorekeeper can choose or
       * configure a format and the same call succeeds. An unanswerable error would be a roster with
       * a duplicate player, which nobody in the room can fix.
       */
      needsScoringRules?: boolean;
      /** Teams are known but at least one has no roster. Answerable by manual player entry. */
      needsRoster?: boolean;
      /**
       * The teams that need one, by the name the document gave them.
       *
       * Only the teams actually missing a roster. A document that lists one side's players and not
       * the other's should produce one question, not two, and asking again for a roster already in
       * the file is how a scorekeeper ends up retyping names that were right.
       */
      missingRosters?: string[];
    };

/** What the scorekeeper supplied for the parts a generic QBJ left out. */
export interface IGameDefinitionOverrides {
  /** A format chosen or configured in the room, used when the document carried none. */
  scorekeeperFormat?: IScorekeeperFormat;
  /** Rosters typed in the room, keyed by the team name as the document gave it. */
  rosters?: Record<string, IRosterPlayer[]>;
  /** Answers the timed question the document could not. */
  timed?: boolean;
}

function stringField(value: unknown, max = 500): string | undefined {
  return nonBlankString(value, max) ? value : undefined;
}

/** A team's display name, from a Team or a Registration, whichever the producer used. */
function teamName(team: QbjObject | null, registration: QbjObject | null): string | undefined {
  return stringField(team?.name) ?? stringField(registration?.name);
}

/**
 * Read a roster.
 *
 * An absent `players` array is not an error here — a schedule that names two teams without listing
 * anybody is a real and useful assignment, and the room types the names in. What is an error is a
 * roster that lists the same person twice, which silently merges two players' statistics.
 */
function readRoster(team: QbjObject | null): { players: IRosterPlayer[]; ids: Record<string, string>; problems: string[] } {
  const players: IRosterPlayer[] = [];
  const ids: Record<string, string> = {};
  const problems: string[] = [];
  if (!team || !Array.isArray(team.players)) return { players, ids, problems };

  if (team.players.length > maxPlayersPerTeam) {
    return { players, ids, problems: ['A roster lists an implausible number of players.'] };
  }

  const seen = new Set<string>();
  for (const entry of team.players) {
    if (!isPlainObject(entry)) continue;
    const name = stringField(entry.name, playerNameMaxLength);
    if (!name) continue;
    if (seen.has(name)) {
      problems.push(`A roster lists "${name}" more than once.`);
      continue;
    }
    seen.add(name);
    players.push({ name });
    const id = stringField(entry.id);
    if (id) ids[name] = id;
  }
  return { players, ids, problems };
}

/**
 * Clean a roster typed in the room, using the same rules a roster read from a file gets.
 *
 * This is the only place a supplied roster is normalized. The form in front of it shows problems as
 * they are typed, but it does not decide anything: a caller reaching `defineGame` some other way —
 * a test, a future host, the connected path — must get the same names and the same refusals, and a
 * second cleaning step somewhere else is how those drift.
 */
function normalizeSuppliedRoster(supplied: IRosterPlayer[], teamName_: string, errors: string[]): IRosterPlayer[] {
  if (supplied.length > maxPlayersPerTeam) {
    errors.push(`The roster for ${teamName_} lists an implausible number of players.`);
    return [];
  }
  const players: IRosterPlayer[] = [];
  const seen = new Set<string>();
  for (const entry of supplied) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (name === '' || name.length > playerNameMaxLength) continue;
    if (seen.has(name)) {
      errors.push(`The roster for ${teamName_} lists "${name}" more than once.`);
      continue;
    }
    seen.add(name);
    players.push({ name });
  }
  return players;
}

/** The two sides of a match, resolved through whichever indirection the producer chose. */
function matchSides(
  match: QbjObject,
  byId: ReadonlyMap<string, QbjObject>,
): { team: QbjObject | null; registration: QbjObject | null; matchTeam: QbjObject }[] {
  if (!Array.isArray(match.match_teams)) return [];
  return match.match_teams.filter(isPlainObject).map((matchTeam) => {
    const team = resolveRef(matchTeam.team, byId);
    // A Registration owns Teams; some producers point a match at the registration instead.
    const registration = team ? resolveRef(team.registration, byId) : null;
    return { team, registration, matchTeam };
  });
}

/** How much of a game a match already describes. */
function playState(match: QbjObject): MatchPlayState {
  const tossupsRead = finiteNumber(match.tossups_read) ? match.tossups_read : 0;
  const hasQuestions = Array.isArray(match.match_questions) && match.match_questions.length > 0;
  const hasPoints =
    Array.isArray(match.match_teams) &&
    match.match_teams.filter(isPlainObject).some((matchTeam) => finiteNumber(matchTeam.points) && matchTeam.points !== 0);

  if (tossupsRead === 0 && !hasQuestions && !hasPoints) return 'unplayed';
  // A game is treated as finished once it has read a plausible number of tossups. The threshold is
  // deliberately loose: the distinction only decides how the match is offered, and a wrong guess
  // toward "complete" is the safe direction — it means asking rather than overwriting.
  if (tossupsRead >= 1 && hasPoints && !hasQuestions) return 'complete';
  return tossupsRead > 0 || hasQuestions || hasPoints ? 'partial' : 'unplayed';
}

/**
 * The round's number, which standard QBJ does not have a field for.
 *
 * `Round` carries a `name` and nothing else numeric — the reference implementation keeps its own
 * round number in a file extension, and writes `name` as the bare number ("4") for an ordinary
 * round. Its importer resolves rounds by running `parseInt` over exactly this field, so doing the
 * same here reads what it writes, and reads any other producer that names rounds numerically.
 *
 * A non-numeric name ("Playoff 2", "Finals") yields nothing rather than a wrong number. A round
 * that cannot be numbered is not an error; it is a game scored without a round number.
 */
function roundNumberOf(round: QbjObject | null | undefined): number | undefined {
  if (!round) return undefined;
  // An explicit numeric field wins where a producer supplies one, standard or not.
  if (finiteNumber(round.number)) return round.number;
  if (typeof round.name !== 'string') return undefined;
  const parsed = Number.parseInt(round.name, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Where a match sits in the schedule: the round that holds it, and the phase that holds the round. */
export interface IRoundContext {
  round: QbjObject;
  phase: QbjObject | null;
}

/**
 * Index every match by the round and phase that own it.
 *
 * The schedule spine hangs off the Tournament — `Tournament.phases[].rounds[].matches[]` — and each
 * link may be embedded or a `$ref`. That is the traversal the reference implementation performs, so
 * a document it can read is a document this can read.
 *
 * Top-level `Phase` and `Round` objects are walked afterwards as a fallback, because some producers
 * emit them alongside the tournament rather than inside it. The tournament wins where both exist:
 * it is the one an importer will follow.
 */
function buildRoundIndex(document: IQbjDocument, byId: ReadonlyMap<string, QbjObject>): Map<QbjObject, IRoundContext> {
  const roundOfMatch = new Map<QbjObject, IRoundContext>();

  const indexRound = (roundRef: unknown, phase: QbjObject | null) => {
    const round = resolveRef(roundRef, byId);
    if (!round || !Array.isArray(round.matches)) return;
    for (const matchRef of round.matches) {
      const match = resolveRef(matchRef, byId);
      if (match && !roundOfMatch.has(match)) roundOfMatch.set(match, { round, phase });
    }
  };

  for (const tournament of objectsOfType(document, 'Tournament')) {
    for (const phaseRef of Array.isArray(tournament.phases) ? tournament.phases : []) {
      const phase = resolveRef(phaseRef, byId);
      if (!phase) continue;
      for (const roundRef of Array.isArray(phase.rounds) ? phase.rounds : []) indexRound(roundRef, phase);
    }
  }

  for (const phase of objectsOfType(document, 'Phase')) {
    for (const roundRef of Array.isArray(phase.rounds) ? phase.rounds : []) indexRound(roundRef, phase);
  }
  for (const round of objectsOfType(document, 'Round')) indexRound(round, null);

  return roundOfMatch;
}

/** Read a parsed QBJ value: what is in it, and what could be scored from it. */
export function readQbjSource(value: unknown): QbjReadResult<IQbjSource> {
  const shape = readQbjShape(value);
  if (!shape.ok) return shape;

  if (shape.value.kind === 'match-only') {
    const match = shape.value.match;
    const sides = matchSides(match, new Map());
    if (sides.length !== 2) {
      return { ok: false, errors: ['This match does not have two teams in it.'] };
    }
    const left = teamName(sides[0].team, sides[0].registration);
    const right = teamName(sides[1].team, sides[1].registration);
    if (!left || !right) return { ok: false, errors: ['This match does not name both teams.'] };
    return {
      ok: true,
      value: {
        document: null,
        matchOnly: match,
        candidates: [
          {
            index: 0,
            matchId: stringField(match.id),
            roundName: stringField(match._round) ?? (finiteNumber(match._round) ? `Round ${match._round}` : undefined),
            roundNumber: finiteNumber(match._round) ? match._round : undefined,
            location: stringField(match.location),
            leftName: left,
            rightName: right,
            state: playState(match),
          },
        ],
      },
    };
  }

  const document = shape.value.document;
  const byId = indexById(document);
  const matches = objectsOfType(document, 'Match');
  if (matches.length === 0) {
    return { ok: false, errors: ['This QBJ document does not contain any games.'] };
  }
  if (matches.length > maxMatches) {
    return { ok: false, errors: ['This QBJ document contains an implausible number of games.'] };
  }

  const tournament = objectsOfType(document, 'Tournament')[0] ?? null;
  const roundOfMatch = buildRoundIndex(document, byId);
  const candidates: IQbjMatchCandidate[] = [];

  document.objects.forEach((entry, index) => {
    if (entry.type !== 'Match') return;
    const sides = matchSides(entry, byId);
    if (sides.length !== 2) return;
    const left = teamName(sides[0].team, sides[0].registration);
    const right = teamName(sides[1].team, sides[1].registration);
    if (!left || !right) return;
    const context = roundOfMatch.get(entry);
    candidates.push({
      index,
      matchId: stringField(entry.id),
      phaseName: stringField(context?.phase?.name),
      roundName: stringField(context?.round?.name),
      roundNumber: roundNumberOf(context?.round),
      location: stringField(entry.location),
      leftName: left,
      rightName: right,
      state: playState(entry),
    });
  });

  if (candidates.length === 0) {
    return { ok: false, errors: ['This QBJ document does not contain a game with two named teams.'] };
  }

  return {
    ok: true,
    value: {
      document,
      matchOnly: null,
      candidates,
      tournamentName: stringField(tournament?.name),
      tournamentId: stringField(tournament?.id),
    },
  };
}

/**
 * Order candidates the way the picker shows them.
 *
 * Unplayed first, because that is what an assignment is and what a room almost always wants. Then
 * by round and by room, so a list of sixteen games reads like the schedule it came from.
 */
export function orderCandidates(candidates: IQbjMatchCandidate[]): IQbjMatchCandidate[] {
  const rank: Record<MatchPlayState, number> = { unplayed: 0, partial: 1, complete: 2 };
  return [...candidates].sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    const roundA = a.roundNumber ?? Number.MAX_SAFE_INTEGER;
    const roundB = b.roundNumber ?? Number.MAX_SAFE_INTEGER;
    if (roundA !== roundB) return roundA - roundB;
    return (a.location ?? '').localeCompare(b.location ?? '') || a.index - b.index;
  });
}

/**
 * Turn a chosen match into something the scorer can run.
 *
 * @param source the document as `readQbjSource` understood it
 * @param index which candidate, by its `index`
 * @param overrides what the scorekeeper supplied for what the document omitted
 */
export function defineGame(
  source: IQbjSource,
  index: number,
  overrides: IGameDefinitionOverrides = {},
): DefineGameResult {
  const match = source.document ? source.document.objects[index] : source.matchOnly;
  if (!match || !isPlainObject(match)) return { ok: false, errors: ['That game is not in this document.'] };

  const byId = source.document ? indexById(source.document) : new Map<string, QbjObject>();
  const sides = matchSides(match, byId);
  if (sides.length !== 2) return { ok: false, errors: ['That game does not have two teams in it.'] };

  const errors: string[] = [];
  const assumptions: string[] = [];
  const extension: IQbtcpExtension | null = readQbtcpExtension(match);

  /*
   * A procedure this build cannot read is refused; a procedure that was never sent is not.
   *
   * The asymmetry is the whole of it. No procedure means the tournament stated no procedural rules,
   * and the room scores with none enforced — which is what it asked for. A procedure in a shape this
   * build does not understand means the tournament stated rules that did not arrive, and continuing
   * would fall back to `any-boundary`: the *permissive* substitution policy. The room would then be
   * granted more freedom than the tournament allowed, on the strength of running an old build, with
   * nothing on screen to say so.
   *
   * First, and not answerable. Every other refusal below is either the scorekeeper's to fix — rules,
   * rosters — or a fact about the document they could sort out with staff. This one is a fact about
   * *this software*, and no answer given in the room makes it safe to continue.
   *
   * `.qbg` files and the pre-QBTCP connected path have always refused this, in `GamePackageValidation`.
   * This is the same refusal reaching the one route that dropped it instead — the route a connected
   * QBTCP assignment takes, and the route where a director's rules are likeliest to be newer than the
   * room's software. A generic QBJ carrying no `_qbtcp` block is untouched; only a document that
   * explicitly states procedural rules can be refused for stating them in a shape from the future.
   */
  if (extension?.unsupportedProcedureVersion !== undefined) {
    return { ok: false, errors: [unsupportedProcedureMessage(extension.unsupportedProcedureVersion)] };
  }

  // --- scoring rules --------------------------------------------------------------------------
  const rulesObject = source.document
    ? resolveRef(source.document.objects.find((entry) => entry.type === 'ScoringRules') ?? null, byId)
    : null;
  let format: IScorekeeperFormat;
  if (overrides.scorekeeperFormat) {
    format = overrides.scorekeeperFormat;
  } else {
    const timed = overrides.timed ?? extension?.scorekeeper?.timed;
    const read = readQbjScoringRules(rulesObject, timed);
    if (!read.ok) {
      return { ok: false, errors: read.problems, needsScoringRules: true };
    }
    format = read.format;
    assumptions.push(...read.assumptions);
  }

  // --- teams ----------------------------------------------------------------------------------
  const names = [teamName(sides[0].team, sides[0].registration), teamName(sides[1].team, sides[1].registration)];
  if (!names[0] || !names[1]) return { ok: false, errors: ['That game does not name both teams.'] };
  if (names[0] === names[1]) {
    return { ok: false, errors: ['Both teams in this game have the same name. A team cannot play itself.'] };
  }

  const rosters: ITeamRoster[] = [];
  const playerIds: Record<string, string> = {};
  const missingRosters: string[] = [];

  sides.forEach((side, position) => {
    const name = names[position] as string;

    // Ids are read from the document whether or not the roster is being supplied by hand, so a
    // player the file already knew about keeps their identity even when the other side was typed
    // in. Identity is the document's to give; only the names are the scorekeeper's.
    const fromDocument = readRoster(side.team);
    errors.push(...fromDocument.problems);

    const supplied = overrides.rosters?.[name];
    const players = supplied && supplied.length > 0 ? normalizeSuppliedRoster(supplied, name, errors) : fromDocument.players;

    for (const player of players) {
      const id = fromDocument.ids[player.name];
      if (id) playerIds[playerIdentityKey(name, player.name)] = id;
    }

    if (players.length === 0) missingRosters.push(name);
    rosters.push({ name, players });
  });

  if (errors.length > 0) return { ok: false, errors };
  if (missingRosters.length > 0) {
    const which = missingRosters.length === 2 ? 'either team' : `${missingRosters[0]}`;
    return {
      ok: false,
      errors: [`This QBJ does not list the players on ${which}.`],
      needsRoster: true,
      missingRosters,
    };
  }

  // --- round and room -------------------------------------------------------------------------
  // The same index the read built, so a candidate's round and its definition's round cannot differ.
  const context = source.document ? (buildRoundIndex(source.document, byId).get(match) ?? null) : null;

  const roundNumber = roundNumberOf(context?.round) ?? (finiteNumber(match._round) ? (match._round as number) : 0);
  const roundName = stringField(context?.round?.name) ?? (roundNumber > 0 ? `Round ${roundNumber}` : 'Game');
  if (!context && !finiteNumber(match._round)) {
    assumptions.push('This QBJ does not say which round this game is. It is being scored without one.');
  }

  const location = stringField(match.location);
  const packetName = stringField(context?.round?.packet) ?? stringField((resolveRef(context?.round?.packet ?? null, byId) ?? {}).name);

  // --- procedure ------------------------------------------------------------------------------
  if (!extension?.procedure) {
    assumptions.push(
      'This QBJ does not include tournament procedure. Scoring works normally; the scoresheet will not enforce substitution, timeout or clock rules it has not been given.',
    );
  }

  const tournamentName = source.tournamentName ?? 'Imported game';
  const qbjIdentity: IQbjIdentity = {
    ...(source.tournamentId ? { tournamentId: source.tournamentId } : {}),
    ...(stringField(match.id) ? { matchId: stringField(match.id) } : {}),
    ...(stringField(context?.phase?.id) ? { phaseId: stringField(context?.phase?.id) } : {}),
    ...(stringField(context?.phase?.name) ? { phaseName: stringField(context?.phase?.name) } : {}),
    ...(stringField(context?.round?.id) ? { roundId: stringField(context?.round?.id) } : {}),
    ...(stringField(context?.round?.name) ? { roundQbjName: stringField(context?.round?.name) } : {}),
    ...(stringField(rulesObject?.id) ? { scoringRulesId: stringField(rulesObject?.id) } : {}),
    teamIds: {
      ...(stringField(sides[0].team?.id) ? { left: stringField(sides[0].team?.id) } : {}),
      ...(stringField(sides[1].team?.id) ? { right: stringField(sides[1].team?.id) } : {}),
    },
    registrationIds: {
      ...(stringField(sides[0].registration?.id) ? { left: stringField(sides[0].registration?.id) } : {}),
      ...(stringField(sides[1].registration?.id) ? { right: stringField(sides[1].registration?.id) } : {}),
    },
    ...(Object.keys(playerIds).length > 0 ? { playerIds } : {}),
  };

  const definition: IGameDefinition = {
    format: gamePackageFormat,
    version: gamePackageVersion,
    tournament: {
      ...(source.tournamentId ? { key: source.tournamentId } : {}),
      name: tournamentName,
    },
    ...(stringField(match.id) ? { scheduledMatchId: stringField(match.id) } : {}),
    round: {
      number: roundNumber,
      name: roundName,
      // A QBJ document has no revision unless the extension carried one. 1 is the identity value —
      // "the first issue of these pairings" — not a guess about whether a redraw has happened.
      revision: extension?.roundRevision ?? 1,
      ...(packetName ? { packetName } : {}),
    },
    ...(location || extension?.roomId
      ? { room: { ...(extension?.roomId ? { id: extension.roomId } : {}), ...(location ? { name: location } : {}) } }
      : {}),
    left: rosters[0],
    right: rosters[1],
    scorekeeperFormat: format,
    ...(extension?.procedure ? { procedure: extension.procedure } : {}),
    ...(extension?.handoffInstruction ? { handoffInstruction: extension.handoffInstruction } : {}),
    qbjIdentity,
    origin: source.document ? 'qbj' : 'qbj-match-only',
    ...(assumptions.length > 0 ? { assumptions } : {}),
  };

  return { ok: true, definition };
}

/** Read QBJ text and, when it holds exactly one scoreable game, define it in one step. */
export function readQbjText(text: string): QbjReadResult<IQbjSource> {
  const parsed = parseQbjText(text);
  if (!parsed.ok) return parsed;
  return readQbjSource(parsed.value);
}

/**
 * Whether a source needs the picker, or can be opened without asking.
 *
 * A document holding one game is that game, whatever state it is in. Opening a finished match is
 * how somebody reviews or re-exports a MODAQ result, and refusing it would make the compatibility
 * import useless — nothing is overwritten by opening a file. The caller is told the state so it can
 * say plainly that this game already has a result; that is the "distinguish them" the profile asks
 * for, and it is a different thing from silently continuing a completed game.
 *
 * A document holding several is only opened without asking when exactly one of them is unplayed.
 */
export function scoreableWithoutChoice(source: IQbjSource): IQbjMatchCandidate | null {
  if (source.candidates.length === 1) return source.candidates[0];
  const unplayed = source.candidates.filter((candidate) => candidate.state === 'unplayed');
  if (unplayed.length === 1) return unplayed[0];
  return null;
}

/** Read `wholeNumber` re-exported for the result writer, which shares these bounds. */
export { wholeNumber };
