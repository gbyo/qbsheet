/**
 * Correcting the game's own definition after play has begun.
 *
 * The invariant behind all of it: the initial assignment is not sacred, and correcting it must not
 * cost the room a single recorded question. Every test here checks both halves — that the definition
 * moved, and that the history survived it intact.
 */
import { describe, expect, test } from 'vitest';
import { event } from './events';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import { IRoomProcedure } from '../src/scoring/RoomProcedure';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import correctProcedure from '../src/scoring/procedureCorrection';
import { correctPlayerName, correctTeamName } from '../src/scoring/identityCorrection';
import removeOvertime, {
  overtimeQuestionNumbers,
  overtimeRemovalNote,
} from '../src/scoring/overtimeCorrection';
import { isCorrectionNote } from '../src/scoring/gameCorrection';
import validateScoresheet, { validateCorrectedHistory } from '../src/scoring/validateScoresheet';
import toQbjMatch from '../src/scoring/toQbjMatch';
import { playerIdentityKey } from '../src/game/GameDefinition';

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah', 'James', 'Avery'], startingLineup: ['Sarah', 'James'] },
  right: { name: 'Greenwood', players: ['Emma', 'Jordan', 'Riley'], startingLineup: ['Emma', 'Jordan'] },
};

function formatFor(ruleSet: CommonRuleSets = CommonRuleSets.Acf, tossupCount = 4): IScorekeeperFormat {
  const rules = new ScoringRules(ruleSet);
  rules.timed = false;
  rules.maximumRegulationTossupCount = tossupCount;
  rules.minimumOvertimeQuestionCount = 1;
  rules.maximumPlayersPerTeam = 2;
  return scoringRulesToScorekeeperFormat(rules);
}

const format = formatFor();
const correct = format.answerTypes.find((answerType) => answerType.value > 0)?.index ?? 0;

function buzz(questionNumber: number, team: 'left' | 'right', playerName: string): ScoreEvent[] {
  return [
    event({ type: 'tossup-buzz', questionNumber, team, playerName, answerTypeIndex: correct }),
    event({ type: 'bonus', questionNumber, team, controlledPoints: 10, bouncebackPoints: 0 }),
  ];
}

// #region team identity

describe('correcting a team name', () => {
  const history = buzz(1, 'left', 'Sarah');

  test('keeps every recorded question with the same team', () => {
    const before = deriveGame(format, setup, history);
    const corrected = correctTeamName({ setup, events: history }, 'left', 'Ninety Six A');
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) throw new Error('unreachable');

    const after = deriveGame(format, corrected.setup, corrected.events);
    expect(after.left.name).toBe('Ninety Six A');
    expect(after.left.points).toBe(before.left.points);
    expect(after.left.players.find((player) => player.name === 'Sarah')?.tossupsHeard).toBe(
      before.left.players.find((player) => player.name === 'Sarah')?.tossupsHeard,
    );
  });

  test('re-keys the tournament player ids rather than dropping them', () => {
    const playerIds = {
      [playerIdentityKey('Ninety Six', 'Sarah')]: 'player-1',
      [playerIdentityKey('Greenwood', 'Emma')]: 'player-2',
    };
    const corrected = correctTeamName({ setup, events: history, playerIds }, 'left', 'Ninety Six A');
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) throw new Error('unreachable');

    expect(corrected.playerIds).toEqual({
      [playerIdentityKey('Ninety Six A', 'Sarah')]: 'player-1',
      [playerIdentityKey('Greenwood', 'Emma')]: 'player-2',
    });
  });

  test('refuses a name that would make the two teams indistinguishable', () => {
    const corrected = correctTeamName({ setup, events: history }, 'left', 'greenwood');
    expect(corrected.ok).toBe(false);
    if (corrected.ok) throw new Error('unreachable');
    expect(corrected.problems[0]).toContain('same name');
  });
});

// #endregion
// #region player identity

