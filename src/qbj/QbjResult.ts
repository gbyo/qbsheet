/**
 * A finished game written as an official serialized QBJ document.
 *
 * # The result is the assignment, filled in
 *
 * When a game was started from a QBJ assignment, the document written at the end carries the same
 * `Tournament.id`, `Phase.id`, `Round.id`, `Match.id`, team ids and player ids that arrived. It is
 * the same document with the scoring filled in, not a new one that resembles it.
 *
 * That is what makes reconciliation on the tournament-control side a lookup. The alternative — a
 * freshly minted match matched back to a schedule by team names and a round number — is how a result
 * lands on the wrong game when two rooms play the same pairing in different brackets, and it is why
 * filenames were ever load-bearing.
 *
 * # Two structural constraints from the reference importer, verified rather than assumed
 *
 * The importer most likely to read this file finds matches by walking
 * `Tournament.phases[].rounds[].matches[]`, not by scanning the object list. A document whose Match
 * is only present at the top level parses as "no matches in this file". So the tournament here
 * always carries that spine.
 *
 * It then resolves the round by running `parseInt` over `Round.name`. A numeric round is therefore
 * named `"4"`, not `"Round 4"` — the human string lives in the definition and is used for filenames
 * and display. Getting this wrong produces a file that looks right and imports as an error.
 *
 * # Partial is the same document
 *
 * A mid-game download is this function with a game that is not over. Nothing is special-cased:
 * `toQbjMatch` is explicitly safe on a game in progress, and a partial document is a truthful
 * description of a partial game. What a partial file is *not* is a recovery journal — see
 * `PortableQbj` and `docs/QBJ_ASSIGNMENT_PROFILE.md` for that boundary.
 */
import { IGameDefinition, playerIdentityKey } from '../game/GameDefinition';
import { IDerivedGame } from '../scoring/deriveGame';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import toQbjMatch, { IQbjMatchMeta } from '../scoring/toQbjMatch';
import { LeftOrRight } from '../scoring/types';
import { IQbjDocument, QbjObject, buildQbjDocument, isPlainObject } from './QbjSerialization';
import { writeQbjScoringRules } from './QbjScoringRules';
import { withQbtcpExtension } from './QbtcpExtension';

