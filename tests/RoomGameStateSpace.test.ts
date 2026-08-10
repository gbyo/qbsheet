import { describe, expect, test } from 'vitest';
import AnswerType from './AnswerType';
import { EventInput } from './events';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import canApplyScoreEvent, { applyScoreEvents, IScoreEventContext } from '../src/scoring/canApplyScoreEvent';
import deriveGame, { IGameSetup, ScoringPhase } from '../src/scoring/deriveGame';
import {
  bonusEventPoints,
  IBonusPartResult,
  otherTeam,
  ScoreEvent,
} from '../src/scoring/ScoreEvents';
import {
  editableQuestionFromEvents,
  eventsFromEditableQuestion,
  validateEditableQuestion,
} from '../src/scoring/questionCorrection';
import validateScoresheet, { validateCorrectedHistory } from '../src/scoring/validateScoresheet';
import { bouncebackOptions, regularBonusTotals } from '../src/scorer/bonusOptions';
import toQbjMatch from '../src/scoring/toQbjMatch';

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah', 'James'] },
  right: { name: 'Greenwood', players: ['Emma', 'Jordan'] },
};

let eventId = 0;

function nextEvent(partial: EventInput): ScoreEvent {
  eventId += 1;
  return { ...partial, id: `state-space-${eventId}` } as ScoreEvent;
}

function compactFormat(
  name: string,
  ruleSet: CommonRuleSets,
  configure: (rules: ScoringRules) => void = () => undefined,
): IScorekeeperFormat {
  const rules = new ScoringRules(ruleSet);
  rules.name = name;
  rules.timed = false;
  rules.maximumRegulationTossupCount = 2;
  rules.minimumOvertimeQuestionCount = 1;
  rules.maximumPlayersPerTeam = 2;
  configure(rules);
  return scoringRulesToScorekeeperFormat(rules);
}

function totalBonusEvents(format: IScorekeeperFormat, questionNumber: number, team: 'left' | 'right'): ScoreEvent[] {
  const regular = regularBonusTotals(format.bonus);
  const step = Math.max(1, format.bonus.divisor);
  const controlledOptions = regular ?? Array.from({ length: Math.floor(format.bonus.maximumScore / step) + 1 }, (_, i) => i * step);
  const candidates: ScoreEvent[] = [];
  for (const controlledPoints of controlledOptions) {
    const bouncebacks = format.bonus.bounceBack
      ? bouncebackOptions(format.bonus, controlledPoints)
      : [0];
    for (const bouncebackPoints of bouncebacks) {
      candidates.push(
        nextEvent({ type: 'bonus', questionNumber, team, controlledPoints, bouncebackPoints }),
      );
    }
  }
  return candidates;
}

function partOutcomes(format: IScorekeeperFormat): IBonusPartResult[][] {
  if (!format.bonus.regular || format.bonus.pointsPerPart === undefined) return [];
  if (format.bonus.minimumParts !== format.bonus.maximumParts) return [];
  const count = format.bonus.minimumParts;
  const points = format.bonus.pointsPerPart;
  const choices: IBonusPartResult[] = format.bonus.bounceBack
    ? [
        { controlledPoints: 0, bouncebackPoints: 0 },
        { controlledPoints: points, bouncebackPoints: 0 },
        { controlledPoints: 0, bouncebackPoints: points },
      ]
    : [
        { controlledPoints: 0, bouncebackPoints: 0 },
        { controlledPoints: points, bouncebackPoints: 0 },
      ];
  let combinations: IBonusPartResult[][] = [[]];
  for (let index = 0; index < count; index += 1) {
    combinations = combinations.flatMap((parts) => choices.map((choice) => parts.concat({ ...choice })));
  }
  return combinations;
}

function bonusEvents(format: IScorekeeperFormat, questionNumber: number, team: 'left' | 'right'): ScoreEvent[] {
  return totalBonusEvents(format, questionNumber, team).concat(
    partOutcomes(format).map((parts) => nextEvent({ type: 'bonus', questionNumber, team, parts })),
  );
}

