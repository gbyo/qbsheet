/**
 * Authorized departures from procedure, and the escape routes that lead to them.
 *
 * The philosophy under test: a room may do what a director tells it to, and everything else stays
 * exactly as strict as it was. So each of these has a partner — one that shows the departure is
 * possible once it has been authorized, and one that shows it is still refused when it has not.
 */
import { describe, expect, test } from 'vitest';
import { event } from './events';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import { IRoomProcedure } from '../src/scoring/RoomProcedure';
import canApplyScoreEvent, { applyScoreEvents } from '../src/scoring/canApplyScoreEvent';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import { ProcedureAllowance, ScoreEvent } from '../src/scoring/ScoreEvents';
import validateScoresheet from '../src/scoring/validateScoresheet';
import toQbjMatch from '../src/scoring/toQbjMatch';
import {
  breaksSkipped,
  extraTimeoutsGranted,
  substitutionAllowed,
  unspentAllowances,
} from '../src/scoring/ProcedureExceptions';

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah', 'James', 'Avery'], startingLineup: ['Sarah', 'James'] },
  right: { name: 'Greenwood', players: ['Emma', 'Jordan', 'Riley'], startingLineup: ['Emma', 'Jordan'] },
};

function formatFor(ruleSet: CommonRuleSets = CommonRuleSets.Acf): IScorekeeperFormat {
  const rules = new ScoringRules(ruleSet);
  rules.timed = false;
  rules.maximumRegulationTossupCount = 4;
  rules.minimumOvertimeQuestionCount = 1;
  rules.maximumPlayersPerTeam = 2;
  return scoringRulesToScorekeeperFormat(rules);
}

const oneTimeout: IRoomProcedure = { version: 3, halves: false, timeoutsPerTeam: 1 };

function grant(
  allowance: ProcedureAllowance,
  overrides: Partial<{ team: 'left' | 'right'; questionNumber: number }> = {},
): ScoreEvent {
  return event({
    type: 'procedure-exception',
    questionNumber: overrides.questionNumber ?? 1,
    allowance,
    authority: 'tournament-director',
    reason: 'Director said so',
    ...(overrides.team ? { team: overrides.team } : {}),
  });
}

describe('an extra timeout', () => {
  const format = formatFor();
  const context = { format, setup, procedure: oneTimeout };
  const used: ScoreEvent[] = [event({ type: 'timeout', questionNumber: 1, team: 'left' })];

  test('is refused, with a route out, once the configured allocation is spent', () => {
    const verdict = canApplyScoreEvent(
      context,
      used,
      event({ type: 'timeout', questionNumber: 1, team: 'left' }),
    );

    expect(verdict).toMatchObject({ ok: false, escape: 'timeout-allowance' });
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.reason).toContain('Ninety Six has already used its timeout');
  });

  test('is allowed once a director has granted one, and only for that team', () => {
    const granted = used.concat(grant('extra-timeout', { team: 'left' }));

    expect(
      canApplyScoreEvent(context, granted, event({ type: 'timeout', questionNumber: 1, team: 'left' })),
    ).toEqual({ ok: true });
    // The other team's allocation is untouched by a grant that was not theirs. Greenwood still has
    // its configured one and no more.
    const greenwoodUsed = granted.concat(event({ type: 'timeout', questionNumber: 1, team: 'right' }));
    expect(
      canApplyScoreEvent(
        context,
        greenwoodUsed,
        event({ type: 'timeout', questionNumber: 1, team: 'right' }),
      ),
    ).toMatchObject({ ok: false });
  });

  test('raises the ceiling by exactly one, so a third timeout needs a second ruling', () => {
    const twice = used
      .concat(grant('extra-timeout', { team: 'left' }))
      .concat(event({ type: 'timeout', questionNumber: 2, team: 'left' }));

    expect(extraTimeoutsGranted(twice, 'left')).toBe(1);
    expect(
      canApplyScoreEvent(context, twice, event({ type: 'timeout', questionNumber: 2, team: 'left' })),
    ).toMatchObject({ ok: false });
  });

  test('works in a tournament that tracks no timeouts at all', () => {
    const noTimeouts = { format, setup, procedure: { version: 3, halves: false, timeoutsPerTeam: 0 } };
    const bare = event({ type: 'timeout', questionNumber: 1, team: 'left' });

    expect(canApplyScoreEvent(noTimeouts, [], bare)).toMatchObject({
      ok: false,
      escape: 'timeout-allowance',
    });
    expect(canApplyScoreEvent(noTimeouts, [grant('extra-timeout', { team: 'left' })], bare)).toEqual({
      ok: true,
    });
  });

  test('leaves an ordinary timeout looking like an ordinary timeout', () => {
    const history = used.concat(
      grant('extra-timeout', { team: 'left' }),
      event({ type: 'timeout', questionNumber: 2, team: 'left' }),
    );
    const game = deriveGame(format, setup, history);

    expect(game.timeouts).toEqual({ left: 2, right: 0 });
    expect(game.procedureExceptions).toHaveLength(1);
    expect(game.procedureExceptions[0]).toMatchObject({ allowance: 'extra-timeout', teamName: 'Ninety Six' });
  });
});

