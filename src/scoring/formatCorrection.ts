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
    // First wins. A format with two identically-labelled buttons is refused by
    // `scorekeeperFormatProblems` long before this, so the collision is not reachable in practice;
    // preferring the earlier of the two keeps this total rather than relying on that.
    if (!destination.has(buttonKey(answerType))) destination.set(buttonKey(answerType), index);
  });
  return from.answerTypes.map((answerType) => destination.get(buttonKey(answerType)) ?? null);
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
): FormatCorrection {
  // A proposed format that is not a playable game is refused before anything is compared against it,
  // so the reasons a scorekeeper reads are about the rules rather than about the consequences of
  // rules that were never valid.
  const invalid = scorekeeperFormatProblems(to);
  if (invalid.length > 0) return { ok: false, problems: invalid };

  const problems: string[] = [];
  const changes: IFormatChange[] = [];
  const mapping = remapAnswerTypes(from, to);
  const used = usedAnswerTypes(events);
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
        affectsRecordedScoring: used.has(oldIndex),
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
  }

  // --- players --------------------------------------------------------------------------------

  if (from.players.maximumActive !== to.players.maximumActive) {
    // Every lineup the game has recorded has to remain legal, including the starting one.
    const largestLineup = events.reduce(
      (most, event) => (event.type === 'substitution' ? Math.max(most, event.activePlayers.length) : most),
      0,
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

  return { ok: true, format: carried, events: remapped, changes, unchanged: changes.length === 0 && !moved };
}
