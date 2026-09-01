import type { TournamentRules, Tiebreaker, RulesPreset } from './model';

export interface RulesIssue {
  readonly code: string;
  readonly message: string;
  readonly field: string;
}

const defaultTiebreakers: readonly Tiebreaker[] = [
  'wins',
  'head-to-head',
  'point-differential',
  'points-for',
  'seed',
];

/**
 * Return a complete rule set for a standard quiz-bowl configuration.
 *
 * Presets are deliberately explicit data, not aliases to a UI form. A caller can copy the result
 * and change individual values before saving a custom ruleset.
 */
export function defaultRules(preset: RulesPreset = 'acf'): TournamentRules {
  switch (preset) {
    case 'naqt':
      return {
        preset,
        tossupsPerGame: 28,
        tossupPoints: 10,
        powerPoints: 15,
        negPoints: -5,
        bonusParts: 3,
        bonusPartPoints: [10, 10, 10],
        bouncebacks: false,
        overtime: { enabled: true, tossups: 3, suddenDeath: false },
        lightning: { enabled: false, tossups: 0, pointsPerTossup: 10 },
        maximumActivePlayers: 4,
        roomProcedure: { timed: true, halfLengthMinutes: 15, allowRosterAmendments: true },
        rematchPolicy: 'avoid-when-possible',
        tiebreakers: defaultTiebreakers,
      };
    case 'house':
      return {
        preset,
        tossupsPerGame: 20,
        tossupPoints: 10,
        powerPoints: 15,
        negPoints: -5,
        bonusParts: 3,
        bonusPartPoints: [10, 10, 10],
        bouncebacks: true,
        overtime: { enabled: true, tossups: 3, suddenDeath: true },
        lightning: { enabled: false, tossups: 0, pointsPerTossup: 10 },
        maximumActivePlayers: 4,
        roomProcedure: { timed: false, halfLengthMinutes: null, allowRosterAmendments: true },
        rematchPolicy: 'avoid-when-possible',
        tiebreakers: defaultTiebreakers,
      };
    case 'custom':
    case 'acf':
      return {
        preset,
        tossupsPerGame: 20,
        tossupPoints: 10,
        powerPoints: 15,
        negPoints: -5,
        bonusParts: 3,
        bonusPartPoints: [10, 10, 10],
        bouncebacks: true,
        overtime: { enabled: true, tossups: 3, suddenDeath: false },
        lightning: { enabled: false, tossups: 0, pointsPerTossup: 10 },
        maximumActivePlayers: 4,
        roomProcedure: { timed: false, halfLengthMinutes: null, allowRosterAmendments: true },
        rematchPolicy: 'avoid-when-possible',
        tiebreakers: defaultTiebreakers,
      };
  }
}

export function validateRules(rules: TournamentRules): readonly RulesIssue[] {
  const issues: RulesIssue[] = [];
  const integerAtLeast = (field: string, value: number, minimum: number): void => {
    if (!Number.isInteger(value) || value < minimum) {
      issues.push({
        code: 'invalid-integer',
        field,
        message: `${field} must be a whole number of at least ${minimum}.`,
      });
    }
  };

  integerAtLeast('tossupsPerGame', rules.tossupsPerGame, 1);
  integerAtLeast('bonusParts', rules.bonusParts, 0);
  integerAtLeast('maximumActivePlayers', rules.maximumActivePlayers, 1);
  integerAtLeast('overtime.tossups', rules.overtime.tossups, 0);
  integerAtLeast('lightning.tossups', rules.lightning.tossups, 0);

  if (!Number.isFinite(rules.tossupPoints) || rules.tossupPoints <= 0) {
    issues.push({ code: 'invalid-score', field: 'tossupPoints', message: 'Tossup points must be positive.' });
  }
  if (!Number.isFinite(rules.powerPoints) || rules.powerPoints < rules.tossupPoints) {
    issues.push({
      code: 'invalid-score',
      field: 'powerPoints',
      message: 'Power points must be at least regular tossup points.',
    });
  }
  if (!Number.isFinite(rules.negPoints) || rules.negPoints > 0) {
    issues.push({
      code: 'invalid-score',
      field: 'negPoints',
      message: 'Neg points must be zero or negative.',
    });
  }
  if (rules.bonusPartPoints.length !== rules.bonusParts) {
    issues.push({
      code: 'bonus-shape-mismatch',
      field: 'bonusPartPoints',
      message: 'The number of bonus part values must equal bonusParts.',
    });
  }
  if (rules.bonusPartPoints.some((points) => !Number.isFinite(points) || points < 0)) {
    issues.push({
      code: 'invalid-score',
      field: 'bonusPartPoints',
      message: 'Bonus part values cannot be negative.',
    });
  }
  if (rules.overtime.enabled && rules.overtime.tossups < 1) {
    issues.push({
      code: 'invalid-overtime',
      field: 'overtime.tossups',
      message: 'Enabled overtime needs at least one tossup.',
    });
  }
  if (rules.lightning.enabled && (rules.lightning.tossups < 1 || rules.lightning.pointsPerTossup <= 0)) {
    issues.push({
      code: 'invalid-lightning',
      field: 'lightning',
      message: 'Enabled lightning needs tossups and positive points.',
    });
  }
  if (
    rules.roomProcedure.timed &&
    (!rules.roomProcedure.halfLengthMinutes || rules.roomProcedure.halfLengthMinutes <= 0)
  ) {
    issues.push({
      code: 'invalid-clock',
      field: 'roomProcedure.halfLengthMinutes',
      message: 'A timed procedure needs a positive half length.',
    });
  }
  if (new Set(rules.tiebreakers).size !== rules.tiebreakers.length) {
    issues.push({
      code: 'duplicate-tiebreaker',
      field: 'tiebreakers',
      message: 'Tiebreakers must not be repeated.',
    });
  }
  if (rules.tiebreakers.length === 0) {
    issues.push({
      code: 'missing-tiebreaker',
      field: 'tiebreakers',
      message: 'Configure at least one standings tiebreaker.',
    });
  }
  return issues;
}

export function rulesAreValid(rules: TournamentRules): boolean {
  return validateRules(rules).length === 0;
}