describe('correcting a player name', () => {
  const history = [
    ...buzz(1, 'left', 'Sarah'),
    event({ type: 'tossup-dead', questionNumber: 2 }),
    event({ type: 'substitution', questionNumber: 3, team: 'left', activePlayers: ['Sarah', 'Avery'] }),
    ...buzz(3, 'left', 'Sarah'),
  ];

  test('follows the player through every recorded reference, and changes no statistic', () => {
    const before = deriveGame(format, setup, history);
    const corrected = correctPlayerName({ setup, events: history }, 'left', 'Sarah', 'Sarah Mitchell');
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) throw new Error('unreachable');

    const after = deriveGame(format, corrected.setup, corrected.events);
    const was = before.left.players.find((player) => player.name === 'Sarah');
    const now = after.left.players.find((player) => player.name === 'Sarah Mitchell');

    expect(after.left.players.some((player) => player.name === 'Sarah')).toBe(false);
    expect(now?.tossupsHeard).toBe(was?.tossupsHeard);
    expect(now?.points).toBe(was?.points);
    expect(after.left.points).toBe(before.left.points);
    expect(after.left.activePlayers).toEqual(['Sarah Mitchell', 'Avery']);
    expect(validateCorrectedHistory(format, corrected.setup, corrected.events).blockers).toEqual([]);
  });

  test('carries the tournament identity onto the corrected name', () => {
    const playerIds = { [playerIdentityKey('Ninety Six', 'Sarah')]: 'player-1' };
    const corrected = correctPlayerName(
      { setup, events: history, playerIds },
      'left',
      'Sarah',
      'Sarah Mitchell',
    );
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) throw new Error('unreachable');

    expect(corrected.playerIds).toEqual({
      [playerIdentityKey('Ninety Six', 'Sarah Mitchell')]: 'player-1',
    });
  });

  test('refuses a name already on the roster, and says a merge is available instead', () => {
    const corrected = correctPlayerName({ setup, events: history }, 'left', 'Sarah', 'Avery');
    expect(corrected.ok).toBe(false);
    if (corrected.ok) throw new Error('unreachable');
    expect(corrected.mergeAvailable).toBe(true);
  });

  test('merges two displayed names into one player only when that is asked for', () => {
    const duplicated = history.concat(
      event({ type: 'roster-add', questionNumber: 4, team: 'left', playerName: 'Sara' }),
      event({ type: 'substitution', questionNumber: 4, team: 'left', activePlayers: ['Sarah', 'Sara'] }),
    );
    const corrected = correctPlayerName({ setup, events: duplicated }, 'left', 'Sara', 'Sarah', {
      merge: true,
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) throw new Error('unreachable');
    expect(corrected.merged).toBe(true);

    // The impossible lineup a merge can produce -- the same person twice -- is collapsed rather than
    // written out, so the corrected history is one the engine accepts.
    const merged = corrected.events.find(
      (candidate): candidate is Extract<ScoreEvent, { type: 'substitution' }> =>
        candidate.type === 'substitution' && candidate.questionNumber === 4,
    );
    expect(merged?.activePlayers).toEqual(['Sarah']);
    expect(corrected.setup.left.players).toEqual(['Sarah', 'James', 'Avery']);
    // The duplicate roster addition goes with it: the merge has just decided that nobody was added.
    expect(corrected.events.some((candidate) => candidate.type === 'roster-add')).toBe(false);
    expect(validateCorrectedHistory(format, corrected.setup, corrected.events).blockers).toEqual([]);
  });

  test('no supported correction leaves a duplicate or orphan player behind', () => {
    const corrected = correctPlayerName({ setup, events: history }, 'left', 'Sarah', 'Sarah Mitchell');
    if (!corrected.ok) throw new Error('unreachable');
    const game = deriveGame(format, corrected.setup, corrected.events);

    const names = game.left.players.map((player) => player.name);
    expect(new Set(names).size).toBe(names.length);
    // Every name the history refers to is on the roster: nobody was left pointing at a person who
    // no longer exists.
    for (const candidate of corrected.events) {
      if (candidate.type === 'tossup-buzz' && candidate.team === 'left') {
        expect(names).toContain(candidate.playerName);
      }
    }
  });
});

