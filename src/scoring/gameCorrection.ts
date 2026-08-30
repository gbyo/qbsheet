/**
 * Correcting the game itself, as opposed to correcting what happened in it.
 *
 * # Two kinds of wrong
 *
 * A question can be wrong — the wrong player was credited, the ruling was overturned — and the
 * scoresheet review has always been able to fix that. The *game* can also be wrong: the rules were
 * entered before the director corrected them, the room was configured for one timeout when the
 * tournament gives two, a team's name was typed from a bracket that had it spelled differently, a
 * player was entered as "Sam" and is on the roster as "Samir".
 *
 * None of those is a thing that happened. They are all statements about the game's own definition
 * that turned out not to match reality, and until now the only one of them the room could correct
 * was the scoring rules.
 *
 * # One shape, because they are one operation
 *
 * `correctFormat` established the pattern and it generalizes exactly: work out what would change,
 * refuse the changes that cannot be made honestly, show the rest, and then write the new definition
 * and the (possibly rewritten) history **together or not at all**. This module is that pattern's
 * vocabulary, so a procedure correction and a player rename produce the same kind of object, are
 * confirmed by the same kind of screen, and are persisted by the same code path.
 *
 * There is deliberately no second source of truth here. A correction produces a replacement
 * definition and a replacement event list; the caller writes both. Nothing accumulates a stack of
 * patches that a later reader would have to replay.
 */
import { IScorekeeperFormat } from './ScorekeeperFormat';
import { IRoomProcedure } from './RoomProcedure';
import { IGameSetup } from './deriveGame';
import { ScoreEvent } from './ScoreEvents';

/**
 * One thing a scorekeeper is about to change, in words.
 *
 * Every accepted correction produces at least one of these, and they are shown before anything is
 * written. A confirmation that says only "this will change the game" is a confirmation nobody can
 * meaningfully give.
 */
export interface ICorrectionChange {
  /** What changed: `Power`, `Timeouts`, `Team name`. */
  subject: string;
  /** How it changes: `15 points → 20 points`. */
  detail: string;
  /**
   * True when this restates something already on the board.
   *
   * A value change reprices questions that have been scored; a change to the overtime rules does not
   * touch anything until overtime. The distinction decides how loud the confirmation is.
   */
  affectsRecordedScoring: boolean;
}

/**
 * A complete, applied-or-not correction to the game's definition.
 *
 * Every field except `events` is optional and absent means unchanged. `events` is always present,
 * because every correction has to say what it did to the history even when the answer is "nothing" —
 * a caller that had to distinguish "no event changes" from "I forgot" would eventually get it wrong
 * in the direction that loses a game.
 */
export interface IGameCorrection {
  /** The history, rewritten where the correction needed it. Identical to the input otherwise. */
  events: ScoreEvent[];
  format?: IScorekeeperFormat;
  procedure?: IRoomProcedure;
  /** Team and player names as the game is scored against them. */
  setup?: IGameSetup;
  /**
   * QBJ player ids, re-keyed when a name changed.
   *
   * Carried through corrections rather than rebuilt, so a renamed player keeps the identity the
   * tournament assigned them and a result stays reconcilable by lookup. See `IQbjIdentity`.
   */
  playerIds?: Record<string, string>;
  changes: ICorrectionChange[];
  /**
   * What the audit note in the history will say.
   *
   * A result whose rules were repriced or whose roster was renamed mid-game and says nothing about
   * it looks, to whoever imports it on Monday, exactly like one scored wrong.
   */
  summary: string;
  /**
   * The history as it stood before the correction, so a refused write can be undone.
   *
   * The two halves of a correction — the rewritten history and the corrected definition — go to two
   * different storages, and the second can be refused after the first has been accepted. What is
   * left then is a journal whose buzzes point at positions only the definition that was refused
   * has: a game silently mis-scored from the next reload onwards, with the correction's own note in
   * the history claiming it was fixed.
   *
   * Nothing about a rewritten array says where it came from, so the way back has to travel with it.
   * Supplied by the scorer, which is the only thing that still holds the "before"; consumed by
   * whoever performs the write. The audit note deliberately does *not* appear on it — a game that
   * was not corrected must not come back carrying a note saying it was.
   */
  previousEvents: ScoreEvent[];
  /**
   * The rosters as they stood before, present only when the correction rewrote them.
   *
   * A name correction rewrites the history *and* the setup the events refer to, in one journal
   * write. Putting only the history back would leave buzzes naming players who are on no roster,
   * which is the exact shape `validateScoresheet` refuses and no dialog can undo.
   */
  previousSetup?: IGameSetup;
}

/**
 * A correction as the scorer assembles it, before the "before" is attached.
 *
 * The producers — `correctFormat`, `procedureCorrection`, `identityCorrection` — describe the
 * change they want; only the scorer knows the history and rosters that change is being made
 * against. Splitting the two keeps every producer honest about which of them it is, and makes
 * "forgot to send `previousEvents`" a compile error rather than a silent loss of the way back.
 */
export type IProposedGameCorrection = Omit<IGameCorrection, 'previousEvents' | 'previousSetup'>;

/**
 * A correction this device would not write, with a sentence the room can act on.
 *
 * Distinguished from anything else thrown so the dialog can show the reason without rendering
 * arbitrary error text: this application redacts error strings everywhere else it displays one
 * (see `ErrorLog` and `redact`). The permission is explicit, and anything else falls back to the
 * dialog's own wording.
 */
export class GameCorrectionRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameCorrectionRefusal';
  }
}

/**
 * One line for a plain field that moved, or nothing when it did not.
 *
 * Shared because three correction modules were each about to write their own, and three
 * near-identical renderings of "before → after" is three chances for one of them to say `undefined`.
 */
export function describeChange(
  changes: ICorrectionChange[],
  subject: string,
  before: string | number | boolean | undefined,
  after: string | number | boolean | undefined,
  affectsRecordedScoring = false,
): void {
  if (before === after) return;
  const say = (value: string | number | boolean | undefined) => {
    if (value === undefined) return 'not set';
    if (value === true) return 'on';
    if (value === false) return 'off';
    return String(value);
  };
  changes.push({ subject, detail: `${say(before)} → ${say(after)}`, affectsRecordedScoring });
}

/** `Timeouts: 1 → 2; Substitutions: at a break → any boundary`. */
export function correctionSummary(changes: readonly ICorrectionChange[]): string {
  return changes.map((change) => `${change.subject}: ${change.detail}`).join('; ');
}

/**
 * What every correction writes into the history, and what recognizes one afterwards.
 *
 * A note rather than an event type of its own, because `Match.notes` is the channel a correction has
 * to survive in anyway — see `toQbjMatch` — and a second audit log beside the one that already
 * travels would be two records of one thing, only one of which reaches whoever imports the result.
 *
 * The prefix is what makes the note recognizable rather than merely readable. Game details lists the
 * interventions a game has had, and picking them out by looking for the word "corrected" in free
 * text would find a scorekeeper's own note about a corrected pronunciation.
 */
export const correctionNotePrefix = 'Correction —';

/** `Correction — Team name: Ninety Six → Ninety Six A`. */
export function correctionNote(what: string): string {
  return `${correctionNotePrefix} ${what}`;
}

/** Whether this note is one a correction wrote. */
export function isCorrectionNote(text: string): boolean {
  return text.startsWith(correctionNotePrefix);
}

/** The correction's own sentence, without the marker, for a banner that has already said as much. */
export function correctionSentence(note: string): string {
  return note.startsWith(correctionNotePrefix) ? note.slice(correctionNotePrefix.length).trim() : note;
}
