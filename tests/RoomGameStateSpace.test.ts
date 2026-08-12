import { describe, expect, test } from 'vitest';
import AnswerType from './AnswerType';
import { EventInput } from './events';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import canApplyScoreEvent, { applyScoreEvents, IScoreEventContext } from '../src/scoring/canApplyScoreEvent';
import deriveGame, {
  IGameSetup,
  lineupChangeEffectiveQuestion,
  ScoringPhase,
} from '../src/scoring/deriveGame';
import { IRoomProcedure } from '../src/scoring/RoomProcedure';
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
import { loadGame, saveGame } from '../src/scorer/GameSession';
import toQbjMatch from '../src/scoring/toQbjMatch';

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah', 'James'] },
  right: { name: 'Greenwood', players: ['Emma', 'Jordan'] },
};

// These two bounded traversals are intentionally CPU-heavy. They normally finish in a few seconds,
// but need headroom when Vitest runs every test file concurrently on a shared CI runner.
const exhaustiveTraversalTimeoutMs = 15_000;

const deepStressEnabled = process.env.QBSHEET_DEEP_STRESS === '1';

/** Keep the Vitest worker heartbeat alive during the intentionally long deep traversal. */
function yieldToTestRunner(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function positiveEnvironmentInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const generatedSeedCount = deepStressEnabled
  ? Math.max(64, positiveEnvironmentInteger('QBSHEET_STRESS_SEEDS', 5_000))
  : 64;
const generatedActionLimit = deepStressEnabled
  ? Math.max(24, positiveEnvironmentInteger('QBSHEET_STRESS_ACTIONS', 120))
  : 24;
const generatedStateMachineTimeoutMs = deepStressEnabled ? 40 * 60_000 : 5_000;

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

function withRegulationLength(format: IScorekeeperFormat, tossupCount: number): IScorekeeperFormat {
  return {
    ...format,
    regulation: {
      ...format.regulation,
      tossupCount,
      maximumTossupCount: tossupCount,
    },
  };
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

function scoringCandidates(
  format: IScorekeeperFormat,
  events: ScoreEvent[],
  gameSetup: IGameSetup = setup,
): ScoreEvent[] {
  const game = deriveGame(format, gameSetup, events);
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
    else if (entry.type === 'lightning' || entry.type === 'question-void') {
      throw new Error(`expectedPoints does not model ${entry.type}; extend the oracle before generating it.`);
    }
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

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function pick<T>(values: T[], random: () => number): T {
  return values[Math.floor(random() * values.length)];
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function sortedEntries(values: Map<number, number>): [number, number][] {
  return Array.from(values.entries()).sort(([left], [right]) => left - right);
}

function gameSemantics(game: ReturnType<typeof deriveGame>) {
  const team = (side: 'left' | 'right') => ({
    name: game[side].name,
    points: game[side].points,
    tossupPoints: game[side].tossupPoints,
    bonusPoints: game[side].bonusPoints,
    bonusBouncebackPoints: game[side].bonusBouncebackPoints,
    lightningPoints: game[side].lightningPoints,
    adjustmentPoints: game[side].adjustmentPoints,
    bonusesHeard: game[side].bonusesHeard,
    activePlayers: game[side].activePlayers,
    forfeited: game[side].forfeited,
    overtimeBuzzes: sortedEntries(game[side].overtimeBuzzes),
    players: game[side].players.map((player) => ({
      name: player.name,
      tossupsHeard: player.tossupsHeard,
      points: player.points,
      answerCounts: sortedEntries(player.answerCounts),
    })),
  });
  return {
    left: team('left'),
    right: team('right'),
    phase: game.phase,
    tossupsRead: game.tossupsRead,
    overtimeTossupsRead: game.overtimeTossupsRead,
    regulationComplete: game.regulationComplete,
    regulationBoundary: game.regulationBoundary,
    overtimeStarted: game.overtimeStarted,
    suddenDeathStarted: game.suddenDeathStarted,
    timeouts: game.timeouts,
    activeTimeout: game.activeTimeout,
    halfBreaks: game.halfBreaks,
    awaitingScoreCheck: game.awaitingScoreCheck,
    endedEarly: game.endedEarly,
    needsStartingLineup: game.needsStartingLineup,
    notes: game.notes,
    protests: game.protests.map(({ eventId: _eventId, ...protest }) => protest),
    voids: game.voids.map(({ eventId: _eventId, ...voided }) => voided),
    questions: game.questions.map((question) => ({
      questionNumber: question.questionNumber,
      period: question.period,
      buzzes: question.buzzes.map((buzz) => ({
        team: buzz.team,
        playerName: buzz.playerName,
        answerTypeIndex: buzz.answerType.index,
      })),
      noPenalty: question.noPenalty,
      dead: question.dead,
      bonus: question.bonus,
      resolved: question.resolved,
      awaitingBonus: question.awaitingBonus,
      activePlayers: question.activePlayers,
      scoreAfter: question.scoreAfter,
      openProtests: question.openProtests,
      replaced: question.replaced,
    })),
  };
}

function gameSemanticsWithoutNotes(game: ReturnType<typeof deriveGame>) {
  return { ...gameSemantics(game), notes: undefined };
}

function describeEvent(format: IScorekeeperFormat, event: ScoreEvent): string {
  const side = 'team' in event ? ` ${event.team === 'left' ? 'L' : 'R'}` : '';
  switch (event.type) {
    case 'tossup-buzz':
      return `Q${event.questionNumber} buzz${side} ${format.answerTypes[event.answerTypeIndex]?.value ?? '?'} ${event.playerName}`;
    case 'tossup-no-penalty':
      return `Q${event.questionNumber} no-penalty${side}${event.playerName ? ` ${event.playerName}` : ''}`;
    case 'tossup-dead':
      return `Q${event.questionNumber} no-buzz`;
    case 'bonus': {
      const [controlled, bounceback] = bonusEventPoints(event);
      return `Q${event.questionNumber} bonus${side} ${controlled}${bounceback ? ` / bounceback ${bounceback}` : ''}`;
    }
    case 'substitution':
      return `Q${event.questionNumber} substitution${side} [${event.activePlayers.join(', ')}]`;
    case 'timeout-start':
      return `Q${event.questionNumber} timeout-start${side}`;
    case 'protest':
      return `Q${event.questionNumber} protest${side} ${event.status}`;
    case 'question-void':
      return `Q${event.questionNumber} void-${event.scope}`;
    case 'adjustment':
      return `Q${event.questionNumber} adjustment${side} ${event.points > 0 ? '+' : ''}${event.points}`;
    default:
      return `Q${event.questionNumber} ${event.type}${side}`;
  }
}

function describeHistory(format: IScorekeeperFormat, events: ScoreEvent[]): string {
  return events.map((event, index) => `${index + 1}. ${describeEvent(format, event)}`).join('\n');
}

function withReplayDiagnostics(
  seed: number,
  step: number,
  format: IScorekeeperFormat,
  events: ScoreEvent[],
  verify: () => void,
): void {
  try {
    verify();
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(
      `Seeded state-machine failure\nseed=${seed}\nstep=${step}\nformat=${format.name}\n\n${describeHistory(format, events)}\n\n${detail}`,
    );
  }
}

function legalHistoryInvariants(
  format: IScorekeeperFormat,
  gameSetup: IGameSetup,
  events: ScoreEvent[],
  procedure: IRoomProcedure,
): void {
  const game = deriveGame(format, gameSetup, events);
  expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  expect(game.integrityProblems).toEqual([]);
  expect(game.personnelProblems).toEqual([]);
  expect(game.tossupsRead).toBe(game.questions.filter((question) => question.resolved).length);
  expect(game.overtimeTossupsRead).toBe(
    game.questions.filter((question) => question.resolved && question.period === 'overtime').length,
  );
  expect(new Set(game.questions.map((question) => question.questionNumber)).size).toBe(game.questions.length);

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
    expect(Number.isFinite(team.points)).toBe(true);
    expect(new Set(team.activePlayers).size).toBe(team.activePlayers.length);
    expect(team.activePlayers.length).toBeLessThanOrEqual(format.players.maximumActive);
    expect(team.activePlayers.every((name) => team.players.some((player) => player.name === name))).toBe(true);

    for (const player of team.players) {
      const calculatedPoints = Array.from(player.answerCounts.entries()).reduce((sum, [index, count]) => {
        const answerType = format.answerTypes.find((candidate) => candidate.index === index);
        expect(answerType).toBeDefined();
        expect(Number.isInteger(count) && count >= 0).toBe(true);
        return sum + (answerType?.value ?? 0) * count;
      }, 0);
      expect(player.points).toBe(calculatedPoints);
      expect(Number.isInteger(player.tossupsHeard)).toBe(true);
      expect(player.tossupsHeard).toBeGreaterThanOrEqual(0);
      expect(player.tossupsHeard).toBeLessThanOrEqual(game.tossupsRead);
    }
  }

  for (const question of game.questions) {
    const attempts = question.buzzes.map((buzz) => buzz.team).concat(question.noPenalty.map((attempt) => attempt.team));
    expect(new Set(attempts).size).toBe(attempts.length);
    expect(Object.values(question.scoreAfter).every(Number.isFinite)).toBe(true);
    for (const side of ['left', 'right'] as const) {
      expect(question.activePlayers[side].length).toBeLessThanOrEqual(format.players.maximumActive);
      expect(
        question.activePlayers[side].every((name) => game[side].players.some((player) => player.name === name)),
      ).toBe(true);
    }
    const conversion = question.buzzes.find((buzz) => buzz.answerType.value > 0);
    if (question.bonus) {
      expect(conversion).toBeDefined();
      expect(question.bonus.team).toBe(conversion?.team);
    }
    if (question.dead) expect(conversion).toBeUndefined();
  }

  expect(game.timeouts.left).toBeLessThanOrEqual(procedure.timeoutsPerTeam);
  expect(game.timeouts.right).toBeLessThanOrEqual(procedure.timeoutsPerTeam);
  const validation = validateScoresheet(format, gameSetup, events, procedure);
  const acceptableWhileInProgress = new Set([
    'game-not-complete',
    'unfinished-cycle',
    'missing-bonus',
    'missing-derived-bonus',
  ]);
  expect(validation.blockers.filter((problem) => !acceptableWhileInProgress.has(problem.code))).toEqual([]);
}

interface IStateMachineActions {
  progress: ScoreEvent[];
  interruptions: ScoreEvent[];
}

function stateMachineActions(
  format: IScorekeeperFormat,
  gameSetup: IGameSetup,
  events: ScoreEvent[],
  procedure: IRoomProcedure,
  random: () => number,
  step: number,
): IStateMachineActions {
  const game = deriveGame(format, gameSetup, events);
  const progress: ScoreEvent[] = [];
  const phase = game.phase;
  const attachment =
    phase.kind === 'tossup' || phase.kind === 'bonus' || phase.kind === 'timeout'
      ? phase.questionNumber
      : phase.kind === 'checkpoint'
        ? Math.max(1, phase.afterQuestion)
        : Math.max(1, (game.questions.at(-1)?.questionNumber ?? 0) + 1);

  if (phase.kind === 'tossup' || phase.kind === 'bonus') {
    progress.push(...scoringCandidates(format, events, gameSetup));
  } else if (phase.kind === 'checkpoint') {
    progress.push(
      nextEvent({
        type: phase.checkpoint === 'overtime' ? 'begin-overtime' : 'begin-sudden-death',
        questionNumber: attachment,
      }),
    );
  } else if (phase.kind === 'timeout') {
    progress.push(nextEvent({ type: 'timeout-resume', questionNumber: phase.questionNumber }));
  } else if (phase.kind === 'score-check') {
    progress.push(nextEvent({ type: 'half-resume', questionNumber: attachment }));
  }

  if (phase.kind === 'complete') return { progress, interruptions: [] };

  const side = random() < 0.5 ? 'left' : 'right';
  const activeBoundary = lineupChangeEffectiveQuestion(game, events);
  const availablePlayers = game[side].players.map((player) => player.name);
  const lineupSize = Math.min(format.players.maximumActive, random() < 0.2 ? 1 : availablePlayers.length);
  const lineupOffset = Math.floor(random() * availablePlayers.length);
  const activePlayers = Array.from(
    { length: lineupSize },
    (_, index) => availablePlayers[(lineupOffset + index) % availablePlayers.length],
  );
  const interruptions: ScoreEvent[] = [
    nextEvent({ type: 'note', questionNumber: attachment, text: `Seeded room note ${step}`, flagged: step % 7 === 0 }),
    nextEvent({
      type: 'protest',
      questionNumber: attachment,
      team: side,
      subject: 'procedure',
      description: `Seeded ruling ${step}`,
      status: 'declined',
      resolution: 'Play continues',
    }),
    nextEvent({
      type: 'adjustment',
      questionNumber: attachment,
      team: side,
      points: random() < 0.5 ? -5 : 5,
      reason: 'Seeded control ruling',
    }),
    nextEvent({ type: 'roster-add', questionNumber: attachment, team: side, playerName: `${side} reserve` }),
    nextEvent({ type: 'substitution', questionNumber: activeBoundary, team: side, activePlayers }),
    nextEvent({ type: 'timeout', questionNumber: attachment, team: side }),
  ];

  if (phase.kind === 'tossup') {
    interruptions.push(
      nextEvent({
        type: 'timeout-start',
        questionNumber: phase.questionNumber,
        team: side,
        startedAt: step * 1_000,
      }),
    );
  }
  if (procedure.halves && game.tossupsRead > 0 && phase.kind === 'tossup') {
    interruptions.push(
      nextEvent({
        type: 'half-break',
        questionNumber: phase.questionNumber,
        lastQuestion: game.questions.at(-1)?.questionNumber ?? 0,
      }),
    );
  }
  const lastQuestion = game.questions.at(-1);
  if (lastQuestion) {
    interruptions.push(
      nextEvent({
        type: 'question-void',
        questionNumber: lastQuestion.questionNumber,
        scope: lastQuestion.bonus && random() < 0.5 ? 'bonus' : 'tossup',
        reason: 'Seeded replacement',
      }),
    );
  }
  if (format.lightning.enabled) {
    interruptions.push(
      nextEvent({ type: 'lightning', questionNumber: attachment, team: side, points: random() < 0.5 ? 0 : 20 }),
    );
  }
  if (format.regulation.timed && !game.regulationComplete) {
    interruptions.push(
      nextEvent({
        type: 'end-regulation',
        questionNumber: attachment,
        lastRegulationQuestion: game.questions.at(-1)?.questionNumber ?? 0,
      }),
    );
  }
  const firstTerminalStep = deepStressEnabled ? Math.floor(generatedActionLimit * 0.75) : 8;
  if (step >= firstTerminalStep) {
    interruptions.push(
      nextEvent({
        type: 'end-game-early',
        questionNumber: attachment,
        reason: 'Seeded early ending',
        tossupsRead: game.tossupsRead,
      }),
      nextEvent({ type: 'forfeit', questionNumber: attachment, teams: [side] }),
    );
  }
  return { progress, interruptions };
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
  }, exhaustiveTraversalTimeoutMs);

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
  }, exhaustiveTraversalTimeoutMs);
});

