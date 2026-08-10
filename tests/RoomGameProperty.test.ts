import { describe, expect, test } from 'vitest';
import fc, { Command } from 'fast-check';
import AnswerType from './AnswerType';
import { EventInput } from './events';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import { applyScoreEvents, IScoreEventContext } from '../src/scoring/canApplyScoreEvent';
import deriveGame, { IGameSetup, lineupChangeEffectiveQuestion } from '../src/scoring/deriveGame';
import { IRoomProcedure } from '../src/scoring/RoomProcedure';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import validateScoresheet from '../src/scoring/validateScoresheet';
import { bouncebackOptions, regularBonusTotals } from '../src/scorer/bonusOptions';

const propertyRunCount = 300;
const maximumCommands = 50;

const setup: IGameSetup = {
  left: {
    name: 'Ninety Six',
    players: ['Sarah', 'James', 'Avery'],
    startingLineup: ['Sarah', 'James'],
  },
  right: {
    name: 'Greenwood',
    players: ['Emma', 'Jordan', 'Riley'],
    startingLineup: ['Emma', 'Jordan'],
  },
};

const procedure: IRoomProcedure = {
  version: 2,
  halves: true,
  timeoutsPerTeam: 2,
  protestCheckpoints: 'none',
  substitutionPolicy: 'any-boundary',
};

function propertyFormat(
  name: string,
  ruleSet: CommonRuleSets,
  configure: (rules: ScoringRules) => void = () => undefined,
): IScorekeeperFormat {
  const rules = new ScoringRules(ruleSet);
  rules.name = name;
  rules.timed = false;
  rules.maximumRegulationTossupCount = 5;
  rules.minimumOvertimeQuestionCount = 2;
  rules.maximumPlayersPerTeam = 2;
  configure(rules);
  return scoringRulesToScorekeeperFormat(rules);
}

const formats = [
  propertyFormat('property powers and bonuses', CommonRuleSets.AcfPowers),
  propertyFormat('property no bonuses', CommonRuleSets.Acf, (rules) => rules.setUseBonuses(false)),
  propertyFormat('property timed lightning', CommonRuleSets.NaqtTimed, (rules) => {
    rules.timed = true;
    rules.lightningCountPerTeam = 10;
  }),
  propertyFormat('property bouncebacks', CommonRuleSets.AcfPowers, (rules) => {
    rules.bonusesBounceBack = true;
    rules.minimumPartsPerBonus = 2;
    rules.maximumPartsPerBonus = 2;
    rules.maximumBonusScore = 20;
  }),
  propertyFormat('property irregular custom values', CommonRuleSets.Acf, (rules) => {
    rules.answerTypes = [new AnswerType(7), new AnswerType(-3)];
    rules.pointsPerBonusPart = undefined;
    rules.minimumPartsPerBonus = 1;
    rules.maximumPartsPerBonus = 4;
    rules.maximumBonusScore = 20;
    rules.bonusDivisor = 5;
  }),
];

interface IModel {
  eventCount: number;
  phase: ReturnType<typeof deriveGame>['phase']['kind'];
}

interface IReal {
  format: IScorekeeperFormat;
  setup: IGameSetup;
  procedure: IRoomProcedure;
  events: ScoreEvent[];
  nextId: number;
}

type ActionKind =
  | 'advance'
  | 'timeout'
  | 'substitution'
  | 'void'
  | 'half'
  | 'protest'
  | 'adjustment'
  | 'lightning'
  | 'end-regulation'
  | 'note'
  | 'undo'
  | 'clone';

interface IActionIntent {
  kind: ActionKind;
  team: 'left' | 'right';
  choice: number;
  points: number;
}

function nextEvent(real: IReal, input: EventInput): ScoreEvent {
  real.nextId += 1;
  return { ...input, id: `property-${real.nextId}` } as ScoreEvent;
}

function activePlayersFor(
  game: ReturnType<typeof deriveGame>,
  team: 'left' | 'right',
  questionNumber: number,
): string[] {
  return (
    game.questions.find((question) => question.questionNumber === questionNumber)?.activePlayers[team] ??
    game[team].activePlayers
  );
}