// #endregion
// #region historical lineups

describe('correcting when a lineup became effective', () => {
  /** Ten dead tossups, with the lineup recorded as having changed before question 9. */
  const played = Array.from({ length: 10 }, (_, index) =>
    event({ type: 'tossup-dead', questionNumber: index + 1 }),
  );
  const recordedAtNine = played.concat(
    event({ type: 'substitution', questionNumber: 9, team: 'left', activePlayers: ['Sarah', 'Avery'] }),
  );

  /** The same event, said to have taken effect two tossups earlier. */
  const movedToSeven = recordedAtNine.map((candidate) =>
    candidate.type === 'substitution' ? { ...candidate, questionNumber: 7 } : candidate,
  );

  test('moving the boundary changes tossups heard only across the span it moved', () => {
    const longFormat = formatFor(CommonRuleSets.Acf, 10);
    const before = deriveGame(longFormat, setup, recordedAtNine);
    const after = deriveGame(longFormat, setup, movedToSeven);

    const heard = (game: ReturnType<typeof deriveGame>, name: string) =>
      game.left.players.find((player) => player.name === name)?.tossupsHeard ?? 0;

    // Two tossups move from James to Avery, and nobody else is touched -- not the opponent, not the
    // player who was on the floor throughout, and not the game's own count.
    expect(heard(before, 'James') - heard(after, 'James')).toBe(2);
    expect(heard(after, 'Avery') - heard(before, 'Avery')).toBe(2);
    expect(heard(after, 'Sarah')).toBe(heard(before, 'Sarah'));
    expect(after.right.players.map((player) => player.tossupsHeard)).toEqual(
      before.right.players.map((player) => player.tossupsHeard),
    );
    expect(after.tossupsRead).toBe(before.tossupsRead);
  });

  test('works even where the procedure would not allow a substitution now', () => {
    const longFormat = formatFor(CommonRuleSets.Acf, 10);
    const restrictive: IRoomProcedure = {
      version: 3,
      halves: true,
      timeoutsPerTeam: 0,
      substitutionPolicy: 'breaks-timeouts-overtime',
    };

    /*
     * This is the distinction the whole design turns on. A correction is a statement about what
     * already happened, so it is validated as history rather than as a forward transition -- and
     * the history is coherent whatever the substitution policy says about *now*.
     */
    expect(validateCorrectedHistory(longFormat, setup, movedToSeven, restrictive).blockers).toEqual([]);
  });

  test('a lineup naming the same player twice is impossible rather than unusual', () => {
    const longFormat = formatFor(CommonRuleSets.Acf, 10);
    const impossible = played.concat(
      event({
        type: 'substitution',
        questionNumber: 7,
        team: 'left',
        activePlayers: ['Sarah', 'Sarah'],
      }),
    );

    expect(
      validateCorrectedHistory(longFormat, setup, impossible, undefined).blockers.length,
    ).toBeGreaterThan(0);
  });
});

