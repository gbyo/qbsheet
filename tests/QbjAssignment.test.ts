/**
 * QBJ in, game out; game in, QBJ out.
 *
 * The tests that matter most here are the round trips, because the claim the architecture makes is
 * that a result is the assignment filled in — same document, same identities, scoring added. A test
 * that only checked the parse would pass on a parser that quietly minted new ids.
 */
import { describe, expect, test } from 'vitest';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import { event } from './events';
import { openGameText, chooseGame } from '../src/game/OpenGameDefinition';
import { playerIdentityKey } from '../src/game/GameDefinition';
import { defineGame, orderCandidates, readQbjSource } from '../src/qbj/ParseQbjAssignment';
import { readQbjScoringRules } from '../src/qbj/QbjScoringRules';
import { buildResultDocument, buildLegacyMatchOnly, qbjFileName } from '../src/qbj/QbjResult';
import { qbjSerializationVersion, isPlainObject, QbjObject } from '../src/qbj/QbjSerialization';
import { qbtcpExtensionKey } from '../src/qbj/QbtcpExtension';
import {
  acfPowersScoringRules,
  assignmentDocument,
  greenwood,
  matchObject,
  modaqMatchOnly,
  ninetySix,
  tournamentDocument,
} from './qbjDocuments';
import { packageText } from './packages';

function text(value: object): string {
  return JSON.stringify(value);
}

/** Open a document that is expected to yield exactly one game. */
function openOne(document: object) {
  const opened = openGameText(text(document));
  if (!opened.ok || opened.kind !== 'game') {
    throw new Error(`Expected one game, got ${JSON.stringify(opened)}`);
  }
  return opened;
}

function typeIndex(format: IScorekeeperFormat, value: number): number {
  const found = format.answerTypes.find((answerType) => answerType.value === value);
  if (!found) throw new Error(`No answer type worth ${value}`);
  return found.index;
}

/** A short but representative game: powers, a neg, bonuses, and a substitution. */
function representativeEvents(format: IScorekeeperFormat): ScoreEvent[] {
  return [
    event({ type: 'tossup-buzz', questionNumber: 1, team: 'left', playerName: 'Sarah', answerTypeIndex: typeIndex(format, 15) }),
    event({ type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 20 }),
    event({ type: 'tossup-buzz', questionNumber: 2, team: 'right', playerName: 'Emma', answerTypeIndex: typeIndex(format, 10) }),
    event({ type: 'bonus', questionNumber: 2, team: 'right', controlledPoints: 10 }),
    event({ type: 'tossup-buzz', questionNumber: 3, team: 'left', playerName: 'James', answerTypeIndex: typeIndex(format, -5) }),
    event({ type: 'tossup-buzz', questionNumber: 3, team: 'right', playerName: 'Jordan', answerTypeIndex: typeIndex(format, 10) }),
    event({ type: 'bonus', questionNumber: 3, team: 'right', controlledPoints: 30 }),
    event({ type: 'substitution', questionNumber: 4, team: 'left', activePlayers: ['Sarah', 'Alex', 'Taylor'] }),
    event({ type: 'tossup-buzz', questionNumber: 4, team: 'left', playerName: 'Alex', answerTypeIndex: typeIndex(format, 10) }),
    event({ type: 'bonus', questionNumber: 4, team: 'left', controlledPoints: 10 }),
  ];
}

function setupFor(definition: { left: { name: string; players: { name: string }[] }; right: { name: string; players: { name: string }[] } }): IGameSetup {
  return {
    left: { name: definition.left.name, players: definition.left.players.map((player) => player.name) },
    right: { name: definition.right.name, players: definition.right.players.map((player) => player.name) },
  };
}

/** The ACF-with-powers format, read from its own standard QBJ rather than hand-built. */
function acfFormat(): IScorekeeperFormat {
  const read = readQbjScoringRules(acfPowersScoringRules(), false);
  if (!read.ok) throw new Error('The fixture scoring rules should be readable');
  return read.format;
}

function objectOfType(document: { objects: QbjObject[] }, type: string): QbjObject {
  const found = document.objects.find((entry) => entry.type === type);
  if (!found) throw new Error(`No ${type} in the document`);
  return found;
}