function advanceCandidate(real: IReal, intent: IActionIntent): ScoreEvent | undefined {
  const game = deriveGame(real.format, real.setup, real.events);
  const phase = game.phase;
  if (phase.kind === 'checkpoint') {
    return nextEvent(real, {
      type: phase.checkpoint === 'overtime' ? 'begin-overtime' : 'begin-sudden-death',
      questionNumber: Math.max(1, phase.afterQuestion),
    });
  }
  if (phase.kind === 'timeout') {
    return nextEvent(real, { type: 'timeout-resume', questionNumber: phase.questionNumber });
  }
  if (phase.kind === 'score-check') {
    return nextEvent(real, { type: 'half-resume', questionNumber: Math.max(1, phase.afterQuestion + 1) });
  }
  if (phase.kind === 'bonus') {
    const regularTotals = regularBonusTotals(real.format.bonus);
    const divisor = Math.max(1, real.format.bonus.divisor);
    const controlledOptions =
      regularTotals ??
      Array.from(
        { length: Math.floor(real.format.bonus.maximumScore / divisor) + 1 },
        (_, index) => index * divisor,
      );
    const controlledPoints = controlledOptions[intent.choice % controlledOptions.length];
    const bouncebacks = real.format.bonus.bounceBack
      ? bouncebackOptions(real.format.bonus, controlledPoints)
      : [0];
    return nextEvent(real, {
      type: 'bonus',
      questionNumber: phase.questionNumber,
      team: phase.team,
      controlledPoints,
      bouncebackPoints: bouncebacks[intent.choice % bouncebacks.length],
    });
  }
  if (phase.kind !== 'tossup') return undefined;

  if (intent.choice % 5 === 0) {
    return nextEvent(real, { type: 'tossup-dead', questionNumber: phase.questionNumber });
  }
  const team = phase.eligibleTeams.includes(intent.team) ? intent.team : phase.eligibleTeams[0];
  if (!team) return undefined;
  const players = activePlayersFor(game, team, phase.questionNumber);
  const playerName = players[intent.choice % players.length];
  if (intent.choice % 5 === 1) {
    return nextEvent(real, {
      type: 'tossup-no-penalty',
      questionNumber: phase.questionNumber,
      team,
      playerName,
    });
  }
  const answerType = real.format.answerTypes[intent.choice % real.format.answerTypes.length];
  return nextEvent(real, {
    type: 'tossup-buzz',
    questionNumber: phase.questionNumber,
    team,
    playerName,
    answerTypeIndex: answerType.index,
  });
}

function administrativeCandidate(real: IReal, intent: IActionIntent): ScoreEvent | undefined {
  const game = deriveGame(real.format, real.setup, real.events);
  const phase = game.phase;
  const questionNumber =
    phase.kind === 'tossup' || phase.kind === 'bonus' || phase.kind === 'timeout'
      ? phase.questionNumber
      : phase.kind === 'checkpoint'
        ? Math.max(1, phase.afterQuestion)
        : Math.max(1, (game.questions.at(-1)?.questionNumber ?? 0) + 1);

  switch (intent.kind) {
    case 'advance':
      return advanceCandidate(real, intent);
    case 'timeout':
      return phase.kind === 'timeout'
        ? nextEvent(real, { type: 'timeout-resume', questionNumber: phase.questionNumber })
        : nextEvent(real, {
            type: 'timeout-start',
            questionNumber,
            team: intent.team,
            startedAt: intent.choice * 1_000,
          });
    case 'substitution': {
      const roster = game[intent.team].players.map((player) => player.name);
      const count = Math.min(real.format.players.maximumActive, 1 + (intent.choice % roster.length));
      const offset = intent.choice % roster.length;
      const activePlayers = Array.from({ length: count }, (_, index) => roster[(offset + index) % roster.length]);
      return nextEvent(real, {
        type: 'substitution',
        questionNumber: lineupChangeEffectiveQuestion(game, real.events),
        team: intent.team,
        activePlayers,
      });
    }
    case 'void': {
      const question = game.questions.at(-1);
      if (!question) return undefined;
      return nextEvent(real, {
        type: 'question-void',
        questionNumber: question.questionNumber,
        scope: intent.choice % 2 === 0 && (question.bonus || question.awaitingBonus) ? 'bonus' : 'tossup',
        reason: 'Property-generated replacement',
      });
    }
    case 'half':
      return phase.kind === 'score-check'
        ? nextEvent(real, { type: 'half-resume', questionNumber })
        : nextEvent(real, {
            type: 'half-break',
            questionNumber,
            lastQuestion: game.questions.at(-1)?.questionNumber ?? 0,
          });
    case 'protest':
      return nextEvent(real, {
        type: 'protest',
        questionNumber,
        team: intent.team,
        subject: 'procedure',
        description: 'Property-generated ruling',
        status: intent.choice % 4 === 0 ? 'open' : 'declined',
      });
    case 'adjustment':
      return nextEvent(real, {
        type: 'adjustment',
        questionNumber,
        team: intent.team,
        points: intent.points === 0 ? 5 : intent.points,
        reason: 'Property-generated control ruling',
      });
    case 'lightning':
      return nextEvent(real, {
        type: 'lightning',
        questionNumber,
        team: intent.team,
        points: Math.abs(intent.points),
      });
    case 'end-regulation':
      return nextEvent(real, {
        type: 'end-regulation',
        questionNumber,
        lastRegulationQuestion: game.questions.at(-1)?.questionNumber ?? 0,
      });
    case 'note':
      return nextEvent(real, {
        type: 'note',
        questionNumber,
        text: `Property note ${intent.choice}`,
        flagged: intent.choice % 2 === 0,
      });
    case 'undo':
    case 'clone':
      return undefined;
  }
}

