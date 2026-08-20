/**
 * What is in the Game menu, given the game.
 *
 * # Why this is a function and not part of the component
 *
 * The menu is where nearly every infrequent action lives, so it is the part of the scorer that gains
 * an entry most often — and it was 150 lines in the middle of a 2,500-line component, which made
 * "does a timed format that has already ended regulation still offer End regulation?" a question
 * nobody could answer without rendering the whole scoresheet.
 *
 * Pulled out, it is an ordinary pure function of the game's state, and every one of those questions
 * is a unit test. Nothing here reads React state, opens a dialog, or records an event; it decides
 * what may be offered and hands back the callbacks it was given.
 *
 * # One menu, one level, grouped by rules
 *
 * The grouping is carried by `IGameMenuItem.dividerBefore` rather than by headings or nesting; see
 * `joinMenuGroups`. What is deliberately not here is Protests and Issue, both of which are reached
 * from Flag — a permanent footer control beside this one, and a live-play action with two entry
 * points is a live-play action a scorekeeper has to choose between under time pressure.
 *
 * # Absent, not disabled
 *
 * An action the host cannot perform is left out entirely rather than shown greyed. A room scoring
 * from a file has no tournament control to send a partial QBJ to, and an entry it can never use is
 * an entry it has to read past every time. `disabled` is reserved for what is unavailable *now* —
 * chiefly during a submission — which is a different statement and reads as one.
 */
import { IGameMenuItem, joinMenuGroups } from './GameMenu';
import { IDerivedGame, ScoringPhase } from '../scoring/deriveGame';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import {
  IRoomProcedure,
  roomBreakDue,
  roomBreakLabel,
  roomBreaksAreScheduled,
  roomMayBreakNow,
  roomTakesBreaks,
} from '../scoring/RoomProcedure';
import { ScoreEvent } from '../scoring/ScoreEvents';

/** Which dialog an entry opens. The scorer's own `OpenDialog`, named here so this file is honest. */
export type MenuDialog =
  | 'notes'
  | 'details'
  | 'lightning'
  | 'timeout'
  | 'adjust'
  | 'recovery'
  | 'end-early'
  | 'forfeit'
  | 'scoring-rules';

export interface IScorerMenuInput {
  game: IDerivedGame;
  format: IScorekeeperFormat;
  phase: ScoringPhase;
  procedure: IRoomProcedure | undefined;
  /** The question on screen, which is not always the last one played. See `lastPlayedQuestion`. */
  currentQuestion: number;
  /** The last tossup with anything recorded against it. A displayed question is not a read one. */
  lastPlayed: number;
  keyboardEnabled: boolean;
  /** True while a submission is in flight, when nothing about the game may change. */
  submitting: boolean;
  /** Present only when the host can deliver a mid-game or legacy QBJ. */
  canDownloadForms: boolean;
  /** Present only when the host can persist corrected scoring rules. See `formatCorrection`. */
  canCorrectScoringRules: boolean;

  openDialog: (dialog: MenuDialog) => void;
  setKeyboardEnabled: (enabled: boolean) => void;
  record: (event: ScoreEvent) => boolean;
  newEventId: () => string;
  openReview: () => void;
  openReplacement: (questionNumber: number) => void;
  downloadQbjBackup: () => void;
  downloadPartialQbj: () => void;
  downloadLegacyQbj: () => void;
  print: () => void;
}

