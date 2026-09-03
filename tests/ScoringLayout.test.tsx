/**
 * @vitest-environment jsdom
 */

/**
 * Which layout this game is being scored in, and who decides.
 *
 * Two claims, and the second is the one that matters. The first is that a scorekeeper can choose and
 * change the layout without hunting for the control: a new game asks, the strip above the surface
 * switches, and both name the two options rather than naming the current one on a button that does
 * the opposite. The second is that none of it is scoring. Choosing a layout, switching a layout and
 * dismissing the question all have to leave the event journal byte for byte as they found it,
 * because a Chromebook that was handed to a different person between rounds must not be able to
 * change a result by being handed over.
 *
 * The per-game memory is the third thing here, and it exists for a specific failure: a modal that
 * reappeared on every mount would appear after a reload, after a recovery, and in the middle of a
 * game somebody was already scoring, which is the one moment it is worst.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';
import ScorerHost from '../src/scorer/ScorerHost';
import { RoomConnectionState } from '../src/app/ConnectionState';
import { loadGame } from '../src/scorer/GameSession';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import {
  ScoringView,
  resetScoringView,
  saveScoringView,
  saveTableOrientation,
  scoringViewStorageKey,
  tableOrientationStorageKey,
} from '../src/scorer/scoringViewPreference';
import {
  forgetScoringLayoutChoice,
  resetScoringLayoutPrompts,
  scoringLayoutPromptStorageKey,
} from '../src/scorer/scoringLayoutPrompt';

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
  resetScoringLayoutPrompts();
});

const leftTeam = {
  name: 'Ninety Six',
  players: [{ name: 'Gibson' }, { name: 'Maycie' }, { name: 'Jeremy' }, { name: 'Phillip' }],
};
const rightTeam = { name: 'Greenwood', players: [{ name: 'Emma' }, { name: 'Taylor' }] };

function formatFor(): IScorekeeperFormat {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.maximumPlayersPerTeam = 4;
  return scoringRulesToScorekeeperFormat(rules);
}

let gameCounter = 0;

function renderScorer(gameKey: string) {
  render(
    <ScorerHost
      gameKey={gameKey}
      format={formatFor()}
      leftTeam={leftTeam}
      rightTeam={rightTeam}
      tournamentName="Ninety Six Invitational"
      roundName="Round 4"
      connection={RoomConnectionState.Connected}
      onDownload={() => undefined}
      onSubmit={vi.fn().mockResolvedValue({ ok: true, message: 'Sent' })}
    />,
  );
  return gameKey;
}

function newGame(preference: ScoringView = 'scoresheet'): string {
  gameCounter += 1;
  saveScoringView(preference);
  resetScoringView();
  return renderScorer(`layout-game-${gameCounter}`);
}

function chooser(): HTMLElement | null {
  return screen.queryByRole('dialog', { name: 'Choose a scoring layout' });
}

function choose(layout: 'Scoresheet' | 'Table'): void {
  const dialog = chooser();
  if (!dialog) throw new Error('The scoring-layout chooser is not open.');
  fireEvent.click(within(dialog).getByRole('radio', { name: layout }));
}

function savedEvents(gameKey: string): ScoreEvent[] {
  return loadGame(gameKey)?.events ?? [];
}

/** The strip above the scoring surface. Null when it is not drawn at all. */
function layoutBar(): HTMLElement | null {
  return document.querySelector('.scorer-main > .scorer-layout-bar');
}

function surfaceAfterBar(): string {
  return layoutBar()?.nextElementSibling?.className ?? '';
}