describe('reading an official one-game assignment', () => {
  test('an assignment becomes a game definition', () => {
    const { definition, legacy } = openOne(assignmentDocument());

    expect(legacy).toBe(false);
    expect(definition.origin).toBe('qbj');
    expect(definition.tournament.name).toBe('Spring Invitational');
    expect(definition.left.name).toBe('Ninety Six');
    expect(definition.right.name).toBe('Greenwood');
    expect(definition.left.players.map((player) => player.name)).toEqual(['Sarah', 'James', 'Alex', 'Taylor']);
    expect(definition.round.number).toBe(4);
    expect(definition.room?.name).toBe('Room 204');
  });

  test('standard QBJ identities are carried, not re-minted', () => {
    const { definition } = openOne(assignmentDocument());

    expect(definition.qbjIdentity?.tournamentId).toBe('Tournament_spring-2026');
    expect(definition.qbjIdentity?.matchId).toBe('Match_sm-4471');
    expect(definition.qbjIdentity?.phaseId).toBe('Phase_Prelims');
    expect(definition.qbjIdentity?.roundId).toBe('Round_4');
    expect(definition.qbjIdentity?.teamIds).toEqual({ left: ninetySix.id, right: greenwood.id });
    expect(definition.qbjIdentity?.playerIds?.[playerIdentityKey('Ninety Six', 'Sarah')]).toBe('Player_Sarah');
  });

  test('the operational extension is read, and the room id survives a renamed room', () => {
    const { definition } = openOne(assignmentDocument());

    expect(definition.round.revision).toBe(3);
    expect(definition.room?.id).toBe('room-204');
    expect(definition.handoffInstruction).toBe('Upload to the Round 4 folder.');
  });

  test('an unsupported serialization version is refused rather than guessed at', () => {
    const opened = openGameText(text(assignmentDocument({ version: '3.0.0' })));

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.errors.join(' ')).toContain('3.0.0');
  });

  test('a document with unsafe property names is refused', () => {
    const hostile = '{"version":"2.1.1","objects":[{"type":"Match","__proto__":{"polluted":true}}]}';

    const opened = openGameText(hostile);

    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.errors.join(' ')).toContain('unsafe');
  });
});

describe('scoring rules', () => {
  test('standard fields become the scorer format', () => {
    const read = readQbjScoringRules(acfPowersScoringRules(), false);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.format.answerTypes.map((answerType) => answerType.value)).toEqual([15, 10, -5]);
    expect(read.format.bonus.enabled).toBe(true);
    expect(read.format.bonus.regular).toBe(true);
    expect(read.format.bonus.pointsPerPart).toBe(10);
    expect(read.format.regulation.tossupCount).toBe(20);
    expect(read.format.players.maximumActive).toBe(4);
    expect(read.format.overtime.suddenDeath).toBe(true);
  });

  test('nothing branches on the rule set name', () => {
    const named = readQbjScoringRules(acfPowersScoringRules({ name: 'NAQT' }), false);
    const unnamed = readQbjScoringRules(acfPowersScoringRules({ name: 'Some Local Format' }), false);

    expect(named.ok && unnamed.ok).toBe(true);
    if (!named.ok || !unnamed.ok) return;
    // Same structure, different label: every behavioral field must agree.
    expect({ ...named.format, name: '' }).toEqual({ ...unnamed.format, name: '' });
  });

  test('missing scoring rules are reported as answerable, not defaulted', () => {
    const opened = openGameText(text(assignmentDocument({ scoringRules: null })));

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.needsScoringRules).toBe(true);
    expect(opened.errors.join(' ')).toContain('does not specify enough scoring information');
  });

  test('the timed flag comes from the extension, and its absence is stated rather than assumed', () => {
    const withoutTimed = readQbjScoringRules(acfPowersScoringRules());
    expect(withoutTimed.ok).toBe(false);
    if (withoutTimed.ok) return;
    expect(withoutTimed.problems.join(' ')).toContain('do not say whether the round is timed');

    const timed = readQbjScoringRules(acfPowersScoringRules(), true);
    expect(timed.ok).toBe(true);
    if (!timed.ok) return;
    expect(timed.format.regulation.timed).toBe(true);
    expect(timed.assumptions.join(' ')).not.toContain('timed');
  });

  test('rules that describe no playable game are refused', () => {
    const read = readQbjScoringRules(acfPowersScoringRules({ answer_types: [] }));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems.join(' ')).toContain('how a tossup can be answered');
  });
});