describe('a lineup change outside the usual opportunity', () => {
  const format = formatFor();
  const restrictive: IRoomProcedure = {
    version: 3,
    halves: true,
    timeoutsPerTeam: 0,
    substitutionPolicy: 'breaks-timeouts-overtime',
  };
  const context = { format, setup, procedure: restrictive };
  const played: ScoreEvent[] = [event({ type: 'tossup-dead', questionNumber: 1 })];
  const substitution = event({
    type: 'substitution',
    questionNumber: 2,
    team: 'left',
    activePlayers: ['Sarah', 'Avery'],
  });

  test('is refused mid-half, with a route out', () => {
    const verdict = canApplyScoreEvent(context, played, substitution);

    expect(verdict).toMatchObject({ ok: false, escape: 'substitution-opportunity' });
  });

  test('is allowed once, and the next one needs its own ruling', () => {
    const granted = played.concat(grant('substitution', { team: 'left', questionNumber: 2 }));
    expect(substitutionAllowed(granted, 'left')).toBe(true);

    const applied = applyScoreEvents(context, granted, [substitution]);
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error('unreachable');

    // Spent by the substitution it authorized.
    expect(substitutionAllowed(applied.events, 'left')).toBe(false);
    const secondGame = deriveGame(format, setup, applied.events);
    expect(secondGame.left.activePlayers).toEqual(['Sarah', 'Avery']);
  });

  test('does not authorize the other team', () => {
    const granted = played.concat(grant('substitution', { team: 'left', questionNumber: 2 }));

    expect(
      canApplyScoreEvent(
        context,
        granted,
        event({
          type: 'substitution',
          questionNumber: 2,
          team: 'right',
          activePlayers: ['Emma', 'Riley'],
        }),
      ),
    ).toMatchObject({ ok: false, escape: 'substitution-opportunity' });
  });
});

describe('breaks', () => {
  const format = formatFor();
  const scheduled: IRoomProcedure = {
    version: 3,
    halves: true,
    timeoutsPerTeam: 0,
    breaks: [{ afterTossup: 2 }, { afterTossup: 4 }],
  };
  const context = { format, setup, procedure: scheduled };
  const afterOne: ScoreEvent[] = [event({ type: 'tossup-dead', questionNumber: 1 })];
  const breakNow = event({ type: 'half-break', questionNumber: 2, lastQuestion: 1 });

  test('an unscheduled stop is refused, with a route out', () => {
    expect(canApplyScoreEvent(context, afterOne, breakNow)).toMatchObject({
      ok: false,
      escape: 'break-schedule',
    });
  });

  test('an authorized extra break is taken once and then spent', () => {
    const granted = afterOne.concat(grant('extra-break', { questionNumber: 2 }));
    const applied = applyScoreEvents(context, granted, [breakNow]);

    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error('unreachable');
    expect(unspentAllowances(applied.events, 'extra-break')).toHaveLength(0);
  });

  test('skipping a scheduled break moves the schedule along rather than pretending one happened', () => {
    const skipped = afterOne.concat(grant('skip-break', { questionNumber: 2 }));
    const game = deriveGame(format, setup, skipped);

    expect(breaksSkipped(skipped)).toBe(1);
    expect(game.halfBreaks).toEqual([]);
    // The break after tossup 2 was skipped, so the next stop the room owes is the one after 4 — and
    // it may not stop before then.
    expect(canApplyScoreEvent(context, skipped, breakNow)).toMatchObject({ ok: false });
    const throughFour = skipped.concat(
      event({ type: 'tossup-dead', questionNumber: 2 }),
      event({ type: 'tossup-dead', questionNumber: 3 }),
      event({ type: 'tossup-dead', questionNumber: 4 }),
    );
    expect(
      canApplyScoreEvent(
        { format, setup, procedure: scheduled },
        throughFour,
        event({ type: 'half-break', questionNumber: 5, lastQuestion: 4 }),
      ),
    ).toEqual({ ok: true });
  });
});