/** A stable id when the source had none. Derived from content, never random, so exports are stable. */
function fallbackId(prefix: string, ...parts: string[]): string {
  const slug = parts
    .join('_')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${prefix}_${slug || 'unnamed'}`;
}

/**
 * `Round.name` as the schema wants it.
 *
 * The document's own spelling wins when there was one. Otherwise a numeric round is its number as a
 * string, which is both what the reference implementation writes and what its importer can resolve.
 */
function roundQbjName(definition: IGameDefinition): string {
  const carried = definition.qbjIdentity?.roundQbjName;
  if (carried) return carried;
  return definition.round.number > 0 ? String(definition.round.number) : definition.round.name;
}

/**
 * Lineups for one side, as a list of changes rather than a list of questions.
 *
 * QBJ records a lineup once per personnel change, keyed by the first question it applied to. The
 * derived game has a lineup on every question, so this collapses runs of identical lineups. A game
 * with no substitutions produces exactly one entry, which is the common case and the one worth not
 * bloating.
 */
function lineupsFor(
  game: IDerivedGame,
  side: LeftOrRight,
  playerRef: (name: string) => QbjObject,
): QbjObject[] {
  const lineups: QbjObject[] = [];
  let previous = '';
  for (const question of game.questions) {
    const active = question.activePlayers[side];
    if (!active || active.length === 0) continue;
    const key = active.join('\u0000');
    if (key === previous) continue;
    previous = key;
    lineups.push({
      first_question: question.questionNumber,
      players: active.map(playerRef),
    });
  }
  return lineups;
}

export interface IQbjResultOptions {
  definition: IGameDefinition;
  format: IScorekeeperFormat;
  game: IDerivedGame;
  meta?: IQbjMatchMeta;
  /** A game still being played. Only affects nothing structural; kept for the caller's clarity. */
  partial?: boolean;
}

/**
 * Build the Match object alone, with identity and lineups attached.
 *
 * Exposed separately because the legacy Match-only export and the QBTCP progress snapshot both want
 * exactly this and neither wants an envelope around it.
 */
export function buildResultMatch(options: IQbjResultOptions): QbjObject {
  const { definition, format, game } = options;
  const identity = definition.qbjIdentity;

  const meta: IQbjMatchMeta = {
    round: definition.round.number > 0 ? definition.round.number : undefined,
    location: definition.room?.name,
    ...options.meta,
  };

  const match = toQbjMatch(format, game, meta);

  if (identity?.matchId) match.id = identity.matchId;
  else if (definition.scheduledMatchId) match.id = definition.scheduledMatchId;
  match.type = 'Match';

  // Attach team and player identity onto the aggregates `toQbjMatch` produced. It works in names,
  // which is what the scoring engine works in; ids are grafted on here so the engine never has to
  // carry them.
  const sides: LeftOrRight[] = ['left', 'right'];
  const matchTeams = Array.isArray(match.match_teams) ? (match.match_teams as QbjObject[]) : [];
  matchTeams.forEach((matchTeam, position) => {
    const side = sides[position];
    const teamName = side === 'left' ? definition.left.name : definition.right.name;
    const teamId = side === 'left' ? identity?.teamIds?.left : identity?.teamIds?.right;

    if (isPlainObject(matchTeam.team)) {
      matchTeam.team = teamId ? { $ref: teamId } : { name: teamName };
    }

    const playerRef = (name: string): QbjObject => {
      const id = identity?.playerIds?.[playerIdentityKey(teamName, name)];
      return id ? { $ref: id } : { name };
    };

    if (Array.isArray(matchTeam.match_players)) {
      for (const matchPlayer of matchTeam.match_players as QbjObject[]) {
        if (isPlainObject(matchPlayer.player) && typeof matchPlayer.player.name === 'string') {
          matchPlayer.player = playerRef(matchPlayer.player.name);
        }
      }
    }

    const lineups = lineupsFor(game, side, playerRef);
    if (lineups.length > 0) matchTeam.lineups = lineups;
  });

  // The operational block. Round revision is the field that makes a stale result detectable, so it
  // travels with the result and not only with the assignment. The definition identity travels
  // too: it says which competitive truth this result was actually scored under (#670).
  return withQbtcpExtension(match, {
    roundRevision: definition.round.revision,
    ...(definition.round.assignmentRevision !== undefined
      ? { assignmentRevision: definition.round.assignmentRevision }
      : {}),
    ...(definition.definition
      ? {
          definitionRevision: definition.definition.revision,
          definitionDigest: definition.definition.digest,
        }
      : {}),
    roomId: definition.room?.id,
    ...(definition.procedure ? { procedure: definition.procedure } : {}),
    ...(definition.handoffInstruction ? { handoffInstruction: definition.handoffInstruction } : {}),
    scorekeeper: { timed: format.regulation.timed },
  });
}

/**
 * Build the whole serialized document.
 *
 * Every object the match refers to is emitted at the top level with an id, and the tournament
 * carries the phase/round/match spine that the reference importer walks. Both are required for the
 * file to be readable; neither is optional prettiness.
 */
export function buildResultDocument(options: IQbjResultOptions): IQbjDocument {
  const { definition, format } = options;
  const identity = definition.qbjIdentity;

  const match = buildResultMatch(options);

  const teamObjects: QbjObject[] = [];
  const registrationObjects: QbjObject[] = [];

  for (const side of ['left', 'right'] as const) {
    const roster = definition[side];
    const teamId = identity?.teamIds?.[side] ?? fallbackId('Team', roster.name);
    const registrationId = identity?.registrationIds?.[side] ?? fallbackId('Registration', roster.name);

    const players = roster.players.map((player) => ({
      type: 'Player',
      id:
        identity?.playerIds?.[playerIdentityKey(roster.name, player.name)] ??
        fallbackId('Player', roster.name, player.name),
      name: player.name,
    }));

    teamObjects.push({ type: 'Team', id: teamId, name: roster.name, players });
    registrationObjects.push({
      type: 'Registration',
      id: registrationId,
      name: roster.name,
      teams: [{ $ref: teamId }],
    });
  }

  const scoringRulesId = identity?.scoringRulesId ?? 'ScoringRules';
  const scoringRules = writeQbjScoringRules(format, scoringRulesId);

  const roundId =
    identity?.roundId ?? fallbackId('Round', String(definition.round.number || definition.round.name));
  const round: QbjObject = {
    type: 'Round',
    id: roundId,
    name: roundQbjName(definition),
    ...(definition.round.packetName
      ? {
          packets: [
            {
              type: 'Packet',
              id: `Packet_${definition.round.packetName}`,
              name: definition.round.packetName,
            },
          ],
        }
      : {}),
    matches: [{ $ref: match.id ?? '' }].filter((ref) => ref.$ref !== ''),
  };
  // A match with no id cannot be referenced, so embed it rather than emitting a dangling pointer.
  if (!match.id) round.matches = [match];

  const phaseId = identity?.phaseId ?? 'Phase_1';
  const phase: QbjObject = {
    type: 'Phase',
    id: phaseId,
    name: identity?.phaseName ?? 'Playoffs',
    rounds: [round],
  };

  const tournament: QbjObject = {
    type: 'Tournament',
    ...((identity?.tournamentId ?? definition.tournament.key)
      ? { id: identity?.tournamentId ?? definition.tournament.key }
      : {}),
    name: definition.tournament.name,
    scoring_rules: { $ref: scoringRulesId },
    registrations: registrationObjects.map((registration) => ({ $ref: registration.id as string })),
    phases: [phase],
  };

  const objects: QbjObject[] = [tournament, scoringRules, ...registrationObjects, ...teamObjects];
  if (match.id) objects.push(match);

  return buildQbjDocument(objects);
}

/**
 * The compatibility export: a bare Match, as MODAQ writes and as older tools expect.
 *
 * Kept because the ecosystem reads it, offered under a secondary menu because it is no longer what
 * a QBJ file from this application means.
 */
export function buildLegacyMatchOnly(options: IQbjResultOptions): QbjObject {
  return buildResultMatch(options);
}

/** Strip characters a filesystem will refuse, without inventing a name. */
function safeFilePart(value: string): string {
  const withoutControls = Array.from(value)
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('');
  return (
    withoutControls
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/[.-]+$/g, '') || 'game'
  );
}

export type QbjFilePurpose = 'assignment' | 'result' | 'partial';

/**
 * A descriptive filename.
 *
 * Human guidance only. Nothing anywhere reads a filename to decide what a document is or which game
 * it belongs to — that is what the ids in the document are for. Two rooms will rename these and one
 * of them will not.
 */
export function qbjFileName(definition: IGameDefinition, purpose: QbjFilePurpose): string {
  const round = definition.round.number > 0 ? `R${String(definition.round.number).padStart(2, '0')}` : 'Game';
  const room = definition.room?.name ? `_${safeFilePart(definition.room.name)}` : '';
  const matchup = `${safeFilePart(definition.left.name)}_vs_${safeFilePart(definition.right.name)}`;
  return `${round}${room}_${matchup}.${purpose}.qbj`;
}