describe('a player who arrives after the game starts', () => {
  test('is charged only the tossups played after they came on', () => {
    const longFormat = formatFor(CommonRuleSets.Acf, 6);
    const history: ScoreEvent[] = [
      event({ type: 'tossup-dead', questionNumber: 1 }),
      event({ type: 'tossup-dead', questionNumber: 2 }),
      event({ type: 'roster-add', questionNumber: 3, team: 'left', playerName: 'Priya' }),
      event({ type: 'substitution', questionNumber: 3, team: 'left', activePlayers: ['Sarah', 'Priya'] }),
      event({ type: 'tossup-dead', questionNumber: 3 }),
      event({ type: 'tossup-dead', questionNumber: 4 }),
    ];
    const game = deriveGame(longFormat, setup, history);
    const heard = (name: string) =>
      game.left.players.find((player) => player.name === name)?.tossupsHeard ?? 0;

    expect(heard('Priya')).toBe(2);
    expect(heard('Sarah')).toBe(4);
    expect(heard('James')).toBe(2);
    expect(game.tossupsRead).toBe(4);
    // Locally added and not yet reconciled with the tournament: worth saying, never worth blocking.
    const validation = validateScoresheet(longFormat, setup, history);
    expect(validation.warnings.some((problem) => problem.code === 'local-roster-addition')).toBe(true);
    expect(validation.blockers.some((problem) => problem.code === 'local-roster-addition')).toBe(false);
  });

  test('can have the name they were entered under corrected afterwards', () => {
    const longFormat = formatFor(CommonRuleSets.Acf, 6);
    const history: ScoreEvent[] = [
      event({ type: 'tossup-dead', questionNumber: 1 }),
      event({ type: 'roster-add', questionNumber: 2, team: 'left', playerName: 'Prya' }),
      event({ type: 'substitution', questionNumber: 2, team: 'left', activePlayers: ['Sarah', 'Prya'] }),
      event({
        type: 'tossup-buzz',
        questionNumber: 2,
        team: 'left',
        playerName: 'Prya',
        answerTypeIndex: correct,
      }),
      event({ type: 'bonus', questionNumber: 2, team: 'left', controlledPoints: 10, bouncebackPoints: 0 }),
    ];
    const corrected = correctPlayerName({ setup, events: history }, 'left', 'Prya', 'Priya');
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) throw new Error('unreachable');

    const game = deriveGame(longFormat, corrected.setup, corrected.events);
    expect(game.left.players.find((player) => player.name === 'Priya')?.points).toBe(10);
    expect(game.left.players.some((player) => player.name === 'Prya')).toBe(false);
    expect(validateCorrectedHistory(longFormat, corrected.setup, corrected.events).blockers).toEqual([]);
  });
});

// #endregion
// #region procedure

describe('correcting the room procedure', () => {
  const oneTimeout: IRoomProcedure = { version: 3, halves: false, timeoutsPerTeam: 1 };
  const history = [...buzz(1, 'left', 'Sarah'), event({ type: 'timeout', questionNumber: 2, team: 'left' })];
  const game = deriveGame(format, setup, history);

  test('raising the timeout allowance after one has been used keeps the recorded timeout', () => {
    const corrected = correctProcedure(oneTimeout, { ...oneTimeout, timeoutsPerTeam: 2 }, history, game);
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) throw new Error('unreachable');

    expect(corrected.changes).toContainEqual({
      subject: 'Timeouts per team',
      detail: '1 → 2',
      affectsRecordedScoring: false,
    });
    expect(deriveGame(format, setup, history).timeouts.left).toBe(1);
  });

  test('lowering it below what a team has already taken is refused rather than warned about', () => {
    const corrected = correctProcedure(oneTimeout, { ...oneTimeout, timeoutsPerTeam: 0 }, history, game);
    expect(corrected.ok).toBe(false);
    if (corrected.ok) throw new Error('unreachable');
    expect(corrected.problems[0]).toContain('Ninety Six has already taken 1 timeout');
  });

  test('a break already taken is kept, and the consequence is stated rather than the history erased', () => {
    const withBreak = history.concat(event({ type: 'half-break', questionNumber: 2, lastQuestion: 1 }));
    const brokeOnce = deriveGame(format, setup, withBreak);
    const before: IRoomProcedure = { version: 3, halves: true, timeoutsPerTeam: 1 };

    const corrected = correctProcedure(
      before,
      { ...before, halves: false, timeoutsPerTeam: 1 },
      withBreak,
      brokeOnce,
    );
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) throw new Error('unreachable');

    expect(corrected.consequences[0]).toContain('already stopped once');
    expect(brokeOnce.halfBreaks).toEqual([1]);
  });

  test('a proposal that changes nothing reports itself as unchanged', () => {
    const corrected = correctProcedure(oneTimeout, { ...oneTimeout }, history, game);
    expect(corrected).toMatchObject({ ok: true, unchanged: true });
  });

  /*
   * What the confirmation screen shows is what gets written, because it is the same object. The
   * alternative -- a preview computed one way and a commit computed another -- is how a room ends up
   * agreeing to one change and receiving a different one.
   */
  test('the preview is the correction: asking twice gives the same answer, and applying it settles', () => {
    const proposed = { ...oneTimeout, timeoutsPerTeam: 2 };
    const first = correctProcedure(oneTimeout, proposed, history, game);
    const second = correctProcedure(oneTimeout, proposed, history, game);
    expect(first).toEqual(second);
    if (!first.ok) throw new Error('unreachable');

    const settled = correctProcedure(first.procedure, first.procedure, history, game);
    expect(settled).toMatchObject({ ok: true, unchanged: true });
  });

  test('a name correction applied twice is a name correction applied once', () => {
    const once = correctPlayerName({ setup, events: history }, 'left', 'Sarah', 'Sarah Mitchell');
    const again = correctPlayerName({ setup, events: history }, 'left', 'Sarah', 'Sarah Mitchell');
    expect(once).toEqual(again);
    if (!once.ok) throw new Error('unreachable');

    const settled = correctPlayerName(
      { setup: once.setup, events: once.events },
      'left',
      'Sarah Mitchell',
      'Sarah Mitchell',
    );
    expect(settled).toMatchObject({ ok: true, changes: [] });
  });
});

