/**
 * @vitest-environment jsdom
 */

/**
 * Scoring from a picture of the table.
 *
 * The claim this file protects is that the table is a *layout*. A ruling recorded by tapping a
 * rectangle has to be indistinguishable — in the event journal, in the score, in the phase the game
 * moves to, in what undo takes back — from the same ruling recorded by pressing a button on a row.
 * If any test here had to reach for a different event type, a different callback, or a second copy
 * of a quiz bowl rule, the feature would have been built wrong.
 *
 * Which layout is on screen, and how it is chosen, is `ScoringLayout`'s subject rather than this
 * one's.
 *
 * The two halves are deliberate. The first renders the component on its own, which is the only way
 * to ask what happens when the engine *refuses* a ruling — through the real scoresheet the chairs
 * that would produce a refusal are already inert. The second drives the real scorer, because
 * everything about seating, side mapping, the keyboard and undo is a claim about the whole screen.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import { IDerivedTeam } from '../src/scoring/deriveGame';
import { LeftOrRight } from '../src/scoring/types';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';
import AnswerType from './AnswerType';
import TableView from '../src/scorer/TableView';
import ScorerHost from '../src/scorer/ScorerHost';
import { RoomConnectionState } from '../src/app/ConnectionState';
import { loadGame } from '../src/scorer/GameSession';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import { loadSeating } from '../src/scorer/PlayerSeating';
import {
  resetScoringView,
  saveScoringView,
  saveTableOrientation,
  TableOrientation,
} from '../src/scorer/scoringViewPreference';
import { rememberScoringLayoutChoice, resetScoringLayoutPrompts } from '../src/scorer/scoringLayoutPrompt';
import { resetKeyboardPreference, saveKeyboardEnabled } from '../src/scorer/keyboardPreference';

function installLocalStorage(): void {
  let store: Record<string, string> = {};
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = String(value);
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    },
  });
}

function installDialogMethods(): void {
  if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
  }
  if (typeof HTMLDialogElement.prototype.close !== 'function') {
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
  }
}

beforeEach(() => {
  installLocalStorage();
  installDialogMethods();
  saveKeyboardEnabled(false);
  resetKeyboardPreference();
  saveScoringView('scoresheet');
  saveTableOrientation('across');
  resetScoringView();
  resetScoringLayoutPrompts();
});

afterEach(() => {
  cleanup();
  saveScoringView('scoresheet');
  saveTableOrientation('across');
  resetScoringView();
  saveKeyboardEnabled(false);
  resetKeyboardPreference();
});

/* ------------------------------------------------------------------ shared */

/** Every chair on one team's table, left to right. */
function chairs(teamName: string): string[] {
  return Array.from(screen.getByLabelText(teamName).querySelectorAll('.scorer-table-player-name'), (node) =>
    (node.textContent ?? '').trim(),
  );
}

function seatNumbers(teamName: string): string[] {
  return Array.from(screen.getByLabelText(teamName).querySelectorAll('.scorer-table-player-seat'), (node) =>
    (node.textContent ?? '').trim(),
  );
}

function chair(teamName: string, playerName: string): HTMLElement {
  return within(screen.getByLabelText(teamName)).getByRole('button', { name: playerName });
}

function openPicker(teamName: string, playerName: string): HTMLElement {
  fireEvent.click(chair(teamName, playerName));
  return screen.getByRole('dialog', { name: new RegExp(`Ruling for ${playerName}`) });
}

/** The values a picker is offering, as they are drawn. */
function pickerValues(): string[] {
  const picker = screen.getByRole('dialog');
  return Array.from(picker.querySelectorAll('.scorer-ruling-choice-value'), (node) =>
    (node.textContent ?? '').trim(),
  );
}

/* ------------------------------------------- the component on its own */

const noOpProps = {
  scoringEnabled: true,
  sideLayoutKey: 'left',
  eligible: () => true,
  negsAvailable: () => true,
};

function derivedTeam(name: string, players: string[], points = 0): IDerivedTeam {
  return {
    name,
    points,
    tossupPoints: points,
    bonusPoints: 0,
    bonusBouncebackPoints: 0,
    lightningPoints: 0,
    adjustmentPoints: 0,
    bonusesHeard: 0,
    players: players.map((playerName) => ({
      name: playerName,
      tossupsHeard: 0,
      answerCounts: new Map<number, number>(),
      points: 0,
    })),
    activePlayers: players.slice(),
    forfeited: false,
    overtimeBuzzes: new Map<number, number>(),
  };
}

function formatWithValues(values: number[]): IScorekeeperFormat {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.answerTypes = values.map((value) => new AnswerType(value));
  return scoringRulesToScorekeeperFormat(rules);
}

function renderTable(
  options: {
    format?: IScorekeeperFormat;
    left?: string[];
    right?: string[];
    onBuzz?: (side: LeftOrRight, playerName: string, answerType: { index: number }) => boolean;
    onWrongNoPenalty?: (side: LeftOrRight, playerName: string) => boolean;
    eligible?: (side: LeftOrRight) => boolean;
    negsAvailable?: (side: LeftOrRight) => boolean;
    scoringEnabled?: boolean;
  } = {},
) {
  const format = options.format ?? formatWithValues([15, 10, -5]);
  const teams = {
    left: derivedTeam('Ninety Six', options.left ?? ['Gibson', 'Maycie', 'Jeremy', 'Adam']),
    right: derivedTeam('Greenwood', options.right ?? ['Emma', 'Taylor']),
  };
  const seatedPlayers = {
    left: teams.left.activePlayers,
    right: teams.right.activePlayers,
  };
  return render(
    <TableView
      format={format}
      teams={teams}
      seatedPlayers={seatedPlayers}
      scoringEnabled={options.scoringEnabled ?? noOpProps.scoringEnabled}
      eligible={options.eligible ?? noOpProps.eligible}
      negsAvailable={options.negsAvailable ?? noOpProps.negsAvailable}
      sideLayoutKey={noOpProps.sideLayoutKey}
      onBuzz={options.onBuzz ?? (() => true)}
      onWrongNoPenalty={options.onWrongNoPenalty ?? (() => true)}
    />,
  );
}