describe('one more tossup than the format has', () => {
  const format = formatFor();
  const context = { format, setup };
  const fullRegulation: ScoreEvent[] = [
    event({ type: 'tossup-buzz', questionNumber: 1, team: 'left', playerName: 'Sarah', answerTypeIndex: 0 }),
    event({ type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 10, bouncebackPoints: 0 }),
    event({ type: 'tossup-dead', questionNumber: 2 }),
    event({ type: 'tossup-dead', questionNumber: 3 }),
    event({ type: 'tossup-dead', questionNumber: 4 }),
  ];

  test('a decided game is over, and says so with a route out', () => {
    const game = deriveGame(format, setup, fullRegulation);
    expect(game.phase).toEqual({ kind: 'complete', reason: 'regulation' });

    expect(
      canApplyScoreEvent(context, fullRegulation, event({ type: 'tossup-dead', questionNumber: 5 }), game),
    ).toMatchObject({ ok: false, escape: 'regulation-length' });
  });

  test('an authorized extra tossup lengthens regulation, and the game ends again once it is played', () => {
    const extended = fullRegulation.concat(grant('extra-tossup', { questionNumber: 4 }));
    const opened = deriveGame(format, setup, extended);

    expect(opened.phase).toMatchObject({ kind: 'tossup', questionNumber: 5, period: 'regulation' });
    expect(opened.regulationComplete).toBe(false);

    const played = extended.concat(event({ type: 'tossup-dead', questionNumber: 5 }));
    const closed = deriveGame(format, setup, played);
    expect(closed.phase).toEqual({ kind: 'complete', reason: 'regulation' });
    // The extra tossup is regulation, not overtime: nobody's overtime statistics gain a question.
    expect(closed.overtimeTossupsRead).toBe(0);
    expect(closed.questions.every((question) => question.period === 'regulation')).toBe(true);
  });

  test('is refused once overtime has been played, because it would reclassify what happened', () => {
    const tied: ScoreEvent[] = [
      event({ type: 'tossup-dead', questionNumber: 1 }),
      event({ type: 'tossup-dead', questionNumber: 2 }),
      event({ type: 'tossup-dead', questionNumber: 3 }),
      event({ type: 'tossup-dead', questionNumber: 4 }),
      event({ type: 'begin-overtime', questionNumber: 4 }),
      event({
        type: 'tossup-buzz',
        questionNumber: 5,
        team: 'left',
        playerName: 'Sarah',
        answerTypeIndex: 0,
      }),
      event({ type: 'bonus', questionNumber: 5, team: 'left', controlledPoints: 10, bouncebackPoints: 0 }),
    ];

    const verdict = canApplyScoreEvent(context, tied, grant('extra-tossup', { questionNumber: 5 }));
    expect(verdict).toMatchObject({ ok: false });
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.reason).toContain('Overtime has already begun');
  });
});

describe('the guard is not weakened by any of this', () => {
  const format = formatFor();
  const context = { format, setup, procedure: oneTimeout };

  test('a double tap still cannot score the same tossup twice, however much has been authorized', () => {
    // Every allowance this scoresheet knows how to grant, all at once. None of them is permission to
    // record an answer that could not have happened.
    const everything: ScoreEvent[] = [
      grant('extra-timeout', { team: 'left' }),
      grant('substitution', { team: 'left' }),
      grant('extra-break'),
      grant('skip-break'),
      grant('other'),
    ];
    const press = () =>
      event({
        type: 'tossup-buzz',
        questionNumber: 1,
        team: 'left',
        playerName: 'Sarah',
        answerTypeIndex: 0,
      });

    const first = applyScoreEvents(context, everything, [press()]);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');

    // The second press was built from the same on-screen state, which is what a fast double tap is.
    expect(applyScoreEvents(context, first.events, [press()])).toMatchObject({ ok: false });
    expect(deriveGame(format, setup, first.events).left.points).toBe(format.answerTypes[0].value);
  });

  test('a refusal that no setting caused offers no way round it', () => {
    const answered = applyScoreEvents(
      context,
      [],
      [
        event({
          type: 'tossup-buzz',
          questionNumber: 1,
          team: 'left',
          playerName: 'Sarah',
          answerTypeIndex: 0,
        }),
      ],
    );
    if (!answered.ok) throw new Error('unreachable');

    const verdict = canApplyScoreEvent(
      context,
      answered.events,
      event({
        type: 'tossup-buzz',
        questionNumber: 1,
        team: 'left',
        playerName: 'James',
        answerTypeIndex: 0,
      }),
    );

    expect(verdict).toMatchObject({ ok: false });
    if (verdict.ok) throw new Error('unreachable');
    // No `escape`, so the scorer renders no secondary action: there is no configuration under which
    // a team answers one tossup twice, and offering to reconsider the procedure here would be
    // offering a way around the guard rather than a way out of a mismatch.
    expect(verdict.escape).toBeUndefined();
  });

  test('a duplicate event id is still refused outright', () => {
    const duplicate = grant('other');
    expect(canApplyScoreEvent(context, [duplicate], duplicate)).toMatchObject({
      ok: false,
      reason: 'That action was already recorded.',
    });
  });
});