describe('the question a new game opens with', () => {
  test('a genuinely new game asks, and offers both layouts', () => {
    newGame();

    const dialog = chooser();
    expect(dialog).toBeTruthy();
    expect(within(dialog as HTMLElement).getByRole('radio', { name: 'Scoresheet' })).toBeTruthy();
    expect(within(dialog as HTMLElement).getByRole('radio', { name: 'Table' })).toBeTruthy();
    // Said out loud, because somebody may never have seen either.
    expect(within(dialog as HTMLElement).getByText(/Players appear in seating order/)).toBeTruthy();
  });

  test('it says the choice is about the screen and not about the game', () => {
    newGame();

    expect(screen.getByText(/doesn’t change the game or recorded scores/)).toBeTruthy();
  });

  test('what this device used last is already selected', () => {
    newGame('table');

    const dialog = chooser() as HTMLElement;
    expect(within(dialog).getByRole('radio', { name: 'Table' }).getAttribute('aria-checked')).toBe('true');
    expect(within(dialog).getByRole('radio', { name: 'Scoresheet' }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  test('choosing Table opens the table, with no second press to confirm it', () => {
    newGame();

    choose('Table');

    expect(chooser()).toBeNull();
    expect(document.querySelector('.scorer-table-view')).toBeTruthy();
    expect(document.querySelector('.scorer-teams')).toBeNull();
  });

  test('choosing Scoresheet opens the scoresheet', () => {
    newGame('table');

    choose('Scoresheet');

    expect(chooser()).toBeNull();
    expect(document.querySelector('.scorer-teams')).toBeTruthy();
    expect(document.querySelector('.scorer-table-view')).toBeNull();
  });

  test('the choice becomes this device’s next default', () => {
    newGame();

    choose('Table');

    expect(window.localStorage.getItem(scoringViewStorageKey)).toBe('table');
  });

  test('answering writes nothing to the game', () => {
    const gameKey = newGame();
    const before = savedEvents(gameKey);

    choose('Table');

    expect(savedEvents(gameKey)).toEqual(before);
  });

  test('dismissing it is the preselected answer, not a question left open', () => {
    const gameKey = newGame('table');

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));

    expect(chooser()).toBeNull();
    expect(document.querySelector('.scorer-table-view')).toBeTruthy();
    // And the game has been asked, so a reload does not ask again.
    expect(window.localStorage.getItem(scoringLayoutPromptStorageKey(gameKey))).toBeTruthy();
  });
});

/**
 * The card marked as selected and the layout that is actually in force, which have to be one thing.
 *
 * Arrow keys move a radio group's selection — that is what the role promises and what
 * `SegmentedChoice` implements — so the dialog could be showing `Table` as the selected card while
 * the scoresheet behind it was still what dismissal would leave in place. Two answers to one
 * question, with the one the scorekeeper could see losing.
 */
describe('what the selected card and the layout in force agree about', () => {
  /** Move the selection with the keyboard, from the card that is currently selected. */
  function arrowToOtherLayout(): HTMLElement {
    const dialog = chooser();
    if (!dialog) throw new Error('The scoring-layout chooser is not open.');
    const selected = within(dialog)
      .getAllByRole('radio')
      .find((radio) => radio.getAttribute('aria-checked') === 'true');
    fireEvent.keyDown(selected as HTMLElement, { key: 'ArrowRight' });
    return dialog;
  }

  test('arrowing to Table marks Table, and Escape leaves the table on screen', () => {
    newGame('scoresheet');

    const dialog = arrowToOtherLayout();
    expect(within(dialog).getByRole('radio', { name: 'Table' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(chooser()).toBeNull();
    expect(document.querySelector('.scorer-table-view')).toBeTruthy();
    expect(document.querySelector('.scorer-teams')).toBeNull();
    expect(window.localStorage.getItem(scoringViewStorageKey)).toBe('table');
  });

  test('arrowing to Table and pressing the close button does the same thing', () => {
    newGame('scoresheet');

    arrowToOtherLayout();
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));

    expect(chooser()).toBeNull();
    expect(document.querySelector('.scorer-table-view')).toBeTruthy();
  });

  test('arrowing back before dismissing commits what is selected then, not what was selected first', () => {
    newGame('scoresheet');

    const dialog = arrowToOtherLayout();
    fireEvent.keyDown(within(dialog).getByRole('radio', { name: 'Table' }), { key: 'ArrowLeft' });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(document.querySelector('.scorer-teams')).toBeTruthy();
    expect(document.querySelector('.scorer-table-view')).toBeNull();
  });

  test('Home and End reach the ends, and dismissal commits where they landed', () => {
    newGame('scoresheet');

    const dialog = chooser() as HTMLElement;
    fireEvent.keyDown(within(dialog).getByRole('radio', { name: 'Scoresheet' }), { key: 'End' });
    expect(within(dialog).getByRole('radio', { name: 'Table' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(document.querySelector('.scorer-table-view')).toBeTruthy();
  });

  test('a mouse press on a card is still the answer it always was', () => {
    newGame('scoresheet');

    choose('Table');

    expect(chooser()).toBeNull();
    expect(document.querySelector('.scorer-table-view')).toBeTruthy();
    expect(window.localStorage.getItem(scoringViewStorageKey)).toBe('table');
  });

  test('Enter on a card answers with it', async () => {
    const user = userEvent.setup();
    newGame('scoresheet');

    // Arrowing moves focus with the selection, so the focused card is the one Enter answers with.
    arrowToOtherLayout();
    await user.keyboard('{Enter}');

    expect(chooser()).toBeNull();
    expect(document.querySelector('.scorer-table-view')).toBeTruthy();
  });

  test('Space on a card answers with it', async () => {
    const user = userEvent.setup();
    newGame('scoresheet');

    arrowToOtherLayout();
    await user.keyboard(' ');

    expect(chooser()).toBeNull();
    expect(document.querySelector('.scorer-table-view')).toBeTruthy();
  });

  test('answering by dismissal still writes nothing to the game', () => {
    const gameKey = newGame('scoresheet');
    const before = savedEvents(gameKey);

    arrowToOtherLayout();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(savedEvents(gameKey)).toEqual(before);
    expect(window.localStorage.getItem(scoringLayoutPromptStorageKey(gameKey))).toBeTruthy();
  });
});

describe('what it does not ask twice', () => {
  test('reopening the same game does not ask again', () => {
    const gameKey = newGame();
    choose('Table');
    cleanup();

    renderScorer(gameKey);

    expect(chooser()).toBeNull();
    expect(document.querySelector('.scorer-table-view')).toBeTruthy();
  });

  test('a game already in progress is not interrupted, even with no marker at all', () => {
    // A game scored under a build that predates the question: there is a history and nothing that
    // says anybody was asked. Interrupting it mid-round would be the worst moment to start.
    const gameKey = newGame();
    choose('Scoresheet');
    fireEvent.click(screen.getByRole('button', { name: 'Gibson 10' }));
    expect(savedEvents(gameKey).some((event) => event.type === 'tossup-buzz')).toBe(true);
    cleanup();
    forgetScoringLayoutChoice(gameKey);

    renderScorer(gameKey);

    expect(chooser()).toBeNull();
  });

  test('the next game on the same Chromebook is asked again, with the last layout ready', () => {
    newGame();
    choose('Table');
    cleanup();

    gameCounter += 1;
    renderScorer(`layout-game-${gameCounter}`);

    const dialog = chooser() as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByRole('radio', { name: 'Table' }).getAttribute('aria-checked')).toBe('true');
  });

  test('a device whose storage refuses still only asks once', () => {
    // The marker cannot be written, so the in-memory answer is the only thing standing between the
    // scorekeeper and a dialog on every re-render.
    const gameKey = newGame();
    choose('Table');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });

    cleanup();
    renderScorer(gameKey);

    expect(chooser()).toBeNull();
  });
});

describe('the switcher above the scoring surface', () => {
  /** A game past the question, in the given layout. */
  function scoring(layout: 'Scoresheet' | 'Table'): string {
    const gameKey = newGame();
    choose(layout);
    return gameKey;
  }

  test('it is drawn in the same place whichever layout is on screen', () => {
    scoring('Scoresheet');
    expect(layoutBar()).toBeTruthy();
    expect(surfaceAfterBar()).toContain('scorer-teams');

    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));

    // Same element, same position in the same parent: switching does not move the switch.
    expect(layoutBar()).toBeTruthy();
    expect(surfaceAfterBar()).toContain('scorer-table-view');
  });

  test('it marks the layout on screen rather than naming the other one', () => {
    scoring('Table');

    const bar = layoutBar() as HTMLElement;
    expect(within(bar).getByRole('radio', { name: 'Table' }).getAttribute('aria-checked')).toBe('true');
    expect(within(bar).getByRole('radio', { name: 'Scoresheet' }).getAttribute('aria-checked')).toBe('false');
  });

  test('switching happens on the press, with no confirmation', () => {
    scoring('Scoresheet');

    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));

    expect(document.querySelector('.scorer-table-view')).toBeTruthy();
  });

  test('arrow keys walk the two options and switch as they go', () => {
    scoring('Scoresheet');
    const bar = layoutBar() as HTMLElement;

    fireEvent.keyDown(within(bar).getByRole('radio', { name: 'Scoresheet' }), { key: 'ArrowRight' });

    expect(document.querySelector('.scorer-table-view')).toBeTruthy();
  });

  test('switching keeps every recorded event exactly as it was', () => {
    const gameKey = scoring('Scoresheet');
    fireEvent.click(screen.getByRole('button', { name: 'Gibson 10' }));
    const before = savedEvents(gameKey);

    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Scoresheet' }));

    expect(savedEvents(gameKey)).toEqual(before);
    expect(screen.getByLabelText('Ninety Six score').textContent).toBe('10');
  });

  test('leaving the table takes any open ruling picker with it', () => {
    scoring('Table');
    fireEvent.click(within(screen.getByLabelText('Ninety Six')).getByRole('button', { name: 'Maycie' }));
    expect(screen.getByRole('dialog', { name: /Ruling for Maycie/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Scoresheet' }));

    expect(screen.queryByRole('dialog', { name: /Ruling for/ })).toBeNull();
  });

  test('the layout it leaves on is what the next game is offered', () => {
    scoring('Scoresheet');

    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));

    expect(window.localStorage.getItem(scoringViewStorageKey)).toBe('table');
  });

  test('the Arrange action joins it rather than starting a toolbar of its own', () => {
    scoring('Table');

    const bar = layoutBar() as HTMLElement;
    expect(within(bar).getByRole('button', { name: 'Arrange table' })).toBeTruthy();
    // And it belongs to the table, so the scoresheet does not offer it.
    fireEvent.click(within(bar).getByRole('radio', { name: 'Scoresheet' }));
    expect(screen.queryByRole('button', { name: 'Arrange table' })).toBeNull();
  });
});