describe('the chairs', () => {
  test('only players on the floor get one, and there are no empty seats', () => {
    renderTable({ left: ['Gibson', 'Maycie', 'Jeremy'] });

    expect(chairs('Ninety Six')).toEqual(['Gibson', 'Maycie', 'Jeremy']);
    expect(seatNumbers('Ninety Six')).toEqual(['1', '2', '3']);
    // The format allows four. A fourth rectangle with nobody in it is a buzz waiting to be recorded
    // against nobody.
    expect(chairs('Ninety Six')).toHaveLength(3);
  });

  test('nothing here assumes four to a side', () => {
    renderTable({ left: ['A', 'B', 'C', 'D', 'E', 'F'], right: ['Solo'] });

    expect(chairs('Ninety Six')).toHaveLength(6);
    expect(seatNumbers('Ninety Six')).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(chairs('Greenwood')).toEqual(['Solo']);
  });

  test('a long name is truncated on screen but reachable in full', () => {
    const long = 'Bartholomew Fitzwilliam-Harrington';
    renderTable({ left: [long] });

    // The accessible name is the whole thing, and so is the tooltip.
    expect(chair('Ninety Six', long)).toBeTruthy();
    const name = screen.getByLabelText('Ninety Six').querySelector('.scorer-table-player-name');
    expect(name?.getAttribute('title')).toBe(long);
  });
});