// #endregion
// #region overtime that a correction made unnecessary

describe('overtime after a protest changes the regulation result', () => {
  /** A regulation that finished level, then two overtime tossups. */
  const tiedRegulation: ScoreEvent[] = [
    ...buzz(1, 'left', 'Sarah'),
    ...buzz(2, 'right', 'Emma'),
    event({ type: 'tossup-dead', questionNumber: 3 }),
    event({ type: 'tossup-dead', questionNumber: 4 }),
    event({ type: 'begin-overtime', questionNumber: 4 }),
    ...buzz(5, 'left', 'Sarah'),
  ];

  test('a corrected regulation that is no longer tied is reported, not silently accepted', () => {
    const game = deriveGame(format, setup, tiedRegulation);
    expect(game.overtimeUnnecessary).toBe(false);

    // The protest is upheld: Greenwood's question 2 was wrong after all.
    const corrected = tiedRegulation.filter(
      (candidate) => !(candidate.questionNumber === 2 && candidate.type === 'bonus'),
    );
    const rescored = corrected.map((candidate) =>
      candidate.type === 'tossup-buzz' && candidate.questionNumber === 2
        ? ({ ...candidate, type: 'tossup-dead' } as unknown as ScoreEvent)
        : candidate,
    );
    const after = deriveGame(format, setup, rescored);

    expect(after.overtimeUnnecessary).toBe(true);
    const validation = validateScoresheet(format, setup, rescored);
    expect(validation.warnings.some((problem) => problem.code === 'overtime-not-required')).toBe(true);
    // Reported, not blocked: whether those tossups count is a ruling somebody has to make.
    expect(validation.blockers.some((problem) => problem.code === 'overtime-not-required')).toBe(false);
  });

  test('striking the overtime out leaves a coherent regulation-only game', () => {
    const rescored = tiedRegulation
      .filter((candidate) => !(candidate.questionNumber === 2 && candidate.type === 'bonus'))
      .map((candidate) =>
        candidate.type === 'tossup-buzz' && candidate.questionNumber === 2
          ? ({ ...candidate, type: 'tossup-dead' } as unknown as ScoreEvent)
          : candidate,
      );
    const withOvertime = deriveGame(format, setup, rescored);
    expect(overtimeQuestionNumbers(withOvertime)).toEqual([5]);

    const struck = removeOvertime(rescored, withOvertime);
    const after = deriveGame(format, setup, struck);

    expect(after.overtimeTossupsRead).toBe(0);
    expect(after.overtimeStarted).toBe(false);
    expect(after.overtimeUnnecessary).toBe(false);
    expect(after.phase).toEqual({ kind: 'complete', reason: 'regulation' });
    expect(validateScoresheet(format, setup, struck).blockers).toEqual([]);
  });

  test('a correction that creates a tie sends a finished game back to the overtime checkpoint', () => {
    const decided: ScoreEvent[] = [
      ...buzz(1, 'left', 'Sarah'),
      event({ type: 'tossup-dead', questionNumber: 2 }),
      event({ type: 'tossup-dead', questionNumber: 3 }),
      event({ type: 'tossup-dead', questionNumber: 4 }),
    ];
    expect(deriveGame(format, setup, decided).phase).toEqual({ kind: 'complete', reason: 'regulation' });

    // The protest is upheld the other way: Greenwood had question 2 after all.
    const tied = decided
      .filter((candidate) => !(candidate.questionNumber === 2 && candidate.type === 'tossup-dead'))
      .concat(buzz(2, 'right', 'Emma'));
    const after = deriveGame(format, setup, tied);

    expect(after.left.points).toBe(after.right.points);
    expect(after.phase).toEqual({ kind: 'checkpoint', checkpoint: 'overtime', afterQuestion: 4 });
  });
});