describe('the Game menu route', () => {
  test('it opens the same question rather than switching behind the scorekeeper', () => {
    newGame();
    choose('Scoresheet');

    fireEvent.click(screen.getByText('Game'));
    // The entry it replaced read "Scoring view: Scoresheet" and switched to the table.
    expect(screen.queryByRole('menuitem', { name: /Scoring view/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Scoring layout…' }));

    expect(chooser()).toBeTruthy();
    expect(document.querySelector('.scorer-teams')).toBeTruthy();
  });

  test('choosing from it switches and closes', () => {
    newGame();
    choose('Scoresheet');
    fireEvent.click(screen.getByText('Game'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Scoring layout…' }));

    choose('Table');

    expect(chooser()).toBeNull();
    expect(document.querySelector('.scorer-table-view')).toBeTruthy();
  });
});

/**
 * Which way the tables run, which is a different question from which layout.
 *
 * A scorekeeper sitting at the end of the room is looking down the tables rather than across them.
 * That is one table drawn two ways, so it is offered where the table is and nowhere else — not as a
 * third layout, and not folded into the one question a new game already asks.
 */
describe('the orientation of the table', () => {
  function scoring(layout: 'Scoresheet' | 'Table'): string {
    const gameKey = newGame();
    choose(layout);
    return gameKey;
  }

  function orientationGroup(): HTMLElement | null {
    return document.querySelector('.scorer-layout-orientation');
  }

  test('a new game is asked one question, not two', () => {
    newGame();

    const dialog = chooser() as HTMLElement;
    expect(within(dialog).queryByRole('radio', { name: 'Across' })).toBeNull();
    expect(within(dialog).queryByRole('radio', { name: 'Down' })).toBeNull();
  });

  test('it is offered beside the layout, and only where it means anything', () => {
    scoring('Scoresheet');
    expect(orientationGroup()).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));

    const group = orientationGroup() as HTMLElement;
    expect(group).toBeTruthy();
    // In the same strip as the layout switch, rather than in a toolbar of its own.
    expect(group.closest('.scorer-layout-bar')).toBe(layoutBar());
    expect(within(group).getByRole('radio', { name: 'Across' }).getAttribute('aria-checked')).toBe('true');
  });

  test('choosing Down turns the table without touching anything else', () => {
    const gameKey = scoring('Table');
    fireEvent.click(within(screen.getByLabelText('Ninety Six')).getByRole('button', { name: 'Gibson' }));
    fireEvent.click(screen.getByRole('button', { name: 'Gibson 10' }));
    const before = savedEvents(gameKey);

    fireEvent.click(screen.getByRole('radio', { name: 'Down' }));

    expect(document.querySelector('.scorer-table-view')?.getAttribute('data-orientation')).toBe('down');
    expect(savedEvents(gameKey)).toEqual(before);
    expect(screen.getByLabelText('Ninety Six score').textContent).toBe('10');
  });

  test('the chair the scorekeeper is sitting in is remembered for the next game', () => {
    scoring('Table');

    fireEvent.click(screen.getByRole('radio', { name: 'Down' }));

    expect(window.localStorage.getItem(tableOrientationStorageKey)).toBe('down');
  });

  test('a device that has never said stays across, which is what the table has always drawn', () => {
    // Nothing stored at all: the scorekeeper who has been using the table gets the table they know.
    window.localStorage.removeItem(tableOrientationStorageKey);

    scoring('Table');

    expect(document.querySelector('.scorer-table-view')?.getAttribute('data-orientation')).toBe('across');
  });

  test('going back to the scoresheet takes the question with it', () => {
    scoring('Table');
    fireEvent.click(screen.getByRole('radio', { name: 'Down' }));

    fireEvent.click(screen.getByRole('radio', { name: 'Scoresheet' }));

    expect(orientationGroup()).toBeNull();
    // And it is still there when the table comes back.
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(document.querySelector('.scorer-table-view')?.getAttribute('data-orientation')).toBe('down');
  });
});