describe('the ruling picker', () => {
  test('it opens against the chair that was pressed, and there is only ever one', () => {
    renderTable();

    const picker = openPicker('Ninety Six', 'Maycie');

    expect(picker).toBeTruthy();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(chair('Ninety Six', 'Maycie').getAttribute('aria-expanded')).toBe('true');
    expect(chair('Ninety Six', 'Gibson').getAttribute('aria-expanded')).toBe('false');
  });

  test('choosing another player moves it rather than adding a second', () => {
    renderTable();
    openPicker('Ninety Six', 'Maycie');

    openPicker('Ninety Six', 'Jeremy');

    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toContain('Jeremy');
  });

  test('pressing the same chair again closes it', () => {
    renderTable();
    openPicker('Ninety Six', 'Maycie');

    fireEvent.click(chair('Ninety Six', 'Maycie'));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('Escape closes it and puts the scorekeeper back on the chair they opened', () => {
    renderTable();
    openPicker('Ninety Six', 'Maycie');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(chair('Ninety Six', 'Maycie'));
  });

  test('a press anywhere else closes it', () => {
    renderTable();
    openPicker('Ninety Six', 'Maycie');

    // The picker watches `pointerdown`, the one event a mouse press and a touch both raise once.
    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('the first ruling takes focus, which is what keeps the global keyboard out of it', () => {
    renderTable();
    const picker = openPicker('Ninety Six', 'Maycie');

    // `keystrokeBelongsToControl` asks whether the active element is inside a dialog. This is why a
    // seat number pressed over an open picker cannot score the player behind it.
    expect(picker.contains(document.activeElement)).toBe(true);
  });
});

describe('the rulings it offers', () => {
  test('they come from the format, in the order the format lists them', () => {
    renderTable({ format: formatWithValues([20, 15, 10, -5, -10]) });

    openPicker('Ninety Six', 'Gibson');

    // The zero is last and is not one of the format's answer types; see `tossupChoices`.
    expect(pickerValues()).toEqual(['+20', '+15', '+10', '−5', '−10', '0']);
  });

  test('a format with one positive answer and no penalty offers exactly those', () => {
    renderTable({ format: formatWithValues([10]) });

    openPicker('Ninety Six', 'Gibson');

    expect(pickerValues()).toEqual(['+10', '0']);
  });

  test('the negatives disappear when a neg is no longer legal, exactly as the buttons do', () => {
    renderTable({ negsAvailable: () => false });

    openPicker('Ninety Six', 'Gibson');

    expect(pickerValues()).toEqual(['+15', '+10', '0']);
  });

  test('the zero calls the no-penalty route rather than inventing an answer type', () => {
    const onBuzz = vi.fn().mockReturnValue(true);
    const onWrongNoPenalty = vi.fn().mockReturnValue(true);
    renderTable({ onBuzz, onWrongNoPenalty });

    openPicker('Ninety Six', 'Gibson');
    fireEvent.click(screen.getByRole('button', { name: 'Gibson 0 wrong, no penalty' }));

    expect(onWrongNoPenalty).toHaveBeenCalledWith('left', 'Gibson');
    expect(onBuzz).not.toHaveBeenCalled();
  });

  test('a ruling names the side it was chosen on, so the caller can map it back', () => {
    const onBuzz = vi.fn().mockReturnValue(true);
    renderTable({ onBuzz });

    openPicker('Greenwood', 'Taylor');
    fireEvent.click(screen.getByRole('button', { name: 'Taylor 15' }));

    expect(onBuzz).toHaveBeenCalledWith('right', 'Taylor', expect.objectContaining({ value: 15 }));
  });
});

describe('what happens after a ruling', () => {
  test('an accepted ruling closes the picker and marks the chair it landed in', () => {
    renderTable();
    openPicker('Ninety Six', 'Maycie');

    fireEvent.click(screen.getByRole('button', { name: 'Maycie 10' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(chair('Ninety Six', 'Maycie').className).toContain('is-recorded');
    expect(chair('Ninety Six', 'Maycie').getAttribute('data-ruling-token')).toBe('1');
  });

  test('a neg gets the neg treatment rather than the ordinary one', () => {
    renderTable();
    openPicker('Ninety Six', 'Maycie');

    fireEvent.click(screen.getByRole('button', { name: 'Maycie -5' }));

    expect(chair('Ninety Six', 'Maycie').className).toContain('is-neg-recorded');
  });

  test('a ruling the engine refused still closes the picker and celebrates nothing', () => {
    renderTable({ onBuzz: () => false });
    openPicker('Ninety Six', 'Maycie');

    fireEvent.click(screen.getByRole('button', { name: 'Maycie 10' }));

    // One press is one decision: leaving it open is how the same press happens twice.
    expect(screen.queryByRole('dialog')).toBeNull();
    // And nothing pretends a tossup was scored.
    expect(chair('Ninety Six', 'Maycie').className).not.toContain('is-recorded');
    expect(chair('Ninety Six', 'Maycie').hasAttribute('data-ruling-token')).toBe(false);
  });

  test('consecutive rulings are consecutive events rather than one stale one', () => {
    renderTable();
    openPicker('Ninety Six', 'Maycie');
    fireEvent.click(screen.getByRole('button', { name: 'Maycie 10' }));
    openPicker('Greenwood', 'Emma');
    fireEvent.click(screen.getByRole('button', { name: 'Emma 10' }));

    expect(chair('Greenwood', 'Emma').getAttribute('data-ruling-token')).toBe('2');
  });
});

describe('chairs that cannot be pressed', () => {
  test('a team that has answered goes inert without disappearing', () => {
    renderTable({ eligible: (side) => side !== 'left' });

    const inert = chair('Ninety Six', 'Gibson');
    expect(inert.hasAttribute('disabled')).toBe(true);
    expect(inert.className).toContain('is-disabled');
    // Still on the table, still readable, still where it was.
    expect(chairs('Ninety Six')).toEqual(['Gibson', 'Maycie', 'Jeremy', 'Adam']);
    // And the other team is untouched.
    expect(chair('Greenwood', 'Emma').hasAttribute('disabled')).toBe(false);
  });

  test('no live tossup means no chair can open a ruling', () => {
    renderTable({ scoringEnabled: false });

    expect(chair('Ninety Six', 'Gibson').hasAttribute('disabled')).toBe(true);
    fireEvent.click(chair('Ninety Six', 'Gibson'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

/* --------------------------------------------- the real scoresheet */

const leftTeam = {
  name: 'Ninety Six',
  players: [{ name: 'Gibson' }, { name: 'Maycie' }, { name: 'Jeremy' }, { name: 'Phillip' }],
};
const rightTeam = { name: 'Greenwood', players: [{ name: 'Emma' }, { name: 'Taylor' }] };

let gameCounter = 0;
let gameKey = '';

function scorerFormat(maximumActive = 4): IScorekeeperFormat {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.maximumPlayersPerTeam = maximumActive;
  return scoringRulesToScorekeeperFormat(rules);
}

/**
 * The scoresheet, in the table layout, with a roster that needs no starting-lineup prompt.
 *
 * Four on the floor out of four on the roster is the ordinary case and also the awkward one: nothing
 * ever asks the room what order they are sitting in, which is exactly why the arrangement hint
 * exists. Tests that need a bench pass a bigger roster.
 */
function renderScorer(
  options: {
    view?: 'table' | 'scoresheet';
    left?: { name: string; players: { name: string }[] };
    maximumActive?: number;
    onCorrectGame?: (correction: unknown) => void | Promise<void>;
    keyboard?: boolean;
    onDownload?: (qbj: object) => void;
    orientation?: TableOrientation;
  } = {},
) {
  gameCounter += 1;
  gameKey = `table-view-game-${gameCounter}`;
  saveScoringView(options.view ?? 'table');
  saveTableOrientation(options.orientation ?? 'across');
  resetScoringView();
  /*
   * Answered already.
   *
   * Every genuinely new game opens with the layout question — `ScoringLayout` is the file about
   * that — and nothing below is about it. A device that has already been asked is what the rest of
   * this file needs, and it keeps a modal from standing in front of the table.
   */
  rememberScoringLayoutChoice(gameKey);
  if (options.keyboard) {
    saveKeyboardEnabled(true);
    resetKeyboardPreference();
  }
  render(
    <ScorerHost
      gameKey={gameKey}
      format={scorerFormat(options.maximumActive)}
      leftTeam={options.left ?? leftTeam}
      rightTeam={rightTeam}
      tournamentName="Ninety Six Invitational"
      roundName="Round 4"
      connection={RoomConnectionState.Connected}
      onDownload={options.onDownload ?? (() => undefined)}
      onCorrectGame={options.onCorrectGame}
      onSubmit={vi.fn().mockResolvedValue({ ok: true, message: 'Sent' })}
    />,
  );
  return gameKey;
}

function savedEvents(): ScoreEvent[] {
  return loadGame(gameKey)?.events ?? [];
}

function ruling(playerName: string, label: string): void {
  fireEvent.click(screen.getByRole('button', { name: `${playerName} ${label}` }));
}

function openGameMenu(): void {
  fireEvent.click(screen.getByText('Game'));
}

/** One seat's drag handle, while the table is being arranged. */
function seatHandle(teamName: string, playerName: string): HTMLElement {
  return within(screen.getByLabelText(teamName)).getByRole('button', {
    name: new RegExp(`^${playerName}, seat `),
  });
}

/**
 * Give the seats the geometry jsdom will not.
 *
 * The drag measures one seat's width from the seats themselves, and every rectangle in jsdom is zero
 * by zero. What this file can prove is the wiring — that a gesture of this many seats commits that
 * order and writes no event — and `e2e/TableArrange.spec.ts` proves the gesture itself in a browser
 * that has real pointers and real layout.
 */
const seatWidth = 120;

function stubSeatGeometry(teamName: string, orientation: TableOrientation = 'across'): void {
  const seats = Array.from(
    screen.getByLabelText(teamName).querySelectorAll<HTMLElement>('.scorer-table-seat'),
  );
  seats.forEach((seat, index) => {
    const along = index * seatWidth;
    seat.getBoundingClientRect = () =>
      (orientation === 'across'
        ? {
            x: along,
            y: 0,
            left: along,
            right: along + seatWidth,
            top: 0,
            bottom: seatWidth,
            width: seatWidth,
            height: seatWidth,
            toJSON: () => ({}),
          }
        : {
            x: 0,
            y: along,
            left: 0,
            right: seatWidth,
            top: along,
            bottom: along + seatWidth,
            width: seatWidth,
            height: seatWidth,
            toJSON: () => ({}),
          }) as DOMRect;
  });
}

/**
 * A pointer event that actually carries a coordinate.
 *
 * jsdom has no `PointerEvent`, and Testing Library's fallback constructor drops `clientX` on the
 * floor — which makes every drag a drag of zero pixels. A `MouseEvent` named for the pointer event
 * carries the one property this gesture reads.
 */
function pointerEvent(type: string, along: number, orientation: TableOrientation): MouseEvent {
  const coordinates =
    orientation === 'across' ? { clientX: along, clientY: 0 } : { clientX: 0, clientY: along };
  return new MouseEvent(type, { ...coordinates, bubbles: true, cancelable: true });
}

/** Carry a player `seats` places along their own table and let go. */
function dragPlayer(
  teamName: string,
  playerName: string,
  seats: number,
  orientation: TableOrientation = 'across',
): void {
  const handle = seatHandle(teamName, playerName);
  stubSeatGeometry(teamName, orientation);
  const travel = seats * seatWidth;
  fireEvent(handle, pointerEvent('pointerdown', 500, orientation));
  fireEvent(window, pointerEvent('pointermove', 500 + travel, orientation));
  fireEvent(window, pointerEvent('pointerup', 500 + travel, orientation));
}

/** The strip above the scoring surface, which is where the layout is chosen now. */
function switchLayout(to: 'Scoresheet' | 'Table'): void {
  fireEvent.click(screen.getByRole('radio', { name: to }));
}

describe('a ruling recorded from the table', () => {
  test('it is the ordinary tossup event, against the right player and the right team', () => {
    renderScorer();

    openPicker('Ninety Six', 'Maycie');
    ruling('Maycie', '10');

    const buzz = savedEvents().find((event) => event.type === 'tossup-buzz');
    expect(buzz).toMatchObject({ type: 'tossup-buzz', team: 'left', playerName: 'Maycie' });
    expect(screen.getByLabelText('Ninety Six score').textContent).toBe('10');
  });

  test('a converted tossup goes on to the ordinary bonus prompt', () => {
    renderScorer();

    openPicker('Ninety Six', 'Maycie');
    ruling('Maycie', '10');

    expect(screen.getByLabelText('Bonus')).toBeTruthy();
  });

  test('a power is the format’s own top tier and nothing invented', () => {
    renderScorer();

    openPicker('Ninety Six', 'Gibson');
    ruling('Gibson', '15');

    expect(savedEvents().find((event) => event.type === 'tossup-buzz')).toMatchObject({
      answerTypeIndex: 0,
    });
    expect(screen.getByLabelText('Ninety Six score').textContent).toBe('15');
  });

  test('a zero is `tossup-no-penalty` and creates no answer type at all', () => {
    renderScorer();

    openPicker('Ninety Six', 'Gibson');
    fireEvent.click(screen.getByRole('button', { name: 'Gibson 0 wrong, no penalty' }));

    expect(savedEvents().some((event) => event.type === 'tossup-no-penalty')).toBe(true);
    expect(savedEvents().some((event) => event.type === 'tossup-buzz')).toBe(false);
    expect(screen.getByLabelText('Ninety Six score').textContent).toBe('0');
  });

  test('a neg leaves the other team able to answer, and the negging team unable to', () => {
    renderScorer();

    openPicker('Ninety Six', 'Gibson');
    ruling('Gibson', '-5');

    expect(chair('Ninety Six', 'Maycie').hasAttribute('disabled')).toBe(true);
    expect(chair('Greenwood', 'Emma').hasAttribute('disabled')).toBe(false);
    expect(screen.getByLabelText('Ninety Six score').textContent).toBe('-5');
  });

  test('the team answering second is offered no neg, because it heard the whole question', () => {
    renderScorer();
    openPicker('Ninety Six', 'Gibson');
    ruling('Gibson', '-5');

    openPicker('Greenwood', 'Emma');

    expect(pickerValues()).toEqual(['+15', '+10', '0']);
  });

  test('undo takes it back, and redo puts it back, from the same stack as everything else', () => {
    renderScorer();
    openPicker('Ninety Six', 'Maycie');
    ruling('Maycie', '10');
    expect(screen.getByLabelText('Ninety Six score').textContent).toBe('10');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByLabelText('Ninety Six score').textContent).toBe('0');
    expect(savedEvents().some((event) => event.type === 'tossup-buzz')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(screen.getByLabelText('Ninety Six score').textContent).toBe('10');
  });
});

describe('the picker and the state of the game', () => {
  test('a phase that stops allowing tossups takes the picker with it', () => {
    renderScorer();
    // Open one picker, score from another chair through the keyboard-free route, and the game moves
    // to a bonus — at which point nothing on the table can be ruled on.
    openPicker('Ninety Six', 'Maycie');
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Maycie 10' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(chair('Ninety Six', 'Gibson').hasAttribute('disabled')).toBe(true);
  });

  test('opening one of the scorer’s own dialogs takes it too', () => {
    renderScorer();
    openPicker('Ninety Six', 'Maycie');

    fireEvent.click(screen.getByRole('button', { name: 'Players' }));

    expect(screen.queryByRole('dialog', { name: /Ruling for/ })).toBeNull();
  });
});

describe('which team a chair belongs to', () => {
  test('swapping the sides on screen swaps the tables and not the teams', () => {
    renderScorer();
    openGameMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Game details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Swap team sides' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));

    // Greenwood is now drawn first, and a ruling there still belongs to Greenwood.
    const tables = Array.from(document.querySelectorAll('.scorer-table-team'));
    expect(tables[0].getAttribute('aria-label')).toBe('Greenwood');

    openPicker('Greenwood', 'Emma');
    ruling('Emma', '10');

    expect(savedEvents().find((event) => event.type === 'tossup-buzz')).toMatchObject({
      team: 'right',
      playerName: 'Emma',
    });
  });
});

describe('the order the chairs are in', () => {
  test('rearranging the table changes what is drawn and writes no scoring event', () => {
    renderScorer();
    openPicker('Ninety Six', 'Gibson');
    ruling('Gibson', '10');
    const before = savedEvents();

    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Jeremy left' }));

    expect(chairs('Ninety Six')).toEqual(['Gibson', 'Jeremy', 'Maycie', 'Phillip']);
    expect(savedEvents()).toEqual(before);
  });

  test('the moved chair is marked as the one that travelled', () => {
    renderScorer();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Jeremy left' }));

    const moved = screen.getByLabelText('Ninety Six').querySelector('.scorer-table-seat.is-moved');
    expect(moved?.textContent).toContain('Jeremy');
  });

  test('the ends of the table cannot be moved off it', () => {
    renderScorer();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));

    expect(screen.getByRole('button', { name: 'Move Gibson left' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Move Phillip right' }).hasAttribute('disabled')).toBe(true);
  });

  test('it is the one seat order, so the scoresheet and the keyboard follow it', () => {
    renderScorer();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Jeremy left' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done arranging' }));

    // The stored preference is the same one `TeamPanel` and `useScorerKeyboard` read.
    expect(loadSeating(gameKey).left).toEqual(['Gibson', 'Jeremy', 'Maycie', 'Phillip']);

    switchLayout('Scoresheet');
    const rows = Array.from(
      screen.getByLabelText('Ninety Six').querySelectorAll('.scorer-player-name'),
      (node) => node.textContent,
    );
    expect(rows).toEqual(['Gibson', 'Jeremy', 'Maycie', 'Phillip']);
  });

  test('a device that asked not to be moved around still knows which chair moved', () => {
    // The motion is presentation; the statement it makes is not. With transitions off, the chair the
    // scorekeeper asked for still says so, and nothing is left holding an inline transform.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    renderScorer();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Jeremy left' }));

    const table = screen.getByLabelText('Ninety Six');
    expect(table.querySelector('.scorer-table-seat.is-moved')?.textContent).toContain('Jeremy');
    expect(table.querySelector('.scorer-table-seat.is-moving')).toBeNull();
    for (const seat of Array.from(table.querySelectorAll<HTMLElement>('.scorer-table-seat'))) {
      expect(seat.style.transform).toBe('');
    }
  });

  test('a player can be carried to a different chair, and the table follows', () => {
    renderScorer();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));
    const before = savedEvents();

    dragPlayer('Ninety Six', 'Phillip', -3);

    expect(chairs('Ninety Six')).toEqual(['Phillip', 'Gibson', 'Maycie', 'Jeremy']);
    expect(seatNumbers('Ninety Six')).toEqual(['1', '2', '3', '4']);
    expect(loadSeating(gameKey).left).toEqual(['Phillip', 'Gibson', 'Maycie', 'Jeremy']);
    // The whole point: a table is furniture, and moving furniture is not scoring.
    expect(savedEvents()).toEqual(before);
  });

  test('a drag that never left its own seat is not a move', () => {
    renderScorer();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));

    dragPlayer('Ninety Six', 'Maycie', 0);

    expect(chairs('Ninety Six')).toEqual(['Gibson', 'Maycie', 'Jeremy', 'Phillip']);
    expect(loadSeating(gameKey).left).toEqual([]);
  });

  test('Escape during a drag puts everybody back where they were', () => {
    renderScorer();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));
    const handle = seatHandle('Ninety Six', 'Phillip');
    stubSeatGeometry('Ninety Six');

    fireEvent(handle, pointerEvent('pointerdown', 360, 'across'));
    fireEvent(window, pointerEvent('pointermove', 0, 'across'));
    // Carried to the front, and then abandoned.
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent(window, pointerEvent('pointerup', 0, 'across'));

    expect(chairs('Ninety Six')).toEqual(['Gibson', 'Maycie', 'Jeremy', 'Phillip']);
    // Nothing was written, because nothing is written until a drop resolves.
    expect(loadSeating(gameKey).left).toEqual([]);
  });

  test('a drag stays inside its own team, however far it is carried', () => {
    renderScorer();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));

    // Twenty seats to the right is further than the table is long, and there is another table there.
    dragPlayer('Ninety Six', 'Gibson', 20);

    expect(chairs('Ninety Six')).toEqual(['Maycie', 'Jeremy', 'Phillip', 'Gibson']);
    expect(chairs('Greenwood')).toEqual(['Emma', 'Taylor']);
    expect(loadSeating(gameKey).right).toEqual([]);
  });

  test('the arrow keys move the seat that has focus, and say where it landed', () => {
    renderScorer();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));

    fireEvent.keyDown(seatHandle('Ninety Six', 'Maycie'), { key: 'ArrowRight' });

    expect(chairs('Ninety Six')).toEqual(['Gibson', 'Jeremy', 'Maycie', 'Phillip']);
    expect(screen.getByText('Maycie is now seat 3 of 4, Ninety Six.')).toBeTruthy();
  });

  test('End carries a player to the far end of their own table in one press', () => {
    renderScorer();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));

    fireEvent.keyDown(seatHandle('Ninety Six', 'Gibson'), { key: 'End' });

    expect(chairs('Ninety Six')).toEqual(['Maycie', 'Jeremy', 'Phillip', 'Gibson']);
  });

  test('the arrows on each seat still work for a pointer that cannot drag', () => {
    renderScorer();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));

    fireEvent.click(screen.getByRole('button', { name: 'Move Jeremy left' }));

    expect(chairs('Ninety Six')).toEqual(['Gibson', 'Jeremy', 'Maycie', 'Phillip']);
  });

  test('every seat says which position it is, so a screen reader can follow the move', () => {
    renderScorer();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));

    expect(seatHandle('Ninety Six', 'Jeremy').getAttribute('aria-label')).toBe('Jeremy, seat 3 of 4');
    fireEvent.keyDown(seatHandle('Ninety Six', 'Jeremy'), { key: 'ArrowLeft' });
    expect(seatHandle('Ninety Six', 'Jeremy').getAttribute('aria-label')).toBe('Jeremy, seat 2 of 4');
  });

  test('arranging closes an open picker rather than leaving it over a moving chair', () => {
    renderScorer();
    openPicker('Ninety Six', 'Maycie');

    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));

    expect(screen.queryByRole('dialog', { name: /Ruling for/ })).toBeNull();
  });
});