function scoringCandidates(format: IScorekeeperFormat, events: ScoreEvent[]): ScoreEvent[] {
  const game = deriveGame(format, setup, events);
  const { phase } = game;
  if (phase.kind === 'bonus') {
    const candidates = bonusEvents(format, phase.questionNumber, phase.team);
    // Always probe the impossible owner as well; it must be rejected rather than corrupting a game.
    candidates.push(
      nextEvent({
        type: 'bonus',
        questionNumber: phase.questionNumber,
        team: otherTeam(phase.team),
        controlledPoints: 0,
        bouncebackPoints: 0,
      }),
    );
    return candidates;
  }
  if (phase.kind !== 'tossup') return [];

  const candidates: ScoreEvent[] = [nextEvent({ type: 'tossup-dead', questionNumber: phase.questionNumber })];
  for (const team of phase.eligibleTeams) {
    for (const playerName of game[team].activePlayers) {
      for (const answerType of format.answerTypes) {
        candidates.push(
          nextEvent({
            type: 'tossup-buzz',
            questionNumber: phase.questionNumber,
            team,
            playerName,
            answerTypeIndex: answerType.index,
          }),
        );
      }
      candidates.push(
        nextEvent({ type: 'tossup-no-penalty', questionNumber: phase.questionNumber, team, playerName }),
      );
    }
    candidates.push(nextEvent({ type: 'tossup-no-penalty', questionNumber: phase.questionNumber, team }));
  }
  return candidates;
}

function expectedPoints(format: IScorekeeperFormat, events: ScoreEvent[]): { left: number; right: number } {
  const points = { left: 0, right: 0 };
  for (const entry of events) {
    if (entry.type === 'tossup-buzz') {
      points[entry.team] += format.answerTypes[entry.answerTypeIndex]?.value ?? 0;
    } else if (entry.type === 'bonus') {
      const [controlled, bounceback] = bonusEventPoints(entry);
      points[entry.team] += controlled;
      points[otherTeam(entry.team)] += bounceback;
    } else if (entry.type === 'adjustment') points[entry.team] += entry.points;
  }
  return points;
}

interface ICycleEnumeration {
  histories: ScoreEvent[][];
  rejected: number;
}

function enumerateFirstQuestion(format: IScorekeeperFormat): ICycleEnumeration {
  const context = { format, setup };
  const histories: ScoreEvent[][] = [];
  let rejected = 0;

  const visit = (events: ScoreEvent[]) => {
    const phase = deriveGame(format, setup, events).phase;
    if (phase.kind !== 'bonus' && (phase.kind !== 'tossup' || phase.questionNumber > 1)) {
      histories.push(events);
      return;
    }
    if (events.length > 4) throw new Error('A single tossup cycle exceeded its event bound.');

    let accepted = 0;
    for (const candidate of scoringCandidates(format, events)) {
      const result = applyScoreEvents(context, events, [candidate]);
      if (!result.ok) {
        rejected += 1;
        continue;
      }
      accepted += 1;
      visit(result.events);
    }
    if (accepted === 0) throw new Error(`No legal action from ${JSON.stringify(phase)}.`);
  };

  visit([]);
  return { histories, rejected };
}

function questionSnapshot(format: IScorekeeperFormat, events: ScoreEvent[]) {
  const game = deriveGame(format, setup, events);
  const question = game.questions.find((candidate) => candidate.questionNumber === 1);
  return {
    left: game.left.points,
    right: game.right.points,
    phase: game.phase.kind,
    question: question && {
      buzzes: question.buzzes.map((buzz) => [buzz.team, buzz.playerName, buzz.answerType.index]),
      noPenalty: question.noPenalty.map((attempt) => [attempt.team, attempt.playerName]),
      dead: question.dead,
      bonus: question.bonus && [
        question.bonus.team,
        question.bonus.controlledPoints,
        question.bonus.bouncebackPoints,
      ],
      resolved: question.resolved,
    },
  };
}

function normalizedTossupCandidates(format: IScorekeeperFormat, game: ReturnType<typeof deriveGame>): ScoreEvent[] {
  if (game.phase.kind !== 'tossup') return [];
  const positive = format.answerTypes.find((answerType) => answerType.value > 0);
  const negative = format.answerTypes.find((answerType) => answerType.isNeg);
  const candidates: ScoreEvent[] = [
    nextEvent({ type: 'tossup-dead', questionNumber: game.phase.questionNumber }),
  ];
  for (const team of game.phase.eligibleTeams) {
    const playerName = game[team].activePlayers[0];
    if (positive) {
      candidates.push(
        nextEvent({
          type: 'tossup-buzz',
          questionNumber: game.phase.questionNumber,
          team,
          playerName,
          answerTypeIndex: positive.index,
        }),
      );
    }
    if (negative) {
      candidates.push(
        nextEvent({
          type: 'tossup-buzz',
          questionNumber: game.phase.questionNumber,
          team,
          playerName,
          answerTypeIndex: negative.index,
        }),
      );
    }
    candidates.push(
      nextEvent({
        type: 'tossup-no-penalty',
        questionNumber: game.phase.questionNumber,
        team,
        playerName,
      }),
    );
  }
  return candidates;
}