describe('incomplete QBJ', () => {
  test('teams with no rosters are answerable by manual entry', () => {
    const bareTeams = [
      { ...ninetySix, players: [] },
      { ...greenwood, players: [] },
    ];
    const document = assignmentDocument({ teams: bareTeams });

    const opened = openGameText(text(document));
    expect(opened.ok).toBe(false);
    if (opened.ok || !opened.source) return;
    expect(opened.needsRoster).toBe(true);

    const defined = chooseGame(opened.source, opened.index ?? 0, {
      rosters: { 'Ninety Six': [{ name: 'Sarah' }], Greenwood: [{ name: 'Emma' }] },
    });
    expect(defined.ok).toBe(true);
    if (!defined.ok) return;
    expect(defined.definition.left.players).toEqual([{ name: 'Sarah' }]);
  });

  test('missing procedure still scores, and says the scoresheet will not enforce what it was not given', () => {
    const { definition } = openOne(assignmentDocument());

    expect(definition.procedure).toBeUndefined();
    expect(definition.assumptions?.join(' ')).toContain('will not enforce');
  });

  test('a match naming the same team twice is refused', () => {
    const document = assignmentDocument({
      matches: [
        matchObject({
          id: 'Match_x',
          left: ninetySix,
          right: ninetySix,
          qbtcp: { scorekeeper: { timed: false } },
        }),
      ],
    });

    const opened = openGameText(text(document));
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.errors.join(' ')).toContain('cannot play itself');
  });

  test('a roster naming the same player twice is refused rather than merged', () => {
    const duplicated = { ...ninetySix, players: [{ id: 'p1', name: 'Sarah' }, { id: 'p2', name: 'Sarah' }] };
    const document = assignmentDocument({ teams: [duplicated, greenwood] });

    const opened = openGameText(text(document));
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.errors.join(' ')).toContain('more than once');
  });
});

describe('whole-tournament documents', () => {
  test('several games become a choice rather than a silent pick', () => {
    const opened = openGameText(text(tournamentDocument()));

    expect(opened.ok).toBe(true);
    if (!opened.ok || opened.kind !== 'choice') throw new Error('Expected a choice');
    expect(opened.source.candidates).toHaveLength(3);
  });

  test('unplayed games are offered first and a played one is marked complete', () => {
    const source = readQbjSource(tournamentDocument());
    if (!source.ok) throw new Error('Expected a readable document');

    const ordered = orderCandidates(source.value.candidates);
    expect(ordered.map((candidate) => candidate.state)).toEqual(['unplayed', 'unplayed', 'complete']);
    expect(ordered[0].roundNumber).toBe(4);
    expect(ordered.map((candidate) => candidate.location)).toEqual(['Room 101', 'Room 102', 'Room 101']);
  });

  test('choosing a game defines that game and no other', () => {
    const source = readQbjSource(tournamentDocument());
    if (!source.ok) throw new Error('Expected a readable document');
    const target = source.value.candidates.find((candidate) => candidate.matchId === 'Match_r4-102');

    const defined = defineGame(source.value, target?.index ?? -1);

    expect(defined.ok).toBe(true);
    if (!defined.ok) return;
    expect(defined.definition.left.name).toBe('Emerald');
    expect(defined.definition.right.name).toBe('Greenwood');
    expect(defined.definition.qbjIdentity?.matchId).toBe('Match_r4-102');
  });
});