describe('somebody new in a chair', () => {
  const bigRoster = {
    name: 'Ninety Six',
    players: [
      { name: 'Gibson' },
      { name: 'Maycie' },
      { name: 'Jeremy' },
      { name: 'Phillip' },
      { name: 'Adam' },
      { name: 'Chris' },
    ],
  };

  /** Answer the starting-lineup prompt the bigger roster produces. */
  function startFour(names: string[]): void {
    const prompt = screen.getByLabelText('Starting lineups');
    for (const name of names) {
      fireEvent.click(within(prompt).getByRole('button', { name: `Start ${name}` }));
    }
    fireEvent.click(within(prompt).getByText('Start game'));
  }

  test('a one-for-one substitution changes the occupant and not the chair', () => {
    renderScorer({ left: bigRoster });
    startFour(['Gibson', 'Maycie', 'Jeremy', 'Phillip']);
    const seatBefore = screen.getByLabelText('Ninety Six').querySelectorAll('.scorer-table-seat')[3];

    fireEvent.click(screen.getByRole('button', { name: 'Players' }));
    const lineup = screen.getByLabelText('Ninety Six lineup');
    const fourth = within(lineup).getByText('Phillip').closest('li') as HTMLElement;
    fireEvent.click(within(fourth).getByText('Replace'));
    fireEvent.click(within(lineup).getByText('Adam'));
    fireEvent.click(within(lineup).getByText('Confirm'));

    expect(chairs('Ninety Six')).toEqual(['Gibson', 'Maycie', 'Jeremy', 'Adam']);
    expect(seatNumbers('Ninety Six')).toEqual(['1', '2', '3', '4']);
    // The same element: the chair did not move, somebody else sat in it.
    const seatAfter = screen.getByLabelText('Ninety Six').querySelectorAll('.scorer-table-seat')[3];
    expect(seatAfter).toBe(seatBefore);
    expect(chair('Ninety Six', 'Adam').className).toContain('is-substituted');
  });

  test('a bulk change keeps the survivors where they were and says the table needs a look', () => {
    renderScorer({ left: bigRoster });
    startFour(['Gibson', 'Maycie', 'Jeremy', 'Phillip']);

    fireEvent.click(screen.getByRole('button', { name: 'Players' }));
    const lineup = screen.getByLabelText('Ninety Six lineup');
    fireEvent.click(within(lineup).getByText('Change lineup'));
    // Gibson and Maycie off, Adam and Chris on: two chairs change hands at once, and the event says
    // nothing about which of them each new player took.
    fireEvent.click(within(lineup).getByRole('button', { name: 'Bench Gibson' }));
    fireEvent.click(within(lineup).getByRole('button', { name: 'Bench Maycie' }));
    fireEvent.click(within(lineup).getByRole('button', { name: 'Put Adam in' }));
    fireEvent.click(within(lineup).getByRole('button', { name: 'Put Chris in' }));
    fireEvent.click(within(lineup).getByRole('button', { name: 'Apply lineup' }));

    // Jeremy and Phillip have not moved.
    expect(chairs('Ninety Six').slice(2)).toEqual(['Jeremy', 'Phillip']);
    expect(new Set(chairs('Ninety Six'))).toEqual(new Set(['Adam', 'Chris', 'Jeremy', 'Phillip']));
    expect(screen.getByText('Lineup changed · Check table order')).toBeTruthy();
  });

  test('the note about the table is a note, not a gate', () => {
    renderScorer({ left: bigRoster });
    startFour(['Gibson', 'Maycie', 'Jeremy', 'Phillip']);
    fireEvent.click(screen.getByRole('button', { name: 'Players' }));
    const lineup = screen.getByLabelText('Ninety Six lineup');
    fireEvent.click(within(lineup).getByText('Change lineup'));
    fireEvent.click(within(lineup).getByRole('button', { name: 'Bench Gibson' }));
    fireEvent.click(within(lineup).getByRole('button', { name: 'Bench Maycie' }));
    fireEvent.click(within(lineup).getByRole('button', { name: 'Put Adam in' }));
    fireEvent.click(within(lineup).getByRole('button', { name: 'Put Chris in' }));
    fireEvent.click(within(lineup).getByRole('button', { name: 'Apply lineup' }));

    openPicker('Ninety Six', 'Jeremy');
    ruling('Jeremy', '10');

    expect(savedEvents().find((event) => event.type === 'tossup-buzz')).toMatchObject({
      playerName: 'Jeremy',
    });
  });
});