describe('bounded exhaustive scoring state space', () => {
  const formats = [
    compactFormat('powers and regular bonuses', CommonRuleSets.AcfPowers),
    compactFormat('no bonuses', CommonRuleSets.Acf, (rules) => rules.setUseBonuses(false)),
    compactFormat('regular bouncebacks', CommonRuleSets.AcfPowers, (rules) => {
      rules.bonusesBounceBack = true;
      rules.minimumPartsPerBonus = 2;
      rules.maximumPartsPerBonus = 2;
      rules.maximumBonusScore = 20;
    }),
    compactFormat('irregular bonuses and custom values', CommonRuleSets.Acf, (rules) => {
      rules.answerTypes = [new AnswerType(7), new AnswerType(-3)];
      rules.pointsPerBonusPart = undefined;
      rules.minimumPartsPerBonus = 1;
      rules.maximumPartsPerBonus = 4;
      rules.maximumBonusScore = 20;
      rules.bonusDivisor = 5;
    }),
  ];

  test.each(formats)('enumerates every legal first-question outcome for $name', (format) => {
    const { histories, rejected } = enumerateFirstQuestion(format);
    expect(histories.length).toBeGreaterThan(20);
    expect(rejected).toBeGreaterThan(0);

    for (const history of histories) {
      const game = deriveGame(format, setup, history);
      const oracle = expectedPoints(format, history);
      expect({ left: game.left.points, right: game.right.points }).toEqual(oracle);
      expect(game.tossupsRead).toBe(1);
      expect(game.integrityProblems).toEqual([]);
      expect(game.personnelProblems).toEqual([]);
      expect(game.questions[0]?.resolved).toBe(true);
      expect(game.left.players.every((player) => player.tossupsHeard === 1)).toBe(true);
      expect(game.right.players.every((player) => player.tossupsHeard === 1)).toBe(true);

      const validation = validateCorrectedHistory(format, setup, history);
      expect(validation.blockers).toEqual([]);

      const editable = editableQuestionFromEvents(history, 1);
      expect(validateEditableQuestion(format, game, editable)).toEqual([]);
      let replacementId = 0;
      const replacement = eventsFromEditableQuestion(editable, () => `round-trip-${++replacementId}`);
      expect(questionSnapshot(format, replacement)).toEqual(questionSnapshot(format, history));

      const exported = toQbjMatch(format, game) as { match_teams?: { points?: number }[] };
      expect(exported.match_teams?.map((team) => team.points)).toEqual([oracle.left, oracle.right]);
    }
  });

  test('composes every normalized regulation, overtime, and sudden-death path', () => {
    const format = compactFormat('transition matrix', CommonRuleSets.Acf, (rules) => {
      rules.setUseBonuses(false);
      rules.minimumOvertimeQuestionCount = 2;
    });
    const context = { format, setup };
    const phases = new Set<string>();
    let completed = 0;
    let boundedTies = 0;
    let visited = 0;

    const phaseKey = (phase: ScoringPhase) =>
      phase.kind === 'checkpoint' ? `${phase.kind}:${phase.checkpoint}` : phase.kind === 'complete' ? `${phase.kind}:${phase.reason}` : phase.kind;

    const visit = (events: ScoreEvent[]) => {
      visited += 1;
      const game = deriveGame(format, setup, events);
      phases.add(phaseKey(game.phase));
      expect(game.integrityProblems).toEqual([]);
      expect(game.personnelProblems).toEqual([]);
      expect({ left: game.left.points, right: game.right.points }).toEqual(expectedPoints(format, events));

      if (game.phase.kind === 'complete') {
        completed += 1;
        expect(validateScoresheet(format, setup, events).blockers).toEqual([]);
        return;
      }
      if (game.phase.kind === 'tossup' && game.phase.questionNumber > 5) {
        boundedTies += 1;
        return;
      }

      let candidates: ScoreEvent[] = [];
      if (game.phase.kind === 'checkpoint') {
        candidates = [
          nextEvent({
            type: game.phase.checkpoint === 'overtime' ? 'begin-overtime' : 'begin-sudden-death',
            questionNumber: Math.max(1, game.phase.afterQuestion),
          }),
        ];
      } else if (game.phase.kind === 'tossup') {
        candidates = normalizedTossupCandidates(format, game);
      }

      let accepted = 0;
      for (const candidate of candidates) {
        const result = applyScoreEvents(context, events, [candidate]);
        if (!result.ok) continue;
        accepted += 1;
        visit(result.events);
      }
      if (accepted === 0) throw new Error(`Transition matrix got stuck at ${JSON.stringify(game.phase)}.`);
    };

    visit([]);
    expect(visited).toBeGreaterThan(1_000);
    expect(completed).toBeGreaterThan(0);
    expect(boundedTies).toBeGreaterThan(0);
    expect(phases).toEqual(
      new Set([
        'tossup',
        'checkpoint:overtime',
        'checkpoint:sudden-death',
        'complete:regulation',
        'complete:overtime',
      ]),
    );
  });

  test('composes every normalized timed-regulation stopping point and its overtime paths', () => {
    const untimed = compactFormat('timed transition matrix', CommonRuleSets.Acf, (rules) => {
      rules.setUseBonuses(false);
      rules.minimumOvertimeQuestionCount = 1;
    });
    const format: IScorekeeperFormat = {
      ...untimed,
      regulation: { ...untimed.regulation, timed: true },
    };
    const context = { format, setup };
    const phases = new Set<string>();
    const regulationLengths = new Set<number>();
    let completed = 0;
    let boundedTies = 0;

    const visit = (events: ScoreEvent[]) => {
      const game = deriveGame(format, setup, events);
      const phase = game.phase;
      phases.add(
        phase.kind === 'checkpoint'
          ? `${phase.kind}:${phase.checkpoint}`
          : phase.kind === 'complete'
            ? `${phase.kind}:${phase.reason}`
            : phase.kind,
      );
      expect(game.integrityProblems).toEqual([]);
      expect(game.personnelProblems).toEqual([]);
      expect({ left: game.left.points, right: game.right.points }).toEqual(expectedPoints(format, events));

      if (phase.kind === 'complete') {
        completed += 1;
        regulationLengths.add(game.questions.filter((question) => question.period === 'regulation').length);
        expect(validateScoresheet(format, setup, events).blockers).toEqual([]);
        return;
      }
      if (phase.kind === 'tossup' && phase.period === 'overtime' && phase.questionNumber > 4) {
        boundedTies += 1;
        return;
      }

      let candidates: ScoreEvent[] = [];
      if (phase.kind === 'checkpoint') {
        candidates = [
          nextEvent({
            type: phase.checkpoint === 'overtime' ? 'begin-overtime' : 'begin-sudden-death',
            questionNumber: Math.max(1, phase.afterQuestion),
          }),
        ];
      } else if (phase.kind === 'tossup') {
        if (phase.period === 'regulation') {
          const lastRegulationQuestion = game.questions.at(-1)?.questionNumber ?? 0;
          candidates.push(
            nextEvent({
              type: 'end-regulation',
              questionNumber: phase.questionNumber,
              lastRegulationQuestion,
            }),
          );
          if (phase.questionNumber <= 2) candidates.push(...normalizedTossupCandidates(format, game));
        } else candidates = normalizedTossupCandidates(format, game);
      }

      let accepted = 0;
      for (const candidate of candidates) {
        const result = applyScoreEvents(context, events, [candidate]);
        if (!result.ok) continue;
        accepted += 1;
        visit(result.events);
      }
      if (accepted === 0) throw new Error(`Timed transition matrix got stuck at ${JSON.stringify(phase)}.`);
    };

    visit([]);
    expect(completed).toBeGreaterThan(0);
    expect(boundedTies).toBeGreaterThan(0);
    expect(regulationLengths).toEqual(new Set([0, 1, 2]));
    expect(phases).toEqual(
      new Set([
        'tossup',
        'checkpoint:overtime',
        'checkpoint:sudden-death',
        'complete:regulation',
        'complete:overtime',
      ]),
    );
  });
});