describe('legacy inputs', () => {
  test('a MODAQ-style bare match carries no scoring rules, so it asks instead of guessing', () => {
    const opened = openGameText(text(modaqMatchOnly()));

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.needsScoringRules).toBe(true);
    // It is a bare Match: there is no ScoringRules object anywhere to read, and inventing one would
    // mean inventing what a power is worth.
    expect(opened.source?.document).toBeNull();
  });

  test('a MODAQ-style bare match imports once a format is supplied', () => {
    const opened = openGameText(text(modaqMatchOnly()));
    if (opened.ok || !opened.source) throw new Error('Expected a request for scoring rules');

    const defined = chooseGame(opened.source, opened.index ?? 0, { scorekeeperFormat: acfFormat() });

    expect(defined.ok).toBe(true);
    if (!defined.ok) return;
    expect(defined.definition.origin).toBe('qbj-match-only');
    expect(defined.definition.left.name).toBe('Ninety Six');
    expect(defined.definition.right.name).toBe('Greenwood');
    expect(defined.definition.round.number).toBe(4);
    expect(defined.definition.room?.name).toBe('Room 204');
    expect(defined.definition.left.players.map((player) => player.name)).toEqual(['Sarah', 'James']);
  });

  test('an already-scored match is reported as complete, so nobody appends to a finished game', () => {
    const source = readQbjSource(modaqMatchOnly());
    if (!source.ok) throw new Error('Expected a readable match');

    expect(source.value.candidates[0].state).toBe('complete');
  });

  test('an unplayed assignment is not flagged', () => {
    expect(openOne(assignmentDocument()).state).toBe('unplayed');
  });

  test('a legacy .qbg package still opens, and is marked as legacy', () => {
    const opened = openGameText(packageText());

    expect(opened.ok).toBe(true);
    if (!opened.ok || opened.kind !== 'game') throw new Error('Expected one game');
    expect(opened.legacy).toBe(true);
    expect(opened.definition.origin).toBe('qbg');
    expect(opened.definition.left.name).toBe('Ninety Six A');
    expect(opened.definition.round.revision).toBe(1);
  });

  test('a broken legacy package reports its own problems, not a QBJ complaint', () => {
    const opened = openGameText(packageText({ round: { number: 7, name: 'Round 7', revision: 0 } }));

    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.errors.join(' ')).toContain('revision');
  });
});