describe('when the room has never said what order it is sitting in', () => {
  test('the table asks once, without stopping anybody scoring', () => {
    renderScorer();

    expect(screen.getByText('Match the table')).toBeTruthy();
    openPicker('Ninety Six', 'Maycie');
    ruling('Maycie', '10');
    expect(savedEvents().some((event) => event.type === 'tossup-buzz')).toBe(true);
  });

  test('confirming it writes a seating preference and nothing else', () => {
    renderScorer();
    const before = savedEvents();

    fireEvent.click(screen.getByRole('button', { name: 'This is right' }));

    expect(screen.queryByText('Match the table')).toBeNull();
    expect(loadSeating(gameKey).left).toEqual(['Gibson', 'Maycie', 'Jeremy', 'Phillip']);
    expect(savedEvents()).toEqual(before);
  });

  test('it does not come back once it has been answered', () => {
    renderScorer();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done arranging' }));

    expect(screen.queryByText('Match the table')).toBeNull();
  });

  test('it does not come back after a look at the scoresheet', () => {
    renderScorer();
    // Answered by opening the arrangement rather than by confirming, so no preference is written and
    // the underlying condition is still true. The question has still been asked and answered.
    fireEvent.click(screen.getByRole('button', { name: 'Arrange' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done arranging' }));

    switchLayout('Scoresheet');
    switchLayout('Table');

    expect(screen.queryByText('Match the table')).toBeNull();
  });

  test('a game whose lineup was chosen has been told already, and is not asked', () => {
    renderScorer({
      left: {
        name: 'Ninety Six',
        players: [{ name: 'Gibson' }, { name: 'Maycie' }, { name: 'Jeremy' }, { name: 'Phillip' }],
      },
      maximumActive: 3,
    });
    const prompt = screen.getByLabelText('Starting lineups');
    for (const name of ['Gibson', 'Maycie', 'Jeremy']) {
      fireEvent.click(within(prompt).getByRole('button', { name: `Start ${name}` }));
    }
    fireEvent.click(within(prompt).getByText('Start game'));

    expect(screen.queryByText('Match the table')).toBeNull();
  });
});

describe('a corrected name', () => {
  /** Arrange the table, then correct one of the names on it. Returns the host's spy. */
  async function correctJeremy(onCorrectGame: (correction: unknown) => void | Promise<void>) {
    renderScorer({ onCorrectGame });
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Jeremy left' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done arranging' }));
    expect(chairs('Ninety Six')).toEqual(['Gibson', 'Jeremy', 'Maycie', 'Phillip']);

    openGameMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Game details' }));
    const rosterRow = Array.from(document.querySelectorAll('.scorer-detail-row')).find(
      (row) => row.querySelector('dt')?.textContent === 'Ninety Six roster',
    ) as HTMLElement;
    fireEvent.click(within(rosterRow).getByRole('button', { name: 'Correct…' }));
    const rosterList = document.querySelector('.scorer-detail-roster') as HTMLElement;
    const entry = Array.from(rosterList.querySelectorAll('li')).find((row) =>
      row.textContent?.startsWith('Jeremy'),
    ) as HTMLElement;
    fireEvent.click(within(entry).getByText('Correct'));
    fireEvent.change(screen.getByLabelText(/Player name/), { target: { value: 'Jeremy Cole' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
  }

  test('keeps the exact chair its owner was already in', async () => {
    const host = vi.fn();
    await correctJeremy(host);

    expect(host).toHaveBeenCalled();
    // The history rewrite belongs to the host; what belongs here is the seat, and the seat has not
    // moved. Second on the table before the correction, second on the table after it.
    expect(loadSeating(gameKey).left).toEqual(['Gibson', 'Jeremy Cole', 'Maycie', 'Phillip']);
    expect(loadSeating(gameKey).left).not.toContain('Jeremy');
  });

  test('renaming a seat is not a scoring event', async () => {
    await correctJeremy(vi.fn());

    // The correction's own events are the host's to write. Nothing about the seat reached the
    // journal this device keeps.
    expect(savedEvents().some((event) => event.type === 'substitution')).toBe(false);
  });

  test('the seat follows the write rather than leading it', async () => {
    let seatingWhenTheHostWasCalled: string[] = [];
    await correctJeremy(() => {
      seatingWhenTheHostWasCalled = loadSeating(gameKey).left;
    });

    // Renaming first would leave a host that refuses the correction with a table arranged around a
    // name the roster never took — which is the exact thing this is here to prevent.
    expect(seatingWhenTheHostWasCalled).toEqual(['Gibson', 'Jeremy', 'Maycie', 'Phillip']);
    expect(loadSeating(gameKey).left).toEqual(['Gibson', 'Jeremy Cole', 'Maycie', 'Phillip']);
  });
});

describe('the keyboard, while the table is on screen', () => {
  function pressSequence(number: number, action: string): void {
    fireEvent.keyDown(document, { code: `Digit${number}`, key: String(number) });
    fireEvent.keyDown(document, { code: `Key${action.toUpperCase()}`, key: action.toLowerCase() });
  }

  test('a seat number and a ruling still score, and the chair says where it landed', () => {
    renderScorer({ keyboard: true });

    pressSequence(2, 'c');

    expect(savedEvents().find((event) => event.type === 'tossup-buzz')).toMatchObject({
      team: 'left',
      playerName: 'Maycie',
    });
    expect(chair('Ninety Six', 'Maycie').className).toContain('is-keyed');
  });

  test('an open picker keeps a seat number from scoring the chair behind it', () => {
    renderScorer({ keyboard: true });
    openPicker('Ninety Six', 'Gibson');

    // Sarah's picker is open and holds focus; `3` must not rule on the third chair behind it.
    pressSequence(3, 'c');

    expect(savedEvents().some((event) => event.type === 'tossup-buzz')).toBe(false);
    expect(screen.getByRole('dialog', { name: /Ruling for Gibson/ })).toBeTruthy();
  });

  test('Escape closes the picker without scoring anything', () => {
    renderScorer({ keyboard: true });
    openPicker('Ninety Six', 'Gibson');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: /Ruling for/ })).toBeNull();
    expect(savedEvents().some((event) => event.type === 'tossup-buzz')).toBe(false);
  });

  test('the seat a number addresses is the chair that number is drawn on', () => {
    renderScorer({ keyboard: true });
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Jeremy left' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done arranging' }));

    pressSequence(2, 'c');

    // Jeremy is in the second chair now, so `2` is Jeremy.
    expect(savedEvents().find((event) => event.type === 'tossup-buzz')).toMatchObject({
      playerName: 'Jeremy',
    });
  });
});

