/**
 * Correcting the scoring rules of a game that is already being scored.
 *
 * # The situation this is for
 *
 * A tournament announces after the first round that powers are worth 20, not 15. Or that regulation
 * is 24 tossups. Or that the packet has no lightning round after all. The rules were entered — or
 * delivered in a QBJ — before anybody knew, and sixteen rooms are now half a game into scoring
 * against the wrong ones.
 *
 * Until now the only answers were to finish the game wrong and have somebody fix it in the stats
 * package afterwards, or to start over and re-enter fourteen questions from a paper backup. Both are
 * worse than they need to be, because of a property the engine has always had and never used:
 * `deriveGame(format, setup, events)` is a pure function of its arguments, and the events record
 * *what happened* rather than what it was worth. A buzz says "seat three, answer type 0" and not
 * "seat three, 15 points". So changing the format and re-deriving produces exactly the game that
 * would have been produced if the right rules had been there from the first tossup.
 *
 * # Why this is a whole module and not a call to `store.update`
 *
 * Because `answerTypeIndex` is a position, and positions move.
 *
 * `ITossupBuzzEvent` refers to its answer type by index into `format.answerTypes`, which is sorted
 * descending by value. Correcting a power from 15 to 20 leaves every index where it was. *Adding* a
 * second power tier does not: the new type sorts to the top, every existing index shifts by one, and
 * every power already recorded silently becomes something else. Nothing would throw. The game would
 * simply be wrong, in a way that looks like it was scored that way on purpose.
 *
 * So a correction is not a swap. It is a swap plus a remapping of every recorded buzz, computed from
 * what the answer types *are* rather than from where they sit, and it is refused outright when that
 * remapping cannot be made honestly.
 *
 * # What identifies "the same answer type"
 *
 * The short label — the two or three characters on the button the scorekeeper actually pressed. Not
 * the point value, because the entire point of the exercise is that a value is being corrected; not
 * the position, for the reason above; not the QBJ id, because a format typed into the advanced form
 * mints fresh ones every time it is saved and a correction is a save.
 *
 * Matching on what is written on the button is also the rule a scorekeeper can check. "Every P you
 * pressed is still a P, and it is now worth 20" is a sentence somebody can agree or object to.
 *
 * # What it refuses
 *
 * Anything where the recorded history and the proposed rules cannot both be true. A power that no
 * longer exists but has been awarded four times; bonuses switched off in a game with bonuses in it;
 * a regulation shortened below the number of questions already played. These are not warnings. A
 * correction that produced a game whose own history the format forbids would hand the room a
 * scoresheet that fails validation and no way back, so it is refused with the reason stated, and the
 * scorekeeper corrects the earlier questions first — which is a thing the scorer already does well.
 */
import { IScorekeeperAnswerType, IScorekeeperFormat, scorekeeperFormatProblems } from './ScorekeeperFormat';
import { IGameSetup, startingLineup } from './deriveGame';
import { ScoreEvent } from './ScoreEvents';

/** Compare short labels the way a scorekeeper would: the characters, not the whitespace or the case. */
function buttonKey(answerType: IScorekeeperAnswerType): string {
  return answerType.shortLabel.trim().toLowerCase();
}

/**
 * One thing a scorekeeper is about to change, in words.
 *
 * Every accepted correction produces at least one of these, and they are shown before anything is
 * written. A confirmation that says only "this will change the scoring rules" is a confirmation
 * nobody can meaningfully give.
 */
export interface IFormatChange {
  /** What changed: `Power`, `Regulation length`, `Bonuses`. */
  subject: string;
  /** How it changes: `15 points → 20 points`. */
  detail: string;
  /**
   * True when this restates points already on the board.
   *
   * A value change reprices questions that have been scored; a change to the overtime rules does
   * not touch anything until overtime. The distinction decides how loud the confirmation is.
   */
  affectsRecordedScoring: boolean;
}

export type FormatCorrection =
  | {
      ok: true;
      format: IScorekeeperFormat;
      /**
       * The history, with every buzz re-pointed at the same button in the new format.
       *
       * Identical to the input array when no answer type moved, which is the common case. Returned
       * rather than mutated for the reason the engine returns everything: the caller writes both the
       * format and the events, or neither.
       */
      events: ScoreEvent[];
      changes: IFormatChange[];
      /** True when nothing about the rules actually differs, so there is nothing to write. */
      unchanged: boolean;
    }
  | { ok: false; problems: string[] };