describe('assignment to result', () => {
  test('the result is the assignment filled in, with every identity preserved', () => {
    const { definition } = openOne(assignmentDocument());
    const format = definition.scorekeeperFormat;
    const game = deriveGame(format, setupFor(definition), representativeEvents(format));

    const result = buildResultDocument({ definition, format, game });

    expect(result.version).toBe(qbjSerializationVersion);
    const tournament = objectOfType(result, 'Tournament');
    const match = objectOfType(result, 'Match');
    expect(tournament.id).toBe('Tournament_spring-2026');
    expect(match.id).toBe('Match_sm-4471');

    const phase = (tournament.phases as QbjObject[])[0];
    const round = (phase.rounds as QbjObject[])[0];
    expect(phase.id).toBe('Phase_Prelims');
    expect(round.id).toBe('Round_4');
    // Numeric, because the reference importer resolves a round by parsing this field.
    expect(round.name).toBe('4');

    const teams = result.objects.filter((entry) => entry.type === 'Team');
    expect(teams.map((team) => team.id).sort()).toEqual([greenwood.id, ninetySix.id].sort());
  });

  test('the scored totals survive the trip', () => {
    const { definition } = openOne(assignmentDocument());
    const format = definition.scorekeeperFormat;
    const game = deriveGame(format, setupFor(definition), representativeEvents(format));

    const result = buildResultDocument({ definition, format, game });
    const match = objectOfType(result, 'Match');
    const matchTeams = match.match_teams as QbjObject[];

    // left: 15 + 20 bonus, then -5, then 10 + 10 bonus  = 50
    // right: 10 + 10 bonus, then 10 + 30 bonus          = 60
    expect(matchTeams[0].points).toBe(50);
    expect(matchTeams[1].points).toBe(60);
    expect(match.tossups_read).toBe(game.tossupsRead);
  });

  test('players are referenced by their assignment ids', () => {
    const { definition } = openOne(assignmentDocument());
    const format = definition.scorekeeperFormat;
    const game = deriveGame(format, setupFor(definition), representativeEvents(format));

    const match = objectOfType(buildResultDocument({ definition, format, game }), 'Match');
    const left = (match.match_teams as QbjObject[])[0];

    expect(left.team).toEqual({ $ref: ninetySix.id });
    const sarah = (left.match_players as QbjObject[]).find(
      (matchPlayer) => (matchPlayer.player as QbjObject).$ref === 'Player_Sarah',
    );
    expect(sarah).toBeDefined();
  });

  test('lineups are exported, and a substitution shows up as a second entry', () => {
    const { definition } = openOne(assignmentDocument());
    const format = definition.scorekeeperFormat;
    const game = deriveGame(format, setupFor(definition), representativeEvents(format));

    const match = objectOfType(buildResultDocument({ definition, format, game }), 'Match');
    const lineups = (match.match_teams as QbjObject[])[0].lineups as QbjObject[];

    expect(lineups.length).toBeGreaterThanOrEqual(2);
    expect(lineups[0].first_question).toBe(1);
    const afterSubstitution = lineups[lineups.length - 1];
    expect(afterSubstitution.first_question).toBe(4);
    expect((afterSubstitution.players as QbjObject[]).map((player) => player.$ref)).toContain('Player_Alex');
  });

  test('match questions are exported', () => {
    const { definition } = openOne(assignmentDocument());
    const format = definition.scorekeeperFormat;
    const game = deriveGame(format, setupFor(definition), representativeEvents(format));

    const match = objectOfType(buildResultDocument({ definition, format, game }), 'Match');

    expect(Array.isArray(match.match_questions)).toBe(true);
    expect((match.match_questions as unknown[]).length).toBeGreaterThan(0);
  });

  test('the round revision travels with the result so a stale one is detectable', () => {
    const { definition } = openOne(assignmentDocument());
    const format = definition.scorekeeperFormat;
    const game = deriveGame(format, setupFor(definition), []);

    const match = objectOfType(buildResultDocument({ definition, format, game }), 'Match');
    const extension = match[qbtcpExtensionKey] as QbjObject;

    expect(extension.round_revision).toBe(3);
    expect(extension.room_id).toBe('room-204');
  });

  test('the extension never restates what standard QBJ already carries', () => {
    const { definition } = openOne(assignmentDocument());
    const format = definition.scorekeeperFormat;
    const game = deriveGame(format, setupFor(definition), []);

    const match = objectOfType(buildResultDocument({ definition, format, game }), 'Match');
    const extension = match[qbtcpExtensionKey] as QbjObject;

    for (const forbidden of ['tournament_id', 'tournament_name', 'match_id', 'round_name', 'teams', 'location', 'packet']) {
      expect(extension[forbidden]).toBeUndefined();
    }
  });

  test('a result document round-trips back into an equivalent game', () => {
    const { definition } = openOne(assignmentDocument());
    const format = definition.scorekeeperFormat;
    const game = deriveGame(format, setupFor(definition), representativeEvents(format));
    const result = buildResultDocument({ definition, format, game });

    const reopened = readQbjSource(JSON.parse(JSON.stringify(result)));

    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const candidate = reopened.value.candidates[0];
    expect(candidate.matchId).toBe('Match_sm-4471');
    expect(candidate.leftName).toBe('Ninety Six');
    // It now carries scoring, so it must not be offered as an untouched assignment.
    expect(candidate.state).not.toBe('unplayed');
  });
});

