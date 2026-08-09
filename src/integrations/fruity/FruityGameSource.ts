/**
 * Turning an assignment from tournament control into the same game package a file would have been.
 *
 * # The rule this file exists to enforce
 *
 * There is one scorer, one game package, and one local game. A connected room does not get a
 * server-driven scoring mode; it gets a package, exactly as if somebody had handed it a file, and
 * from that point on the two paths are indistinguishable to everything downstream. The connection
 * is a way of *obtaining* a game, not a way of *playing* one.
 *
 * That is why this conversion is a pure function over an assignment response with no client, no
 * network and no credentials in sight: whatever the server said becomes a frozen package, the
 * package is persisted, and the game starts. Nothing after that point depends on another request
 * succeeding.
 *
 * # What is deliberately dropped
 *
 * The session token, the room token and the device id are not part of a game package and never
 * reach one. They stay in the connected session's own state, which is browser storage that is never
 * exported and never attached to a result. See `GamePackage` for why.
 *
 * Also dropped: the previous and next matchups, presence, help requests, hold state, the blocked
 * reason, and everything else the assignment response carries for the room *page*. A package
 * describes one game.
 */
import { IGamePackage, gamePackageFormat, gamePackageVersion } from '../../game/GamePackage';
import { validateGamePackage } from '../../game/GamePackageValidation';
import { GameSourceResult } from '../../game/GameSource';
import { IAssignmentResponse, IAssignedMatchup } from './FruityServerClient';

/**
 * The revision assumed when tournament control does not send one.
 *
 * A server built before game packages existed has no revision to send, and a room still has to be
 * able to score. One is the honest reading: the first issue of this round's pairings, which is what
 * a tournament that has never rebracketed has and is the most conservative thing to claim about one
 * that has — a result marked revision 1 against a round now on revision 2 is exactly the case
 * control needs flagged.
 */
export const assumedRoundRevision = 1;

export interface IAssignmentConversion {
  assignment: IAssignmentResponse;
  matchup: IAssignedMatchup;
}

/**
 * Build the package for the game a room has been assigned.
 *
 * Runs the result through the same validation a file gets. The server is more trustworthy than a
 * USB stick, but not so much more that a truncated roster or an unusable rule set should reach a
 * room by a route that never checked — and the failure of the two paths has to read the same way to
 * whoever is standing in the room.
 */
export function assignmentToGamePackage({ assignment, matchup }: IAssignmentConversion): GameSourceResult {
  if (assignment.scoringFormat === null) {
    return {
      ok: false,
      errors: ["This tournament's scoring rules cannot be used by this scoresheet."],
    };
  }

  const draft: IGamePackage = {
    format: gamePackageFormat,
    version: gamePackageVersion,
    tournament: {
      ...(assignment.tournamentKey ? { key: assignment.tournamentKey } : {}),
      name: assignment.tournamentName,
    },
    scheduledMatchId: matchup.scheduledMatchId,
    round: {
      number: matchup.roundNumber,
      name: matchup.roundName,
      revision: matchup.roundRevision ?? assumedRoundRevision,
      ...(matchup.packetName ? { packetName: matchup.packetName } : {}),
    },
    room: { id: assignment.roomId, name: assignment.roomName },
    left: { name: matchup.leftTeam.name, players: matchup.leftTeam.players.map((player) => ({ name: player.name })) },
    right: {
      name: matchup.rightTeam.name,
      players: matchup.rightTeam.players.map((player) => ({ name: player.name })),
    },
    scorekeeperFormat: assignment.scoringFormat,
    ...(assignment.roomProcedure ? { procedure: assignment.roomProcedure } : {}),
    ...(assignment.resultHandoffInstruction ? { handoffInstruction: assignment.resultHandoffInstruction } : {}),
  };

  return validateGamePackage(draft);
}
