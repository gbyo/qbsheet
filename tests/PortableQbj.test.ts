/**
 * The boundary between the payload that stays here and the file that leaves.
 *
 * Two claims are being defended. A downloaded result must be an ordinary QBJ that any tool can
 * read, carrying nothing about this scorer's internal state and nothing that could be a credential.
 * And it must carry enough identity that tournament control can attach it to the right scheduled
 * game without reading the filename, which is the one thing about a result guaranteed to have been
 * changed by the time it arrives.
 */
import { describe, expect, test } from 'vitest';
import { portableQbj, readSourceMetadata, sourceExtensionKey, stripInternalState } from '../src/game/PortableQbj';
import { attachScorerRecovery, scorerRecoveryKey } from '../src/scorer/ScorerRecovery';
import toQbjMatch from '../src/scoring/toQbjMatch';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import { qbjFileContents, qbjFileName } from '../src/integrations/file/QbjDownload';
import { validPackage } from './packages';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules, typeIndex } from './rules';
import { event } from './events';

const format = scoringRulesToScorekeeperFormat(new ScoringRules(CommonRuleSets.AcfPowers));
const setup: IGameSetup = {
  left: { name: 'Ninety Six A', players: ['Sarah Mitchell', 'James Okafor'] },
  right: { name: 'Greenwood', players: ['Emma Chen', 'Jordan Blake'] },
};

function playedGame(): { qbj: object; events: ScoreEvent[] } {
  const events: ScoreEvent[] = [
    event({
      type: 'tossup-buzz',
      questionNumber: 1,
      team: 'left',
      playerName: 'Sarah Mitchell',
      answerTypeIndex: typeIndex(format, 15),
    }),
    event({ type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 20 }),
    event({
      type: 'tossup-buzz',
      questionNumber: 2,
      team: 'right',
      playerName: 'Emma Chen',
      answerTypeIndex: typeIndex(format, 10),
    }),
    event({ type: 'bonus', questionNumber: 2, team: 'right', controlledPoints: 10 }),
  ];
  const game = deriveGame(format, setup, events);
  return { qbj: attachScorerRecovery(toQbjMatch(format, game, { round: 7 }), setup, events), events };
}

describe('what leaves the device', () => {
  test('the internal recovery layer is not in the downloaded file', () => {
    const { qbj } = playedGame();

    expect(qbj).toHaveProperty(scorerRecoveryKey);
    expect(portableQbj(qbj, validPackage())).not.toHaveProperty(scorerRecoveryKey);
  });

  test('the statistical result is untouched', () => {
    const { qbj } = playedGame();
    const portable = portableQbj(qbj, validPackage()) as {
      tossups_read: number;
      match_teams: { points: number; match_players: { tossups_heard: number }[] }[];
    };

    expect(portable.tossups_read).toBe(2);
    expect(portable.match_teams[0].points).toBe(35);
    expect(portable.match_teams[1].points).toBe(20);
    expect(portable.match_teams[0].match_players[0].tossups_heard).toBe(2);
  });

  test('anything credential-shaped is removed at any depth', () => {
    const stripped = stripInternalState({
      match_teams: [{ team: { name: 'Ninety Six A' }, sessionToken: 'secret' }],
      nested: { deep: { 'room-token': 'secret', keep: 1 } },
    }) as Record<string, Record<string, Record<string, unknown>>>;

    expect(JSON.stringify(stripped)).not.toContain('secret');
    expect(stripped.nested.deep.keep).toBe(1);
  });

  test('sanitizing copies rather than editing what the server will receive', () => {
    const { qbj } = playedGame();
    portableQbj(qbj, validPackage());

    expect(qbj).toHaveProperty(scorerRecoveryKey);
  });

  test('no part of the game package is smuggled into the file', () => {
    const { qbj } = playedGame();
    const portable = portableQbj(qbj, validPackage());

    expect(JSON.stringify(portable)).not.toContain('Packet 7');
    expect(portable).not.toHaveProperty('scorekeeperFormat');
  });
});

describe('the source block', () => {
  test('it names the tournament, the scheduled game and the round revision', () => {
    const { qbj } = playedGame();
    const portable = portableQbj(qbj, validPackage({ round: { number: 7, name: 'Round 7', revision: 3 } }));

    expect(readSourceMetadata(portable)).toMatchObject({
      tournamentId: 'tourn-2026-spring',
      tournamentName: 'Spring Invitational',
      scheduledMatchId: 'sched-101',
      roundNumber: 7,
      roundRevision: 3,
      roomName: 'Room 204',
    });
  });

  test('it is one key, so a tool that has never heard of it ignores one thing', () => {
    const { qbj } = playedGame();
    const portable = portableQbj(qbj, validPackage()) as Record<string, unknown>;
    const extras = Object.keys(portable).filter((key) => key.startsWith('_') && key !== '_round');

    expect(extras).toEqual([sourceExtensionKey]);
  });

  test('reading it back from something that has none is not an error', () => {
    expect(readSourceMetadata({ match_teams: [] })).toBeNull();
    expect(readSourceMetadata(null)).toBeNull();
  });

  test('rejects incomplete or unsafe source metadata', () => {
    const valid = {
      producer: 'QBSheet',
      gamePackageVersion: 1,
      tournamentName: 'Spring Invitational',
      roundNumber: 7,
      roundRevision: 3,
    };
    expect(readSourceMetadata({ [sourceExtensionKey]: { ...valid, gamePackageVersion: '1' } })).toBeNull();
    expect(readSourceMetadata({ [sourceExtensionKey]: { ...valid, roundRevision: 0 } })).toBeNull();
    expect(readSourceMetadata({ [sourceExtensionKey]: { ...valid, producer: 'Other Scorer' } })).toBeNull();
  });
});

describe('the file itself', () => {
  test('the name says what the game is without the file being opened', () => {
    expect(qbjFileName(validPackage())).toBe('R07_Room-204_Ninety-Six-A_vs_Greenwood.qbj');
  });

  test('a game with no room leaves that part out rather than inventing one', () => {
    expect(qbjFileName(validPackage({ room: undefined }))).toBe('R07_Ninety-Six-A_vs_Greenwood.qbj');
  });

  test('the contents are the portable payload, formatted for a human to open', () => {
    const { qbj } = playedGame();
    const text = qbjFileContents(portableQbj(qbj, validPackage()));

    expect(text).toContain('\n  "match_teams"');
    expect(text).not.toContain(scorerRecoveryKey);
    expect(JSON.parse(text)).toHaveProperty(sourceExtensionKey);
  });
});