/** How a value reads in a change line. */
function points(value: number): string {
  return `${value} ${Math.abs(value) === 1 ? 'point' : 'points'}`;
}

/**
 * The answer types, matched up by what is on the button.
 *
 * @returns the new index for each old index, or `null` for an old answer type with no counterpart.
 */
function remapAnswerTypes(from: IScorekeeperFormat, to: IScorekeeperFormat): (number | null)[] {
  const destination = new Map<string, number>();
  to.answerTypes.forEach((answerType, index) => {
    // Safe to take the first, because `duplicateButtonProblems` has already refused any format where
    // two buttons share a key. Without that guard this would silently point two old answer types at
    // one new index and reprice half the game.
    if (!destination.has(buttonKey(answerType))) destination.set(buttonKey(answerType), index);
  });
  return from.answerTypes.map((answerType) => destination.get(buttonKey(answerType)) ?? null);
}

/**
 * Short labels that collide once normalized.
 *
 * `scorekeeperFormatProblems` checks that a short label is a non-empty string and nothing else, so a
 * format with `P` and ` p ` is valid to it and ambiguous here: `buttonKey` trims and lowercases, both
 * rows produce the same key, and every buzz recorded against the second would be remapped onto the
 * first. That is the exact failure this module exists to prevent, arriving through the front door.
 *
 * Checked on both formats, but not on the same terms. A collision in `to` is always fatal: it is
 * being proposed now, and it makes every future remapping ambiguous. A collision already present in
 * `from` only matters for the buzzes that actually reference one of the colliding buttons — and a
 * room whose tournament shipped an ambiguous QBJ must not be locked out of correcting its rules over
 * two answer types nobody has pressed, especially since the fix for it is in the form this would be
 * refusing to open.
 *
 * @param usedIndices when given, a `from`-side collision is reported only if the history uses one of
 * the colliding answer types. Omit for the proposed format, where every collision counts.
 */
function duplicateButtonProblems(
  format: IScorekeeperFormat,
  which: 'current' | 'new',
  usedIndices?: Set<number>,
): string[] {
  const seen = new Map<string, { label: string; index: number }>();
  const problems: string[] = [];
  format.answerTypes.forEach((answerType, index) => {
    const key = buttonKey(answerType);
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, { label: answerType.label, index });
      return;
    }
    if (usedIndices && !usedIndices.has(index) && !usedIndices.has(first.index)) return;
    problems.push(
      `The ${which} rules have two answer types whose short label reads as "${answerType.shortLabel.trim()}" — "${first.label}" and "${answerType.label}". Give them different short labels first.`,
    );
  });
  return problems;
}

/**
 * A key that changes whenever any part of the format does.
 *
 * `changes` is a human-readable summary and is deliberately selective — it says "Power: 15 → 20"
 * because that is what a scorekeeper checks against what a director just said. It is the wrong thing
 * to decide `unchanged` from: every field it does not narrate is a correction the dialog would refuse
 * to apply, having told the scorekeeper their rules were already in force. A bonus divisor, an
 * extended regulation and a lightning count were all in that position.
 *
 * So the question "did anything change?" is asked of the whole structure instead, with keys sorted so
 * two objects built by different paths compare equal.
 */