// #endregion

describe('a replacement question', () => {
  const longFormat = formatFor(CommonRuleSets.Acf, 6);
  /** A lineup change before question 3, then question 3 played and spoiled. */
  const history: ScoreEvent[] = [
    event({ type: 'tossup-dead', questionNumber: 1 }),
    event({ type: 'tossup-dead', questionNumber: 2 }),
    event({ type: 'substitution', questionNumber: 3, team: 'left', activePlayers: ['Sarah', 'Avery'] }),
    event({
      type: 'tossup-buzz',
      questionNumber: 3,
      team: 'left',
      playerName: 'Avery',
      answerTypeIndex: correct,
    }),
    event({ type: 'bonus', questionNumber: 3, team: 'left', controlledPoints: 10, bouncebackPoints: 0 }),
  ];

  test('keeps the lineup that heard the original, and charges nobody the tossup twice', () => {
    const before = deriveGame(longFormat, setup, history);
    expect(before.questions.find((question) => question.questionNumber === 3)?.activePlayers.left).toEqual([
      'Sarah',
      'Avery',
    ]);

    const voided = history.concat(
      event({
        type: 'question-void',
        questionNumber: 3,
        scope: 'tossup',
        reason: 'Read from the wrong packet',
      }),
    );
    /*
     * The lineup is a personnel fact rather than a scoring one, so voiding the cycle does not touch
     * it. That is what stops a replacement charging Avery a second tossup heard: the cycle stops
     * existing until something is scored on the replacement, and the lineup that was on the floor is
     * still the lineup that was on the floor.
     */
    const emptied = deriveGame(longFormat, setup, voided);
    expect(emptied.tossupsRead).toBe(2);
    expect(emptied.left.players.find((player) => player.name === 'Avery')?.tossupsHeard).toBe(0);

    const replayed = voided.concat(
      event({
        type: 'tossup-buzz',
        questionNumber: 3,
        team: 'right',
        playerName: 'Emma',
        answerTypeIndex: correct,
      }),
      event({ type: 'bonus', questionNumber: 3, team: 'right', controlledPoints: 20, bouncebackPoints: 0 }),
    );
    const after = deriveGame(longFormat, setup, replayed);

    expect(after.questions.find((question) => question.questionNumber === 3)?.activePlayers.left).toEqual([
      'Sarah',
      'Avery',
    ]);
    expect(after.left.players.find((player) => player.name === 'Avery')?.tossupsHeard).toBe(1);
    expect(after.left.players.find((player) => player.name === 'James')?.tossupsHeard).toBe(2);
    expect(after.questions.find((question) => question.questionNumber === 3)?.replaced).toBe(true);
  });

  test('a replacement read under different eligibility can be explained even where QBJ has no field for it', () => {
    /*
     * Standard QBJ has nowhere to say "the replacement tossup was read only to Greenwood". What it
     * can hold is what happened -- one team answered, the tossup ended -- and `Match.notes`, which is
     * where the ruling goes. The result stays exactly as truthful as the schema allows.
     */
    const explained = history.concat(
      event({
        type: 'question-void',
        questionNumber: 3,
        scope: 'tossup',
        reason: 'Read from the wrong packet',
      }),
      event({
        type: 'procedure-exception',
        questionNumber: 3,
        allowance: 'other',
        authority: 'tournament-director',
        reason: 'Replacement read to Greenwood only; Ninety Six had heard the original',
      }),
      event({
        type: 'tossup-buzz',
        questionNumber: 3,
        team: 'right',
        playerName: 'Emma',
        answerTypeIndex: correct,
      }),
      event({ type: 'bonus', questionNumber: 3, team: 'right', controlledPoints: 20, bouncebackPoints: 0 }),
      event({ type: 'tossup-dead', questionNumber: 4 }),
      event({ type: 'tossup-dead', questionNumber: 5 }),
      event({ type: 'tossup-dead', questionNumber: 6 }),
    );
    const validation = validateScoresheet(longFormat, setup, explained);
    expect(validation.blockers).toEqual([]);

    const qbj = toQbjMatch(longFormat, validation.game) as { notes?: string; tossups_read?: number };
    expect(qbj.notes).toContain('Replacement read to Greenwood only');
    expect(qbj.notes).toContain('Q3 tossup replaced');
    expect(qbj.tossups_read).toBe(6);
  });
});