export default function scorerMenuItems(input: IScorerMenuInput): IGameMenuItem[] {
  const {
    game,
    format,
    phase,
    procedure,
    currentQuestion,
    lastPlayed,
    keyboardEnabled,
    submitting,
    canDownloadForms,
    canCorrectScoringRules,
    openDialog,
    setKeyboardEnabled,
    record,
    newEventId,
    openReview,
    openReplacement,
    downloadQbjBackup,
    downloadPartialQbj,
    downloadLegacyQbj,
    print,
  } = input;

  const general: IGameMenuItem[] = [
    {
      // Named for what it does rather than for the state it is in, and stating the current state
      // after it, because a menu entry that reads "Keyboard scoring" tells nobody whether it is on.
      label: keyboardEnabled ? 'Keyboard scoring: on' : 'Keyboard scoring: off',
      icon: 'game',
      onSelect: () => setKeyboardEnabled(!keyboardEnabled),
    },
    { label: 'Notes', icon: 'note', onSelect: () => openDialog('notes'), disabled: submitting },
    { label: 'Game details', icon: 'details', onSelect: () => openDialog('details') },
  ];

  /** Things that move the round along. Only ever what this format and this moment actually allow. */
  const round: IGameMenuItem[] = [];
  if (format.lightning.enabled) {
    round.push({
      label: 'Lightning / worksheet',
      icon: 'lightning',
      onSelect: () => openDialog('lightning'),
      disabled: submitting,
    });
  }
  if ((procedure?.timeoutsPerTeam ?? 0) > 0 && phase.kind !== 'complete' && phase.kind !== 'timeout') {
    round.push({ label: 'Timeout', icon: 'clock', onSelect: () => openDialog('timeout'), disabled: submitting });
  }
  if (phase.kind === 'timeout') {
    round.push({
      label: 'Resume play',
      icon: 'play',
      onSelect: () => record({ id: newEventId(), type: 'timeout-resume', questionNumber: currentQuestion }),
      disabled: submitting,
    });
  }
  if (roomTakesBreaks(procedure) && phase.kind !== 'complete' && !game.awaitingScoreCheck) {
    // A scheduled room is only offered the break it actually owes; an unscheduled `halves` room keeps
    // the moderator-chosen break it has always had. Offering "End this half" to a room whose
    // procedure says "after tossup 5, 10 and 15" would be offering it a break nobody scheduled.
    const due = roomBreakDue(procedure, game.halfBreaks, lastPlayed);
    if (roomMayBreakNow(procedure, game.halfBreaks, lastPlayed)) {
      round.push({
        label: roomBreaksAreScheduled(procedure)
          ? `${roomBreakLabel(procedure, due)} · after tossup ${due?.afterTossup}`
          : `End ${game.halfBreaks.length === 0 ? 'first' : 'this'} half`,
        icon: 'pause',
        // The boundary is the last tossup actually played, not the one on screen. A displayed
        // question with nothing recorded against it has not been read.
        onSelect: () =>
          record({ id: newEventId(), type: 'half-break', questionNumber: currentQuestion, lastQuestion: lastPlayed }),
        disabled: submitting,
      });
    }
  }
  if (format.regulation.timed && !game.regulationComplete && phase.kind !== 'complete') {
    round.push({
      label: 'End regulation',
      icon: 'pause',
      /*
       * `lastRegulationQuestion` is the fix for the boundary being one out. Q18 finishes, Q19
       * appears, the horn goes before anybody reads it: the last regulation question is 18, and
       * recording 19 would make the first overtime tossup count as regulation.
       */
      onSelect: () =>
        record({
          id: newEventId(),
          type: 'end-regulation',
          questionNumber: currentQuestion,
          lastRegulationQuestion: lastPlayed,
        }),
      disabled: submitting,
    });
  }

  /** Going back over what is already written. */
  const review: IGameMenuItem[] = [
    { label: 'Full scoresheet review', icon: 'review', onSelect: openReview, disabled: submitting },
  ];
  if (phase.kind === 'tossup' || phase.kind === 'bonus') {
    review.push({
      label: `Replace question ${phase.questionNumber}`,
      icon: 'replace',
      onSelect: () => openReplacement(phase.questionNumber),
      disabled: submitting,
    });
  }
  review.push({ label: 'Adjust score', icon: 'adjust', onSelect: () => openDialog('adjust'), disabled: submitting });
  if (canCorrectScoringRules) {
    // Filed under review rather than under the game's own details because that is what it is: a
    // correction to something already written down, in the same group as replacing a question.
    review.push({
      label: 'Correct scoring rules…',
      icon: 'adjust',
      onSelect: () => openDialog('scoring-rules'),
      disabled: submitting,
    });
  }

  /** Getting the game off this device, or back on to it. */
  const file: IGameMenuItem[] = [{ label: 'Download QBJ backup', icon: 'download', onSelect: downloadQbjBackup }];
  if (canDownloadForms) {
    // The mid-game portable copy. Not a substitute for local recovery, which keeps the event
    // history this cannot represent; see `docs/QBJ_ASSIGNMENT_PROFILE.md`.
    file.push({ label: 'Download current QBJ', icon: 'download', onSelect: downloadPartialQbj });
    file.push({ label: 'Download legacy match-only QBJ', icon: 'download', onSelect: downloadLegacyQbj });
  }
  file.push({ label: 'Recover from QBJ', icon: 'upload', onSelect: () => openDialog('recovery'), disabled: submitting });
  /*
   * Filed with the other ways a game leaves this device, because that is what it is — the one that
   * needs no file, no network, and no working battery on the other end.
   *
   * The browser's own print dialog rather than a preview screen of our own: it is the one a school
   * Chromebook is already configured for, including whichever printer the building has.
   */
  file.push({ label: 'Print scoresheet', icon: 'review', onSelect: print });

  /** The two that end a game. Last, and behind their own rule. */
  const ending: IGameMenuItem[] = [];
  if (phase.kind !== 'complete' && game.tossupsRead > 0) {
    ending.push({
      label: 'End game early…',
      icon: 'stop',
      onSelect: () => openDialog('end-early'),
      destructive: true,
      disabled: submitting,
    });
  }
  if (phase.kind !== 'complete') {
    ending.push({
      label: 'Record forfeit',
      icon: 'forfeit',
      onSelect: () => openDialog('forfeit'),
      destructive: true,
      disabled: submitting,
    });
  }

  return joinMenuGroups([general, round, review, file, ending]);
}
