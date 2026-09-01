/**
 * A valid game package, and small ways of making it invalid.
 *
 * The default is a real one: two rosters, a rule set a game can be played under, a round with a
 * revision. Tests that care about one field override that field, so a failure names the thing that
 * changed rather than the whole object.
 */
import { IGamePackage, gamePackageFormat, gamePackageVersion } from '../src/game/GamePackage';
import { IQbjIdentity } from '../src/game/GameDefinition';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';

export function validPackage(
  overrides: Partial<IGamePackage> & { qbjIdentity?: IQbjIdentity } = {},
): IGamePackage & { qbjIdentity?: IQbjIdentity } {
  return {
    format: gamePackageFormat,
    version: gamePackageVersion,
    tournament: { key: 'tourn-2026-spring', name: 'Spring Invitational' },
    scheduledMatchId: 'sched-101',
    round: { number: 7, name: 'Round 7', revision: 1, packetName: 'Packet 7' },
    room: { id: 'room-204', name: 'Room 204' },
    left: {
      name: 'Ninety Six A',
      players: [{ name: 'Sarah Mitchell' }, { name: 'James Okafor' }, { name: 'Alex Rivera' }],
    },
    right: {
      name: 'Greenwood',
      players: [{ name: 'Emma Chen' }, { name: 'Jordan Blake' }, { name: 'Morgan Ellis' }],
    },
    scorekeeperFormat: scoringRulesToScorekeeperFormat(new ScoringRules(CommonRuleSets.AcfPowers)),
    ...overrides,
  };
}

/** The same package as a file's worth of text. */
export function packageText(overrides: Partial<IGamePackage> = {}): string {
  return JSON.stringify(validPackage(overrides), null, 2);
}