describe('seeded state-machine stress coverage', () => {
  const gameSetup: IGameSetup = {
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
  const ordinaryFormats = [
    compactFormat('seeded powers and bonuses', CommonRuleSets.AcfPowers),
    compactFormat('seeded timed lightning', CommonRuleSets.NaqtTimed, (rules) => {
      rules.timed = true;
      rules.lightningCountPerTeam = 10;
    }),
  ];
  const deepFormats = ordinaryFormats.concat([
    compactFormat('seeded no bonuses', CommonRuleSets.Acf, (rules) => rules.setUseBonuses(false)),
    compactFormat('seeded regular bouncebacks', CommonRuleSets.AcfPowers, (rules) => {
      rules.bonusesBounceBack = true;
      rules.minimumPartsPerBonus = 2;
      rules.maximumPartsPerBonus = 2;
      rules.maximumBonusScore = 20;
    }),
    compactFormat('seeded irregular custom values', CommonRuleSets.Acf, (rules) => {
      rules.answerTypes = [new AnswerType(7), new AnswerType(-3)];
      rules.pointsPerBonusPart = undefined;
      rules.minimumPartsPerBonus = 1;
      rules.maximumPartsPerBonus = 4;
      rules.maximumBonusScore = 20;
      rules.bonusDivisor = 5;
    }),
  ]).map((format) => withRegulationLength(format, 12));
  const formats = deepStressEnabled ? deepFormats : ordinaryFormats;

  test('checks invariants after every transition in many reproducible mixed-event games', async () => {
    const acceptedTypes = new Set<ScoreEvent['type']>();
    const recoveredAfterTypes = new Set<ScoreEvent['type']>();
    const recoveredPhases = new Set<string>();
    const phaseActions = new Set<string>();
    const formatActions = new Set<string>();
    const adjacentActions = new Set<string>();
    const alwaysRecoverAfter = new Set<ScoreEvent['type']>([
      'tossup-buzz',
      'bonus',
      'timeout-start',
      'half-break',
      'substitution',
      'question-void',
    ]);
    let acceptedTransitions = 0;
    let rejectedCandidates = 0;
    let completedGames = 0;
    let recoveryCycles = 0;

    for (let seed = 1; seed <= generatedSeedCount; seed += 1) {
      if (deepStressEnabled && seed % 32 === 0) await yieldToTestRunner();
      const random = seededRandom(seed);
      const format = formats[seed % formats.length];
      const storage = memoryStorage();
      const gameKey = `state-space-seed-${seed}`;
      const now = new Date('2026-08-10T12:00:00.000Z');
      let activeSetup = gameSetup;
      let events: ScoreEvent[] = [];
      let previousAction: ScoreEvent['type'] | undefined;

      for (let step = 0; step < generatedActionLimit; step += 1) {
        const context: IScoreEventContext = { format, setup: activeSetup, procedure };
        const before = deriveGame(format, activeSetup, events);
        const beforeSemantics = gameSemantics(before);
        if (before.phase.kind === 'complete') {
          completedGames += 1;
          const rejected = applyScoreEvents(context, events, [
            nextEvent({
              type: 'tossup-dead',
              questionNumber: (before.questions.at(-1)?.questionNumber ?? 0) + 1,
            }),
          ]);
          withReplayDiagnostics(seed, step, format, events, () => expect(rejected.ok).toBe(false));
          break;
        }

        const actions = stateMachineActions(format, activeSetup, events, procedure, random, step);
        const preferInterruption = actions.interruptions.length > 0 && random() < 0.35;
        const preferred = preferInterruption ? actions.interruptions : actions.progress;
        const fallback = preferInterruption ? actions.progress : actions.interruptions;
        const candidates = preferred.concat(fallback);
        const offset = candidates.length === 0 ? 0 : Math.floor(random() * candidates.length);
        let accepted: ScoreEvent | undefined;

        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[(offset + index) % candidates.length];
          const result = applyScoreEvents(context, events, [candidate]);
          if (!result.ok) {
            rejectedCandidates += 1;
            continue;
          }
          events = result.events;
          accepted = candidate;
          break;
        }

        if (!accepted) {
          withReplayDiagnostics(seed, step, format, events, () => {
            throw new Error(`No legal action from ${JSON.stringify(before.phase)}.`);
          });
          break;
        }
        acceptedTypes.add(accepted.type);
        acceptedTransitions += 1;
        const beforePhase =
          before.phase.kind === 'checkpoint'
            ? `${before.phase.kind}:${before.phase.checkpoint}`
            : before.phase.kind === 'tossup'
              ? `${before.phase.kind}:${before.phase.period}`
              : before.phase.kind;
        phaseActions.add(`${beforePhase} -> ${accepted.type}`);
        formatActions.add(`${format.name} -> ${accepted.type}`);
        if (previousAction) adjacentActions.add(`${previousAction} -> ${accepted.type}`);
        previousAction = accepted.type;

        withReplayDiagnostics(seed, step, format, events, () => {
          legalHistoryInvariants(format, activeSetup, events, procedure);

          // Removing the event just accepted must recover the exact prior semantic state.
          expect(gameSemantics(deriveGame(format, activeSetup, events.slice(0, -1)))).toEqual(beforeSemantics);

          // JSON cloning is the serialization boundary used by local recovery.
          const clonedEvents = JSON.parse(JSON.stringify(events)) as ScoreEvent[];
          expect(gameSemantics(deriveGame(format, activeSetup, clonedEvents))).toEqual(
            gameSemantics(deriveGame(format, activeSetup, events)),
          );

          // Audit-only notes must not alter scoring, personnel, or game flow.
          if ((seed + step) % 4 === 0) {
            const game = deriveGame(format, activeSetup, events);
            const questionNumber =
              game.phase.kind === 'tossup' || game.phase.kind === 'bonus' || game.phase.kind === 'timeout'
                ? game.phase.questionNumber
                : Math.max(1, game.questions.at(-1)?.questionNumber ?? 1);
            const withNote = events.concat({
              id: `metamorphic-note-${seed}-${step}`,
              type: 'note',
              questionNumber,
              text: 'Metamorphic note',
            });
            expect(gameSemanticsWithoutNotes(deriveGame(format, activeSetup, withNote))).toEqual(
              gameSemanticsWithoutNotes(game),
            );
          }
        });

        const after = deriveGame(format, activeSetup, events);
        const afterPhase =
          after.phase.kind === 'checkpoint' ? `${after.phase.kind}:${after.phase.checkpoint}` : after.phase.kind;
        const shouldRecover =
          alwaysRecoverAfter.has(accepted.type) || after.phase.kind === 'checkpoint' || random() < 0.2;
        if (shouldRecover) {
          withReplayDiagnostics(seed, step, format, events, () => {
            const beforeRecovery = gameSemantics(after);
            expect(saveGame(gameKey, activeSetup, events, now, storage)).toBe(true);
            const recovered = loadGame(gameKey, now, storage);
            expect(recovered).not.toBeNull();
            if (!recovered) return;

            const restored = deriveGame(format, recovered.setup, recovered.events);
            expect(gameSemantics(restored)).toEqual(beforeRecovery);

            // Unique identifiers are identity for editing, not part of scoring semantics.
            const remappedIds = recovered.events.map((event, index) => ({
              ...event,
              id: `remapped-${seed}-${step}-${index}`,
            }));
            expect(gameSemantics(deriveGame(format, recovered.setup, remappedIds))).toEqual(beforeRecovery);

            // Continue the next generated action from the deserialized setup and history.
            activeSetup = recovered.setup;
            events = recovered.events;
          });
          recoveredAfterTypes.add(accepted.type);
          recoveredPhases.add(afterPhase);
          recoveryCycles += 1;
        }
      }
    }

    expect(acceptedTransitions).toBeGreaterThan(generatedSeedCount * 8);
    expect(rejectedCandidates).toBeGreaterThan(0);
    expect(completedGames).toBeGreaterThan(0);
    expect(recoveryCycles).toBeGreaterThan(generatedSeedCount * 3);
    expect(phaseActions.size).toBeGreaterThan(25);
    expect(Array.from(acceptedTypes)).toEqual(
      expect.arrayContaining([
        'tossup-buzz',
        'tossup-no-penalty',
        'tossup-dead',
        'bonus',
        'substitution',
        'timeout-start',
        'timeout-resume',
        'protest',
        'question-void',
        'adjustment',
        'end-regulation',
      ]),
    );
    expect(Array.from(recoveredAfterTypes)).toEqual(
      expect.arrayContaining([
        'tossup-buzz',
        'bonus',
        'timeout-start',
        'half-break',
        'substitution',
        'question-void',
      ]),
    );
    expect(Array.from(recoveredPhases)).toEqual(
      expect.arrayContaining(['bonus', 'timeout', 'score-check', 'checkpoint:overtime']),
    );
    if (deepStressEnabled) {
      console.info(
        [
          'Deep state-machine coverage',
          `seeds=${generatedSeedCount}`,
          `actionLimit=${generatedActionLimit}`,
          `acceptedTransitions=${acceptedTransitions}`,
          `recoveryCycles=${recoveryCycles}`,
          `phaseActions=${phaseActions.size}`,
          `formatActions=${formatActions.size}`,
          `adjacentActions=${adjacentActions.size}`,
          '',
          ...Array.from(phaseActions).sort(),
        ].join('\n'),
      );
    }
  }, generatedStateMachineTimeoutMs);

  test('rejects seeded malformed recovery histories without throwing or producing non-finite totals', () => {
    const format = formats[0];
    const malformed: unknown[] = [
      null,
      17,
      {},
      { type: 'unknown', id: 'bad-type', questionNumber: 1 },
      { type: 'tossup-dead', id: '', questionNumber: 1 },
      { type: 'tossup-dead', id: 'bad-question', questionNumber: 0 },
      {
        type: 'tossup-buzz',
        id: 'bad-team',
        questionNumber: 1,
        team: 'banana',
        playerName: 'Sarah',
        answerTypeIndex: 0,
      },
      {
        type: 'tossup-buzz',
        id: 'bad-player',
        questionNumber: 1,
        team: 'left',
        playerName: '',
        answerTypeIndex: 0,
      },
      {
        type: 'tossup-buzz',
        id: 'bad-ruling',
        questionNumber: 1,
        team: 'left',
        playerName: 'Sarah',
        answerTypeIndex: 999,
      },
      { type: 'bonus', id: 'bad-bonus', questionNumber: 1, team: 'left', parts: [null] },
      { type: 'substitution', id: 'bad-lineup', questionNumber: 1, team: 'left', activePlayers: [] },
      { type: 'timeout-start', id: 'bad-clock', questionNumber: 1, team: 'left', startedAt: Number.NaN },
      { type: 'adjustment', id: 'bad-adjustment', questionNumber: 1, team: 'left', points: Number.POSITIVE_INFINITY },
      {
        type: 'protest',
        id: 'bad-protest',
        questionNumber: 1,
        team: 'left',
        subject: 'weather',
        description: 'Invalid subject',
        status: 'open',
      },
      { type: 'question-void', id: 'bad-void', questionNumber: 1, scope: 'tossup', reason: '' },
      { type: 'forfeit', id: 'bad-forfeit', questionNumber: 1, teams: 'left' },
      { type: 'note', id: 'bad-note', questionNumber: 1, text: ['not', 'text'] },
      { type: 'roster-add', id: 'bad-roster', questionNumber: 1, team: 'left', playerName: '' },
      { type: 'end-regulation', id: 'bad-boundary', questionNumber: 1, lastRegulationQuestion: -1 },
      { type: 'end-game-early', id: 'bad-ending', questionNumber: 1, reason: 'Invalid', tossupsRead: -1 },
    ];

    for (let seed = 101; seed <= 164; seed += 1) {
      const random = seededRandom(seed);
      const history = Array.from({ length: 1 + Math.floor(random() * 6) }, () => pick(malformed, random));
      let validation: ReturnType<typeof validateScoresheet> | undefined;
      expect(() => {
        validation = validateScoresheet(format, gameSetup, history as ScoreEvent[], procedure);
      }).not.toThrow();
      expect(
        validation?.blockers.some(
          (problem) => problem.code === 'malformed-event' || problem.code === 'malformed-event-id',
        ),
      ).toBe(true);
      for (const side of ['left', 'right'] as const) {
        expect(Number.isFinite(validation?.game[side].points)).toBe(true);
      }
    }
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
      'tossup-reading-resumed': {
        context: ordinaryContext,
        before: [nextEvent({ type: 'tossup-no-penalty', questionNumber: 1, team: 'left', playerName: 'Sarah' })],
        candidate: nextEvent({ type: 'tossup-reading-resumed', questionNumber: 1 }),
      },
      'tossup-readout': {
        context: ordinaryContext,
        before: [],
        candidate: nextEvent({ type: 'tossup-readout', questionNumber: 1 }),
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
      'tossup-reading-resumed': { type: 'tossup-reading-resumed', questionNumber: 1 },
      'tossup-readout': { type: 'tossup-readout', questionNumber: 1 },
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
