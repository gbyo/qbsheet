/**
 * The bonus buttons, worked out from the rules rather than assumed.
 *
 * A three-part bonus at ten points a part gets 0 / 10 / 20 / 30. A four-part one gets a fifth
 * button. A five-point-a-part bonus counts in fives. None of that is written down anywhere here —
 * it all falls out of `pointsPerPart` and `maximumScore`.
 *
 * When the format's bonuses are irregular there is nothing to enumerate: the parts need not be worth
 * the same, and there need not be a fixed number of them, so the only honest interface is a number
 * the scorekeeper types. `bonusTotalProblem` is what checks it.
 */
import { IScorekeeperBonus } from '../../renderer/Services/ScorekeeperFormat';

/**
 * Every total a regular bonus can be worth, ascending.
 *
 * Null when the bonus is irregular, which is the signal to ask for a number instead of offering
 * buttons. `bonusesAreRegular()` is the same condition YellowFruit uses to decide whether it can
 * calculate bounceback parts heard at all.
 */
export function regularBonusTotals(bonus: IScorekeeperBonus): number[] | null {
  if (!bonus.regular) return null;
  const perPart = bonus.pointsPerPart;
  if (!perPart || perPart <= 0) return null;

  const totals: number[] = [];
  for (let points = 0; points <= bonus.maximumScore; points += perPart) totals.push(points);
  // A maximum that isn't a whole number of parts would otherwise be unreachable. FileParsing rejects
  // that combination on the way in, but a format assembled in memory can still hold it.
  if (totals[totals.length - 1] !== bonus.maximumScore) totals.push(bonus.maximumScore);
  return totals;
}

/**
 * What the opposing team can earn on bouncebacks, given what the controlling team took.
 *
 * Bounded by what is actually left on the bonus: a team that converted every part leaves nothing to
 * bounce, and offering a button for it would invite a score that cannot happen.
 */
export function bouncebackOptions(bonus: IScorekeeperBonus, controlledPoints: number): number[] {
  const available = Math.max(0, bonus.maximumScore - controlledPoints);
  const step = bonus.pointsPerPart && bonus.pointsPerPart > 0 ? bonus.pointsPerPart : bonus.divisor;
  if (step <= 0) return [0];

  const options: number[] = [];
  for (let points = 0; points <= available; points += step) options.push(points);
  if (options[options.length - 1] !== available) options.push(available);
  return options;
}

/**
 * Why this bonus total can't be right, or null if it can.
 *
 * The wording matches the desktop's own validation messages, so a scorekeeper who sees the same
 * problem in both places is told the same thing about it.
 */
export function bonusTotalProblem(bonus: IScorekeeperBonus, points: number): string | null {
  if (!Number.isFinite(points) || !Number.isInteger(points)) return 'Enter a whole number of points.';
  if (points < 0) return 'Bonus points cannot be negative.';
  if (points > bonus.maximumScore) return `The most a bonus can be worth is ${bonus.maximumScore}.`;
  const divisor = bonus.regular && bonus.pointsPerPart && bonus.pointsPerPart > 0 ? bonus.pointsPerPart : bonus.divisor;
  if (divisor > 0 && points % divisor !== 0) {
    return `Bonus points should be divisible by ${divisor}.`;
  }
  return null;
}

/** Validate a controlled/bounceback pair using the same rules as total entry and correction. */
export function bonusScoreProblem(
  bonus: IScorekeeperBonus,
  controlledPoints: number,
  bouncebackPoints: number,
): string | null {
  const controlledProblem = bonusTotalProblem(bonus, controlledPoints);
  if (controlledProblem) return controlledProblem;
  const bouncebackProblem = bonusTotalProblem(bonus, bouncebackPoints);
  if (bouncebackProblem) return bouncebackProblem;
  if (!bonus.bounceBack && bouncebackPoints !== 0) return 'This format does not allow bounceback points.';
  if (controlledPoints + bouncebackPoints > bonus.maximumScore) {
    return `The bounceback cannot exceed ${Math.max(0, bonus.maximumScore - controlledPoints)} points.`;
  }
  return null;
}

/** Validate one regular part; irregular bonuses have no fixed per-part outcome to enforce. */
export function bonusPartProblem(
  bonus: IScorekeeperBonus,
  controlledPoints: number,
  bouncebackPoints: number,
): string | null {
  if (bonus.regular && bonus.pointsPerPart !== undefined) {
    const valid = (points: number) => points === 0 || points === bonus.pointsPerPart;
    if (Number.isFinite(controlledPoints) && Number.isFinite(bouncebackPoints)) {
      if (!valid(controlledPoints) || !valid(bouncebackPoints)) {
        return `Each regular bonus part is worth 0 or ${bonus.pointsPerPart} points.`;
      }
    }
  }
  const pairProblem = bonusScoreProblem(bonus, controlledPoints, bouncebackPoints);
  if (pairProblem) return pairProblem;
  return null;
}

/**
 * Why this lightning total can't be right, or null if it can.
 *
 * YellowFruit only warns about the divisor here rather than refusing, and treats the total as the
 * authority, so this stays advisory in the same way.
 */
export function lightningTotalProblem(divisor: number, points: number): string | null {
  if (!Number.isFinite(points) || !Number.isInteger(points)) return 'Enter a whole number of points.';
  if (points < 0) return 'Lightning points cannot be negative.';
  if (divisor > 0 && points % divisor !== 0) return `Lightning points should be divisible by ${divisor}.`;
  return null;
}