function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${key}:${stableKey(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Every answer-type index the history actually uses. */
function usedAnswerTypes(events: ScoreEvent[]): Set<number> {
  const used = new Set<number>();
  events.forEach((event) => {
    if (event.type === 'tossup-buzz') used.add(event.answerTypeIndex);
  });
  return used;
}

/** The highest cycle the history has anything recorded in, which is how far the game has got. */
export function lastRecordedQuestion(events: ScoreEvent[]): number {
  return events.reduce((highest, event) => Math.max(highest, event.questionNumber), 0);
}

/**
 * Whether a correction can be applied, and what it would do.
 *
 * Pure. Nothing is written and nothing is decided here about *whether* to apply it; that is the
 * scorekeeper's, after reading `changes`.
 */
export default function correctFormat(
  from: IScorekeeperFormat,
  to: IScorekeeperFormat,
  events: ScoreEvent[],
  /**
   * The rosters, so the opening lineup counts as a lineup.
   *
   * Optional only so that a caller with no setup to hand still gets every other check. When it is
   * absent the players cap is validated against substitutions alone, which is what this did before
   * and is not sufficient on its own; see the players section below.
   */
  setup?: IGameSetup,
): FormatCorrection {
  // A proposed format that is not a playable game is refused before anything is compared against it,
  // so the reasons a scorekeeper reads are about the rules rather than about the consequences of
  // rules that were never valid.
  const used = usedAnswerTypes(events);
  const invalid = [
    ...scorekeeperFormatProblems(to),
    ...duplicateButtonProblems(from, 'current', used),
    ...duplicateButtonProblems(to, 'new'),
  ];
  if (invalid.length > 0) return { ok: false, problems: invalid };

  const problems: string[] = [];
  const changes: IFormatChange[] = [];
  /** One line for a plain numeric field that moved. Silent when it did not. */
  const numericChange = (
    subject: string,
    before: number | undefined,
    after: number | undefined,
    affectsRecordedScoring: boolean,
    unit?: string,
  ) => {
    if (before === after) return;
    const say = (value: number | undefined) => (value === undefined ? 'not set' : `${value}${unit ? ` ${unit}` : ''}`);
    changes.push({ subject, detail: `${say(before)} → ${say(after)}`, affectsRecordedScoring });
  };
  const mapping = remapAnswerTypes(from, to);
  const played = lastRecordedQuestion(events);

  // --- answer types ---------------------------------------------------------------------------

  from.answerTypes.forEach((answerType, oldIndex) => {
    const newIndex = mapping[oldIndex];
    if (newIndex === null) {
      // Removing a button nobody pressed is an ordinary correction. Removing one that is on the
      // scoresheet four times is asking for those four answers to become nothing.
      if (used.has(oldIndex)) {
        problems.push(
          `"${answerType.label}" has been recorded in this game, so it cannot be removed. Correct those questions first, then change the rules.`,
        );
      } else {
        changes.push({ subject: answerType.label, detail: 'removed', affectsRecordedScoring: false });
      }
      return;
    }
    const replacement = to.answerTypes[newIndex];
    if (replacement.value !== answerType.value) {
      changes.push({
        subject: answerType.label,
        detail: `${points(answerType.value)} → ${points(replacement.value)}`,
        // Only if somebody has actually been given one. A repriced button nobody pressed changes
        // the rules and no score.
        affectsRecordedScoring: used.has(oldIndex),
      });
    }
    if (replacement.awardsBonus !== answerType.awardsBonus) {
      changes.push({
        subject: answerType.label,
        detail: replacement.awardsBonus ? 'now earns a bonus' : 'no longer earns a bonus',
        // Only where there are bonuses for it to be about. `awardsBonus` is meaningless on its own —
        // see the note on it in `ScorekeeperFormat` — so a game with bonuses switched off in both
        // rule sets has nothing to reprice, and telling the room "the scores will move" would be the
        // confirmation screen's one job done wrong.
        affectsRecordedScoring: used.has(oldIndex) && (from.bonus.enabled || to.bonus.enabled),
      });
    }
  });

  const existing = new Set(from.answerTypes.map(buttonKey));
  to.answerTypes.forEach((answerType) => {
    if (!existing.has(buttonKey(answerType))) {
      changes.push({
        subject: answerType.label,
        detail: `added, worth ${points(answerType.value)}`,
        affectsRecordedScoring: false,
      });
    }
  });

  // --- bonuses --------------------------------------------------------------------------------

  const bonusesRecorded = events.some((event) => event.type === 'bonus');
  if (from.bonus.enabled !== to.bonus.enabled) {
    if (!to.bonus.enabled && bonusesRecorded) {
      problems.push(
        'This game has bonuses recorded in it, so bonuses cannot be switched off. Correct those questions first, then change the rules.',
      );
    } else {
      changes.push({
        subject: 'Bonuses',
        detail: to.bonus.enabled ? 'switched on' : 'switched off',
        affectsRecordedScoring: bonusesRecorded,
      });
    }
  } else if (to.bonus.enabled) {
    if (from.bonus.pointsPerPart !== to.bonus.pointsPerPart && to.bonus.pointsPerPart !== undefined) {
      changes.push({
        subject: 'Bonus part',
        detail: `${from.bonus.pointsPerPart === undefined ? 'varied' : points(from.bonus.pointsPerPart)} → ${points(
          to.bonus.pointsPerPart,
        )}`,
        affectsRecordedScoring: bonusesRecorded,
      });
    }
    if (from.bonus.maximumParts !== to.bonus.maximumParts) {
      // A three-part bonus already on the scoresheet has three results in it. Re-deriving against a
      // two-part format leaves the engine holding a part the rules say does not exist.
      const recordedParts = events.reduce(
        (most, event) => (event.type === 'bonus' && event.parts ? Math.max(most, event.parts.length) : most),
        0,
      );
      if (recordedParts > to.bonus.maximumParts) {
        problems.push(
          `A bonus in this game has ${recordedParts} parts recorded, which is more than the ${to.bonus.maximumParts} the new rules allow. Correct that question first, then change the rules.`,
        );
      } else {
        changes.push({
          subject: 'Parts per bonus',
          detail: `${from.bonus.maximumParts} → ${to.bonus.maximumParts}`,
          affectsRecordedScoring: bonusesRecorded,
        });
      }
    }
    if (from.bonus.bounceBack !== to.bonus.bounceBack) {
      changes.push({
        subject: 'Bouncebacks',
        detail: to.bonus.bounceBack ? 'switched on' : 'switched off',
        affectsRecordedScoring: bonusesRecorded,
      });
    }
    // The shape of an irregular bonus, and the regular/irregular switch itself. Each of these
    // reprices bonuses already on the board, and none of them was being said out loud.
    if (from.bonus.regular !== to.bonus.regular) {
      changes.push({
        subject: 'Bonus structure',
        detail: to.bonus.regular ? 'every bonus the same' : 'bonuses vary',
        affectsRecordedScoring: bonusesRecorded,
      });
    }
    numericChange('Bonus score increment', from.bonus.divisor, to.bonus.divisor, bonusesRecorded);
    numericChange('Maximum bonus score', from.bonus.maximumScore, to.bonus.maximumScore, bonusesRecorded);
    numericChange('Fewest bonus parts', from.bonus.minimumParts, to.bonus.minimumParts, bonusesRecorded);
  }

  // --- regulation -----------------------------------------------------------------------------

  if (from.regulation.tossupCount !== to.regulation.tossupCount) {
    // Shortening regulation below what has been played would put the game past its own end, with
    // questions recorded in a period the rules say never happened.
    if (!to.regulation.timed && to.regulation.tossupCount < played) {
      problems.push(
        `This game has reached question ${played}, so regulation cannot be shortened to ${to.regulation.tossupCount} tossups.`,
      );
    } else {
      changes.push({
        subject: 'Regulation length',
        detail: `${from.regulation.tossupCount} → ${to.regulation.tossupCount} tossups`,
        affectsRecordedScoring: false,
      });
    }
  }
  numericChange(
    'Longest regulation',
    from.regulation.maximumTossupCount,
    to.regulation.maximumTossupCount,
    false,
    'tossups',
  );
  if (from.regulation.timed !== to.regulation.timed) {
    changes.push({
      subject: 'Clock',
      detail: to.regulation.timed ? 'timed round' : 'untimed round',
      affectsRecordedScoring: false,
    });
  }

  // --- lightning ------------------------------------------------------------------------------

  const lightningRecorded = events.some((event) => event.type === 'lightning');
  if (from.lightning.enabled !== to.lightning.enabled) {
    if (!to.lightning.enabled && lightningRecorded) {
      problems.push(
        'This game has a lightning total recorded, so lightning cannot be switched off. Remove it first, then change the rules.',
      );
    } else {
      changes.push({
        subject: 'Lightning',
        detail: to.lightning.enabled ? 'switched on' : 'switched off',
        affectsRecordedScoring: lightningRecorded,
      });
    }
  } else if (to.lightning.enabled) {
    numericChange('Lightning rounds per team', from.lightning.countPerTeam, to.lightning.countPerTeam, lightningRecorded);
    numericChange('Lightning score increment', from.lightning.divisor, to.lightning.divisor, lightningRecorded);
  }

  // --- players --------------------------------------------------------------------------------

  if (from.players.maximumActive !== to.players.maximumActive) {
    /*
     * Every lineup this game has played has to remain legal, and most games have exactly one: the
     * opening one, which is not a substitution event and lives in the setup. Counting only
     * substitutions accepted a correction that put a five-player opening lineup under a four-player
     * cap -- a game whose own first tossup its format forbids, which is the failure this module is
     * for.
     *
     * Measured under the *old* cap, because `startingLineup` truncates to whatever cap it is given
     * and the new one would trivially agree with itself.
     */
    const openingLineup = setup
      ? Math.max(
          startingLineup(setup.left, from.players.maximumActive).length,
          startingLineup(setup.right, from.players.maximumActive).length,
        )
      : 0;
    const largestLineup = events.reduce(
      (most, event) => (event.type === 'substitution' ? Math.max(most, event.activePlayers.length) : most),
      openingLineup,
    );
    if (to.players.maximumActive < largestLineup) {
      problems.push(
        `A lineup of ${largestLineup} players is recorded in this game, which is more than the ${to.players.maximumActive} the new rules allow at once.`,
      );
    } else {
      changes.push({
        subject: 'Players at once',
        detail: `${from.players.maximumActive} → ${to.players.maximumActive}`,
        affectsRecordedScoring: false,
      });
    }
  }

  // --- overtime -------------------------------------------------------------------------------

  if (from.overtime.minimumQuestionCount !== to.overtime.minimumQuestionCount) {
    changes.push({
      subject: 'Overtime',
      detail: `${from.overtime.minimumQuestionCount} → ${to.overtime.minimumQuestionCount} tossups`,
      affectsRecordedScoring: false,
    });
  }
  if (from.overtime.includesBonuses !== to.overtime.includesBonuses) {
    changes.push({
      subject: 'Overtime bonuses',
      detail: to.overtime.includesBonuses ? 'played' : 'not played',
      affectsRecordedScoring: false,
    });
  }

  if (problems.length > 0) return { ok: false, problems };

  /*
   * The two fields a correction carries across rather than replaces.
   *
   * Both are labels rather than rules, and both are rewritten by a trip through the form.
   *
   * `qbjId` is minted fresh for every row on every save, so a correction that changed one point
   * value would otherwise hand the exported result a document whose answer types have no
   * relationship to the ones the assignment named. Where the button is the same button, it keeps the
   * identity it arrived with; a genuinely new answer type keeps its new one.
   *
   * `name` is the rule set's own — "NAQT 2026 Rules", or whatever the tournament called it. An
   * unnamed format comes back from the QBJ reader called `Imported scoring rules`, so without this a
   * scorekeeper who opened the dialog to check a value and saved it unchanged would have renamed
   * their tournament's rule set. A correction changes what answers are worth; renaming the rules is
   * not a correction and is not offered here.
   */
  const carried: IScorekeeperFormat = {
    ...to,
    name: from.name,
    answerTypes: to.answerTypes.map((answerType, index) => {
      const original = from.answerTypes.find((candidate) => buttonKey(candidate) === buttonKey(answerType));
      return original ? { ...answerType, index, qbjId: original.qbjId } : { ...answerType, index };
    }),
  };

  // Re-point every recorded buzz at the same button's new position. Untouched when nothing moved,
  // so the common correction writes the identical event array back.
  const moved = mapping.some((newIndex, oldIndex) => newIndex !== oldIndex);
  const remapped = moved
    ? events.map((event) =>
        event.type === 'tossup-buzz'
          ? { ...event, answerTypeIndex: mapping[event.answerTypeIndex] ?? event.answerTypeIndex }
          : event,
      )
    : events;

  /*
   * Whether anything actually differs, asked of the whole structure rather than of `changes`.
   *
   * `carried` is exactly what would be written, so comparing it against `from` answers the question
   * completely -- including every field `changes` does not narrate. Deriving this from
   * `changes.length` meant a correction to, say, only the bonus divisor reported itself as no change
   * at all, and the dialog refused to apply it.
   */
  const unchanged = !moved && stableKey(carried) === stableKey(from);

  /*
   * A change nobody described. Possible whenever the structure differs but no branch above had a
   * sentence for it, and the confirmation screen must not be an empty list under a heading that
   * promises to say what will happen.
   */
  if (!unchanged && changes.length === 0) {
    changes.push({ subject: 'Scoring rules', detail: 'updated', affectsRecordedScoring: false });
  }

  return { ok: true, format: carried, events: remapped, changes, unchanged };
}