describe('what the table must never put in a result', () => {
  test('a QBJ written while the table is on screen carries no trace of it', () => {
    const downloaded: object[] = [];
    renderScorer({ onDownload: (qbj) => downloaded.push(qbj) });
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Jeremy left' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done arranging' }));
    openPicker('Ninety Six', 'Jeremy');
    ruling('Jeremy', '10');

    openGameMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export / backup…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download QBJ backup' }));

    expect(downloaded).toHaveLength(1);
    const text = JSON.stringify(downloaded[0]);
    // A physical seat is a fact about this room's furniture. It is not a fact about the game, and a
    // statistics package that received one would have received a fiction.
    for (const word of ['seating', 'seat', 'table_order', 'scoringView', 'scorer.view']) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  test('the seat order lives under its own key and not in the game journal', () => {
    renderScorer();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Jeremy left' }));

    expect(loadSeating(gameKey).left).toEqual(['Gibson', 'Jeremy', 'Maycie', 'Phillip']);
    expect(JSON.stringify(savedEvents())).not.toContain('Jeremy Cole');
    expect(savedEvents().every((event) => !('seats' in event))).toBe(true);
  });
});

/**
 * The same table, seen from the end of the room.
 *
 * A scorekeeper beside the moderator is looking down the tables rather than across them. This is
 * that, and the claim is that it is only that: the seats, the numbers, the rulings, the drag and the
 * events are the ones the row already had, turned ninety degrees.
 */