describe('the audit a correction leaves', () => {
  /*
   * Every correction writes one note, and every one of those notes is recognizable as a correction
   * rather than merely readable as one. Game details lists them from that marker, so a correction
   * whose summary forgot it would simply stop appearing — which is the kind of omission nothing else
   * would notice.
   */
  test('every correction summary carries the marker Game details reads', () => {
    const history = buzz(1, 'left', 'Sarah');
    const game = deriveGame(format, setup, history);
    const procedure: IRoomProcedure = { version: 3, halves: false, timeoutsPerTeam: 1 };

    const team = correctTeamName({ setup, events: history }, 'left', 'Ninety Six A');
    const player = correctPlayerName({ setup, events: history }, 'left', 'Sarah', 'Sarah Mitchell');
    const merged = correctPlayerName({ setup, events: history }, 'left', 'Sarah', 'Avery', {
      merge: true,
    });
    const room = correctProcedure(procedure, { ...procedure, timeoutsPerTeam: 2 }, history, game);
    if (!team.ok || !player.ok || !merged.ok || !room.ok) throw new Error('unreachable');

    for (const summary of [team.summary, player.summary, merged.summary, room.summary]) {
      expect(isCorrectionNote(summary)).toBe(true);
    }
    expect(isCorrectionNote(overtimeRemovalNote([5]))).toBe(true);
    // A scorekeeper's own note is not one of these, however it is worded.
    expect(isCorrectionNote('Q3 corrected pronunciation of the answer')).toBe(false);
  });
});

describe('exports survive every correction', () => {
  test('a renamed team and player still produce a valid, complete match', () => {
    const history = [
      ...buzz(1, 'left', 'Sarah'),
      event({ type: 'tossup-dead', questionNumber: 2 }),
      event({ type: 'tossup-dead', questionNumber: 3 }),
      event({ type: 'tossup-dead', questionNumber: 4 }),
    ];
    const renamedTeam = correctTeamName({ setup, events: history }, 'left', 'Ninety Six A');
    if (!renamedTeam.ok) throw new Error('unreachable');
    const renamedPlayer = correctPlayerName(
      { setup: renamedTeam.setup, events: renamedTeam.events },
      'left',
      'Sarah',
      'Sarah Mitchell',
    );
    if (!renamedPlayer.ok) throw new Error('unreachable');

    const validation = validateScoresheet(format, renamedPlayer.setup, renamedPlayer.events);
    expect(validation.blockers).toEqual([]);

    const qbj = toQbjMatch(format, validation.game) as {
      match_teams?: { team?: { name?: string }; match_players?: { player?: { name?: string } }[] }[];
    };
    expect(qbj.match_teams?.[0]?.team?.name).toBe('Ninety Six A');
    expect(qbj.match_teams?.[0]?.match_players?.map((player) => player.player?.name)).toContain(
      'Sarah Mitchell',
    );
  });
});