describe('output form', () => {
  test('the default download is an official serialized document', () => {
    const { definition } = openOne(assignmentDocument());
    const format = definition.scorekeeperFormat;
    const game = deriveGame(format, setupFor(definition), []);

    const result = buildResultDocument({ definition, format, game });

    expect(result.version).toBe('2.1.1');
    expect(Array.isArray(result.objects)).toBe(true);
    expect(result.objects.some((entry) => entry.type === 'Tournament')).toBe(true);
  });

  test('the compatibility export is still a bare match', () => {
    const { definition } = openOne(assignmentDocument());
    const format = definition.scorekeeperFormat;
    const game = deriveGame(format, setupFor(definition), []);

    const legacy = buildLegacyMatchOnly({ definition, format, game });

    expect(legacy.objects).toBeUndefined();
    expect(legacy.type).toBe('Match');
    expect(Array.isArray(legacy.match_teams)).toBe(true);
  });

  test('no output is a .qbg package', () => {
    const { definition } = openOne(assignmentDocument());
    const format = definition.scorekeeperFormat;
    const game = deriveGame(format, setupFor(definition), []);

    const result = buildResultDocument({ definition, format, game });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('quizbowl-game');
    expect(result.objects.every((entry) => entry.format !== 'quizbowl-game')).toBe(true);
  });

  test('filenames are descriptive, suffixed by purpose, and never identity', () => {
    const { definition } = openOne(assignmentDocument());

    expect(qbjFileName(definition, 'assignment')).toBe('R04_Room-204_Ninety-Six_vs_Greenwood.assignment.qbj');
    expect(qbjFileName(definition, 'result')).toBe('R04_Room-204_Ninety-Six_vs_Greenwood.result.qbj');
    expect(qbjFileName(definition, 'partial')).toBe('R04_Room-204_Ninety-Six_vs_Greenwood.partial.qbj');
  });

  test('a partial download is a truthful description of an unfinished game', () => {
    const { definition } = openOne(assignmentDocument());
    const format = definition.scorekeeperFormat;
    const partialGame = deriveGame(format, setupFor(definition), representativeEvents(format).slice(0, 4));

    const partial = buildResultDocument({ definition, format, game: partialGame, partial: true });
    const match = objectOfType(partial, 'Match');

    expect(match.id).toBe('Match_sm-4471');
    expect((match.match_teams as QbjObject[])[0].points).toBe(35);
    expect(match.tossups_read).toBe(partialGame.tossupsRead);
  });

  test('a partial download can be reopened and reconstructed', () => {
    const { definition } = openOne(assignmentDocument());
    const format = definition.scorekeeperFormat;
    const partialGame = deriveGame(format, setupFor(definition), representativeEvents(format).slice(0, 4));
    const partial = buildResultDocument({ definition, format, game: partialGame, partial: true });

    const reopened = openGameText(JSON.stringify(partial));

    expect(reopened.ok).toBe(true);
    if (!reopened.ok || reopened.kind !== 'game') throw new Error('Expected one game');
    expect(reopened.definition.qbjIdentity?.matchId).toBe('Match_sm-4471');
    expect(reopened.definition.left.name).toBe('Ninety Six');
  });

  test('nothing credential-shaped reaches a portable document', () => {
    const { definition } = openOne(assignmentDocument());
    const format = definition.scorekeeperFormat;
    const game = deriveGame(format, setupFor(definition), representativeEvents(format));

    const serialized = JSON.stringify(buildResultDocument({ definition, format, game })).toLowerCase();

    for (const forbidden of ['token', 'pairing', 'authorization', 'device_id', 'deviceid', 'secret', 'password', '_yf_scorekeeper_recovery']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('one parser for file and network', () => {
  test('a QBTCP assignment body and a file assignment define the same game', () => {
    // The network path contributes credentials and a base URL. It contributes no parsing, so the
    // same bytes must produce the same definition however they arrived.
    const document = assignmentDocument();
    const fromFile = openOne(document).definition;
    const fromNetwork = openOne(JSON.parse(text(document))).definition;

    expect(fromNetwork).toEqual(fromFile);
  });

  test('the definition never carries the envelope it arrived in', () => {
    const { definition } = openOne(assignmentDocument());

    expect((definition as unknown as QbjObject).objects).toBeUndefined();
    expect(isPlainObject(definition.scorekeeperFormat)).toBe(true);
  });
});

describe('round numbers', () => {
  test('a numeric Round.name is the round number, because QBJ has no field for one', () => {
    // Standard QBJ Round carries only a name; the reference implementation writes the bare number
    // there and resolves rounds by parsing it. Reading it the same way reads what it writes.
    const { definition } = openOne(assignmentDocument({ roundName: '7', omitRoundNumber: true }));

    expect(definition.round.number).toBe(7);
  });

  test('a non-numeric round name is not turned into a wrong number', () => {
    const { definition } = openOne(
      assignmentDocument({ roundName: 'Playoff 2', omitRoundNumber: true }),
    );

    // Scoring still works; the round simply has no number.
    expect(definition.round.number).toBe(0);
    expect(definition.round.name).toBe('Playoff 2');
  });

  test('an explicit numeric field still wins where a producer supplies one', () => {
    const source = readQbjSource(assignmentDocument({ roundNumber: 9, roundName: 'Finals' }));
    if (!source.ok) throw new Error('Expected a readable document');

    // `assignmentDocument` writes `number` alongside the name.
    expect(source.value.candidates[0].roundNumber).toBe(9);
  });
});