describe('an exception authorizes what it names and nothing else', () => {
  const format = formatFor();
  const restrictive: IRoomProcedure = {
    version: 3,
    halves: true,
    timeoutsPerTeam: 1,
    breaks: [{ afterTossup: 2 }],
    substitutionPolicy: 'breaks-timeouts-overtime',
  };
  const context = { format, setup, procedure: restrictive };
  const played: ScoreEvent[] = [
    event({ type: 'tossup-dead', questionNumber: 1 }),
    event({ type: 'timeout', questionNumber: 2, team: 'left' }),
    grant('extra-timeout', { team: 'left', questionNumber: 2 }),
  ];

  test('an extra timeout does not become a lineup change or a break', () => {
    // The grant is real: the second timeout is available.
    expect(
      canApplyScoreEvent(context, played, event({ type: 'timeout', questionNumber: 2, team: 'left' })),
    ).toEqual({ ok: true });

    // And it is only that.
    expect(
      canApplyScoreEvent(
        context,
        played,
        event({
          type: 'substitution',
          questionNumber: 2,
          team: 'left',
          activePlayers: ['Sarah', 'Avery'],
        }),
      ),
    ).toMatchObject({ ok: false, escape: 'substitution-opportunity' });
    expect(
      canApplyScoreEvent(context, played, event({ type: 'half-break', questionNumber: 2, lastQuestion: 1 })),
    ).toMatchObject({ ok: false, escape: 'break-schedule' });
  });

  test('a lineup grant does not become a timeout or a longer regulation', () => {
    const substitutionGranted = [
      event({ type: 'tossup-dead', questionNumber: 1 }),
      event({ type: 'timeout', questionNumber: 2, team: 'left' }),
      grant('substitution', { team: 'left', questionNumber: 2 }),
    ];

    expect(
      canApplyScoreEvent(
        context,
        substitutionGranted,
        event({ type: 'timeout', questionNumber: 2, team: 'left' }),
      ),
    ).toMatchObject({ ok: false, escape: 'timeout-allowance' });
    expect(deriveGame(format, setup, substitutionGranted).regulationBoundary).toBe(
      format.regulation.tossupCount,
    );
  });
});

describe('what an exception itself has to say', () => {
  const format = formatFor();
  const context = { format, setup, procedure: oneTimeout };

  test('a reason is required', () => {
    expect(
      canApplyScoreEvent(
        context,
        [],
        event({
          type: 'procedure-exception',
          questionNumber: 1,
          allowance: 'other',
          authority: 'tournament-director',
          reason: '   ',
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'Say why this was allowed.' });
  });

  test('a team-scoped allowance has to name a team', () => {
    expect(
      canApplyScoreEvent(
        context,
        [],
        event({
          type: 'procedure-exception',
          questionNumber: 1,
          allowance: 'extra-timeout',
          authority: 'tournament-director',
          reason: 'Director said so',
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'Say which team this was allowed for.' });
  });

  test('it is recorded, warned about, and carried into the exported result', () => {
    const history = [
      event({ type: 'tossup-dead', questionNumber: 1 }),
      event({ type: 'tossup-dead', questionNumber: 2 }),
      event({ type: 'tossup-dead', questionNumber: 3 }),
      grant('extra-timeout', { team: 'left', questionNumber: 4 }),
      event({ type: 'timeout', questionNumber: 4, team: 'left' }),
      event({
        type: 'tossup-buzz',
        questionNumber: 4,
        team: 'left',
        playerName: 'Sarah',
        answerTypeIndex: 0,
      }),
      event({ type: 'bonus', questionNumber: 4, team: 'left', controlledPoints: 10, bouncebackPoints: 0 }),
    ];
    const validation = validateScoresheet(format, setup, history, oneTimeout);

    expect(validation.blockers).toEqual([]);
    const warning = validation.warnings.find((problem) => problem.code === 'procedure-exception');
    expect(warning?.message).toContain('An extra timeout for Ninety Six');
    expect(warning?.message).toContain('allowed by the tournament director');

    const qbj = toQbjMatch(format, validation.game) as { notes?: string };
    expect(qbj.notes).toContain('An extra timeout for Ninety Six');
  });
});