describe('a table that runs downwards', () => {
  test('it is the same seats in the same order, drawn the other way', () => {
    renderScorer({ orientation: 'down' });

    expect(document.querySelector('.scorer-table-view')?.getAttribute('data-orientation')).toBe('down');
    expect(chairs('Ninety Six')).toEqual(['Gibson', 'Maycie', 'Jeremy', 'Phillip']);
    expect(seatNumbers('Ninety Six')).toEqual(['1', '2', '3', '4']);
    // Both teams are still drawn, because they are still on opposite sides of the room.
    expect(chairs('Greenwood')).toEqual(['Emma', 'Taylor']);
  });

  test('a ruling is the ruling it always was', () => {
    renderScorer({ orientation: 'down' });

    openPicker('Ninety Six', 'Maycie');
    ruling('Maycie', '10');

    expect(savedEvents().find((event) => event.type === 'tossup-buzz')).toMatchObject({
      team: 'left',
      playerName: 'Maycie',
    });
    expect(screen.getByLabelText('Ninety Six score').textContent).toBe('10');
  });

  test('the keyboard still addresses the seat that is drawn', () => {
    renderScorer({ orientation: 'down', keyboard: true });

    fireEvent.keyDown(document, { code: 'Digit3', key: '3' });
    fireEvent.keyDown(document, { code: 'KeyC', key: 'c' });

    expect(savedEvents().find((event) => event.type === 'tossup-buzz')).toMatchObject({
      playerName: 'Jeremy',
    });
  });

  test('a player is dragged down the table rather than along it', () => {
    renderScorer({ orientation: 'down' });
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));
    const before = savedEvents();

    dragPlayer('Ninety Six', 'Phillip', -3, 'down');

    expect(chairs('Ninety Six')).toEqual(['Phillip', 'Gibson', 'Maycie', 'Jeremy']);
    expect(seatNumbers('Ninety Six')).toEqual(['1', '2', '3', '4']);
    expect(loadSeating(gameKey).left).toEqual(['Phillip', 'Gibson', 'Maycie', 'Jeremy']);
    expect(savedEvents()).toEqual(before);
  });

  test('a sideways gesture on a table that runs downwards moves nobody', () => {
    renderScorer({ orientation: 'down' });
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));

    // Along the axis the seats are *not* on: this is a scroll, not a rearrangement.
    dragPlayer('Ninety Six', 'Phillip', -3, 'across');

    expect(chairs('Ninety Six')).toEqual(['Gibson', 'Maycie', 'Jeremy', 'Phillip']);
  });

  test('the fallback arrows are named for where the seat would actually go', () => {
    renderScorer({ orientation: 'down' });
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));

    expect(screen.queryByRole('button', { name: 'Move Jeremy left' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Move Jeremy up' }));

    expect(chairs('Ninety Six')).toEqual(['Gibson', 'Jeremy', 'Maycie', 'Phillip']);
  });

  test('the arrow keys work whichever pair a scorekeeper reaches for', () => {
    renderScorer({ orientation: 'down' });
    fireEvent.click(screen.getByRole('button', { name: 'Arrange table' }));

    fireEvent.keyDown(seatHandle('Ninety Six', 'Maycie'), { key: 'ArrowDown' });
    expect(chairs('Ninety Six')).toEqual(['Gibson', 'Jeremy', 'Maycie', 'Phillip']);

    // And the pair that matches a table running across, for a hand that learned it there.
    fireEvent.keyDown(seatHandle('Ninety Six', 'Maycie'), { key: 'ArrowLeft' });
    expect(chairs('Ninety Six')).toEqual(['Gibson', 'Maycie', 'Jeremy', 'Phillip']);
  });
});