function assertInvariants(real: IReal): void {
  const game = deriveGame(real.format, real.setup, real.events);
  expect(new Set(real.events.map((event) => event.id)).size).toBe(real.events.length);
  expect(game.integrityProblems).toEqual([]);
  expect(game.personnelProblems).toEqual([]);
  expect(game.tossupsRead).toBe(game.questions.filter((question) => question.resolved).length);

  for (const side of ['left', 'right'] as const) {
    const team = game[side];
    const components = [
      team.tossupPoints,
      team.bonusPoints,
      team.bonusBouncebackPoints,
      team.lightningPoints,
      team.adjustmentPoints,
    ];
    expect(components.every(Number.isFinite)).toBe(true);
    expect(team.points).toBe(components.reduce((sum, points) => sum + points, 0));
    expect(new Set(team.activePlayers).size).toBe(team.activePlayers.length);
    expect(team.activePlayers.length).toBeLessThanOrEqual(real.format.players.maximumActive);
    for (const player of team.players) {
      const expectedPoints = Array.from(player.answerCounts).reduce((total, [index, count]) => {
        const answerType = real.format.answerTypes.find((candidate) => candidate.index === index);
        return total + (answerType?.value ?? 0) * count;
      }, 0);
      expect(player.points).toBe(expectedPoints);
      expect(player.tossupsHeard).toBeGreaterThanOrEqual(0);
      expect(player.tossupsHeard).toBeLessThanOrEqual(game.tossupsRead);
    }
  }

  for (const question of game.questions) {
    const teams = question.buzzes.map((buzz) => buzz.team).concat(question.noPenalty.map((attempt) => attempt.team));
    expect(new Set(teams).size).toBe(teams.length);
    const conversion = question.buzzes.find((buzz) => buzz.answerType.value > 0);
    if (question.bonus) expect(question.bonus.team).toBe(conversion?.team);
    if (question.dead) expect(conversion).toBeUndefined();
  }

  const allowedWhilePlaying = new Set([
    'game-not-complete',
    'unfinished-cycle',
    'missing-bonus',
    'missing-derived-bonus',
    'open-protest',
  ]);
  const validation = validateScoresheet(real.format, real.setup, real.events, real.procedure);
  expect(validation.blockers.filter((problem) => !allowedWhilePlaying.has(problem.code))).toEqual([]);
}

class GeneratedCommand implements Command<IModel, IReal> {
  constructor(private readonly intent: IActionIntent) {}

  check(model: Readonly<IModel>): boolean {
    return this.intent.kind !== 'undo' || model.eventCount > 0;
  }

  run(model: IModel, real: IReal): void {
    if (this.intent.kind === 'undo') {
      real.events = real.events.slice(0, -1);
    } else if (this.intent.kind === 'clone') {
      const before = deriveGame(real.format, real.setup, real.events);
      real.events = JSON.parse(JSON.stringify(real.events)) as ScoreEvent[];
      expect(deriveGame(real.format, real.setup, real.events)).toEqual(before);
    } else {
      const before = deriveGame(real.format, real.setup, real.events);
      const candidate = administrativeCandidate(real, this.intent);
      if (candidate) {
        const context: IScoreEventContext = {
          format: real.format,
          setup: real.setup,
          procedure: real.procedure,
        };
        const result = applyScoreEvents(context, real.events, [candidate]);
        if (result.ok) {
          real.events = result.events;
          expect(deriveGame(real.format, real.setup, real.events.slice(0, -1))).toEqual(before);
        }
      }
    }

    assertInvariants(real);
    const game = deriveGame(real.format, real.setup, real.events);
    model.eventCount = real.events.length;
    model.phase = game.phase.kind;
  }

  toString(): string {
    const side = this.intent.team === 'left' ? 'L' : 'R';
    return `${this.intent.kind}(${side}, choice=${this.intent.choice}, points=${this.intent.points})`;
  }
}

const commandArbitrary = fc
  .record({
    kind: fc.constantFrom<ActionKind>(
      'advance',
      'advance',
      'advance',
      'timeout',
      'substitution',
      'void',
      'half',
      'protest',
      'adjustment',
      'lightning',
      'end-regulation',
      'note',
      'undo',
      'clone',
    ),
    team: fc.constantFrom<'left' | 'right'>('left', 'right'),
    choice: fc.nat({ max: 20 }),
    points: fc.integer({ min: -30, max: 30 }),
  })
  .map((intent) => new GeneratedCommand(intent));

describe('fast-check scoring state machine', () => {
  test(
    'shrinks mixed scoring, procedure, correction, and undo sequences while preserving invariants',
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: formats.length - 1 }),
          fc.commands<IModel, IReal>([commandArbitrary], { maxCommands: maximumCommands, size: 'large' }),
          (formatIndex, commands) => {
            const format = formats[formatIndex];
            fc.modelRun(
              () => ({
                model: { eventCount: 0, phase: 'tossup' } as IModel,
                real: { format, setup, procedure, events: [], nextId: 0 },
              }),
              commands,
            );
          },
        ),
        { numRuns: propertyRunCount, verbose: true },
      );
    },
    20_000,
  );
});