describe('every score event variant', () => {
  test('has at least one legal transition through the same guard used by the scorer', () => {
    const ordinary = compactFormat('event transitions', CommonRuleSets.AcfPowers);
    const noBonus = compactFormat('checkpoint transitions', CommonRuleSets.Acf, (rules) => {
      rules.setUseBonuses(false);
    });
    const oneQuestion = {
      ...noBonus,
      regulation: { ...noBonus.regulation, tossupCount: 1, maximumTossupCount: 1 },
      overtime: { ...noBonus.overtime, minimumQuestionCount: 1, suddenDeath: true },
    };
    const timed = {
      ...noBonus,
      regulation: { ...noBonus.regulation, timed: true },
    };
    const withLightning = {
      ...ordinary,
      lightning: { enabled: true, countPerTeam: 10, divisor: 10 },
    };
    const procedure = { version: 2, halves: true, timeoutsPerTeam: 1 };
    const ordinaryContext: IScoreEventContext = { format: ordinary, setup };
    const procedureContext: IScoreEventContext = { format: ordinary, setup, procedure };
    const correct = nextEvent({
      type: 'tossup-buzz',
      questionNumber: 1,
      team: 'left',
      playerName: 'Sarah',
      answerTypeIndex: ordinary.answerTypes.find((answerType) => answerType.value > 0)?.index ?? 0,
    });
    const firstDead = nextEvent({ type: 'tossup-dead', questionNumber: 1 });
    const beginOvertime = nextEvent({ type: 'begin-overtime', questionNumber: 1 });
    const overtimeDead = nextEvent({ type: 'tossup-dead', questionNumber: 2 });
    const timeoutStart = nextEvent({ type: 'timeout-start', questionNumber: 1, team: 'left', startedAt: 1 });
    const breakEvent = nextEvent({ type: 'half-break', questionNumber: 2, lastQuestion: 1 });

    interface ITransitionScenario {
      context: IScoreEventContext;
      before: ScoreEvent[];
      candidate: ScoreEvent;
    }

    const transitions: Record<ScoreEvent['type'], ITransitionScenario> = {
      'tossup-buzz': {
        context: ordinaryContext,
        before: [],
        candidate: nextEvent({
          type: 'tossup-buzz',
          questionNumber: 1,
          team: 'left',
          playerName: 'Sarah',
          answerTypeIndex: 0,
        }),
      },
      'tossup-no-penalty': {
        context: ordinaryContext,
        before: [],
        candidate: nextEvent({
          type: 'tossup-no-penalty',
          questionNumber: 1,
          team: 'left',
          playerName: 'Sarah',
        }),
      },
      'tossup-dead': {
        context: ordinaryContext,
        before: [],
        candidate: nextEvent({ type: 'tossup-dead', questionNumber: 1 }),
      },
      bonus: {
        context: ordinaryContext,
        before: [correct],
        candidate: nextEvent({ type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 20 }),
      },
      lightning: {
        context: { format: withLightning, setup },
        before: [],
        candidate: nextEvent({ type: 'lightning', questionNumber: 1, team: 'left', points: 20 }),
      },
      substitution: {
        context: ordinaryContext,
        before: [],
        candidate: nextEvent({ type: 'substitution', questionNumber: 1, team: 'left', activePlayers: ['Sarah'] }),
      },
      'roster-add': {
        context: ordinaryContext,
        before: [],
        candidate: nextEvent({ type: 'roster-add', questionNumber: 1, team: 'left', playerName: 'Taylor' }),
      },
      'end-regulation': {
        context: { format: timed, setup },
        before: [],
        candidate: nextEvent({ type: 'end-regulation', questionNumber: 1, lastRegulationQuestion: 0 }),
      },
      'half-break': {
        context: procedureContext,
        before: [firstDead],
        candidate: breakEvent,
      },
      'half-resume': {
        context: procedureContext,
        before: [firstDead, breakEvent],
        candidate: nextEvent({ type: 'half-resume', questionNumber: 2 }),
      },
      'begin-overtime': {
        context: { format: oneQuestion, setup },
        before: [firstDead],
        candidate: beginOvertime,
      },
      'begin-sudden-death': {
        context: { format: oneQuestion, setup },
        before: [firstDead, beginOvertime, overtimeDead],
        candidate: nextEvent({ type: 'begin-sudden-death', questionNumber: 2 }),
      },
      timeout: {
        context: procedureContext,
        before: [],
        candidate: nextEvent({ type: 'timeout', questionNumber: 1, team: 'left' }),
      },
      'timeout-start': {
        context: procedureContext,
        before: [],
        candidate: timeoutStart,
      },
      'timeout-resume': {
        context: procedureContext,
        before: [timeoutStart],
        candidate: nextEvent({ type: 'timeout-resume', questionNumber: 1 }),
      },
      protest: {
        context: ordinaryContext,
        before: [],
        candidate: nextEvent({
          type: 'protest',
          questionNumber: 1,
          team: 'left',
          subject: 'question',
          description: 'Ruling under review',
          status: 'open',
        }),
      },
      'question-void': {
        context: ordinaryContext,
        before: [firstDead],
        candidate: nextEvent({ type: 'question-void', questionNumber: 1, scope: 'tossup', reason: 'Wrong packet' }),
      },
      'end-game-early': {
        context: ordinaryContext,
        before: [],
        candidate: nextEvent({
          type: 'end-game-early',
          questionNumber: 1,
          reason: 'Director stopped play',
          tossupsRead: 0,
        }),
      },
      adjustment: {
        context: ordinaryContext,
        before: [],
        candidate: nextEvent({ type: 'adjustment', questionNumber: 1, team: 'left', points: 5 }),
      },
      forfeit: {
        context: ordinaryContext,
        before: [],
        candidate: nextEvent({ type: 'forfeit', questionNumber: 1, teams: ['right'] }),
      },
      note: {
        context: ordinaryContext,
        before: [],
        candidate: nextEvent({ type: 'note', questionNumber: 1, text: 'Room note', flagged: true }),
      },
    };

    for (const [type, scenario] of Object.entries(transitions)) {
      const result = applyScoreEvents(scenario.context, scenario.before, [scenario.candidate]);
      expect(result, `${type} should have a legal transition`).toMatchObject({ ok: true });
      if (!result.ok) continue;
      expect(() => deriveGame(scenario.context.format, scenario.context.setup, result.events)).not.toThrow();
      expect(scenario.candidate.type).toBe(type);
    }
  });

  test('is handled without throwing by the guard, derivation, and validation layers', () => {
    const format = compactFormat('all events', CommonRuleSets.NaqtTimed, (rules) => {
      rules.lightningCountPerTeam = 10;
    });
    const samples: Record<ScoreEvent['type'], EventInput> = {
      'tossup-buzz': { type: 'tossup-buzz', questionNumber: 1, team: 'left', playerName: 'Sarah', answerTypeIndex: 0 },
      'tossup-no-penalty': { type: 'tossup-no-penalty', questionNumber: 1, team: 'left', playerName: 'Sarah' },
      'tossup-dead': { type: 'tossup-dead', questionNumber: 1 },
      bonus: { type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 10 },
      lightning: { type: 'lightning', questionNumber: 1, team: 'left', points: 20 },
      substitution: { type: 'substitution', questionNumber: 1, team: 'left', activePlayers: ['Sarah'] },
      'roster-add': { type: 'roster-add', questionNumber: 1, team: 'left', playerName: 'Taylor' },
      'end-regulation': { type: 'end-regulation', questionNumber: 1, lastRegulationQuestion: 0 },
      'half-break': { type: 'half-break', questionNumber: 1, lastQuestion: 0 },
      'half-resume': { type: 'half-resume', questionNumber: 1 },
      'begin-overtime': { type: 'begin-overtime', questionNumber: 1 },
      'begin-sudden-death': { type: 'begin-sudden-death', questionNumber: 1 },
      timeout: { type: 'timeout', questionNumber: 1, team: 'left' },
      'timeout-start': { type: 'timeout-start', questionNumber: 1, team: 'left', startedAt: 1 },
      'timeout-resume': { type: 'timeout-resume', questionNumber: 1 },
      protest: {
        type: 'protest',
        questionNumber: 1,
        team: 'left',
        subject: 'question',
        description: 'Ruling under review',
        status: 'open',
      },
      'question-void': { type: 'question-void', questionNumber: 1, scope: 'tossup', reason: 'Wrong packet' },
      'end-game-early': { type: 'end-game-early', questionNumber: 1, reason: 'Director stopped play', tossupsRead: 0 },
      adjustment: { type: 'adjustment', questionNumber: 1, team: 'left', points: 5, reason: 'Control ruling' },
      forfeit: { type: 'forfeit', questionNumber: 1, teams: ['right'] },
      note: { type: 'note', questionNumber: 1, text: 'Room note', flagged: true },
    };
    const context = {
      format,
      setup,
      procedure: { version: 2, halves: true, timeoutsPerTeam: 1 },
    };

    for (const [type, partial] of Object.entries(samples)) {
      const candidate = nextEvent(partial);
      expect(() => canApplyScoreEvent(context, [], candidate)).not.toThrow();
      expect(() => deriveGame(format, setup, [candidate])).not.toThrow();
      expect(() => validateScoresheet(format, setup, [candidate])).not.toThrow();
      expect(candidate.type).toBe(type);
    }
  });
});
