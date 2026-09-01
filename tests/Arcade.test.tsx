/**
 * @vitest-environment jsdom
 */

/**
 * The two doors into the arcade, and the promise that the room behind them is sealed.
 *
 * # What is actually being checked
 *
 * The Game menu and Settings open the *same* arcade — one dialog, one pair of games — which is the
 * claim that would quietly stop being true the first time somebody added a third entry point. And
 * then the part that matters more than any of the rest of this feature: a scorekeeper's keys. Space
 * records an unanswered tossup in QBSheet. QBBird flaps on Space. The test below plays a real game
 * on a real scoresheet, opens the arcade, presses Space at it, and asserts that the scoresheet did
 * not move — then closes the arcade and asserts that the very same key records again.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import ScorerHost from '../src/scorer/ScorerHost';
import type { IScorerSubmitResult } from '../src/scorer/Scorer';
import { rememberScoringLayoutChoice } from '../src/scorer/scoringLayoutPrompt';
import { RoomConnectionState } from '../src/app/ConnectionState';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import { openApp } from './appHarness';
import { writeOperatorNameAsked } from '../src/app/OperatorIdentity';
import { stubArcadeCanvas } from './arcadeCanvas';

const leftTeam = { name: 'Ninety Six', players: [{ name: 'Sarah Mitchell' }, { name: 'James Robinson' }] };
const rightTeam = { name: 'Greenwood', players: [{ name: 'Emma Turner' }, { name: 'Jordan Lee' }] };

function formatFor(): IScorekeeperFormat {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.maximumPlayersPerTeam = 2;
  return scoringRulesToScorekeeperFormat(rules);
}

let gameCounter = 0;

/** A live scoresheet, with the events it has recorded readable from outside it. */
function renderScorer() {
  gameCounter += 1;
  const gameKey = `arcade-test-game-${gameCounter}`;
  rememberScoringLayoutChoice(gameKey);
  const recorded: ScoreEvent[][] = [];
  const view = render(
    <ScorerHost
      gameKey={gameKey}
      format={formatFor()}
      leftTeam={leftTeam}
      rightTeam={rightTeam}
      tournamentName="Ninety Six Invitational"
      roundName="Round 4"
      roomName="Room 204"
      connection={RoomConnectionState.Connected}
      onDownload={() => undefined}
      onEventsChanged={(events) => recorded.push(events as ScoreEvent[])}
      onSubmit={vi
        .fn<(qbj: object) => Promise<IScorerSubmitResult>>()
        .mockResolvedValue({ ok: true, message: 'Sent' })}
    />,
  );
  return {
    unmount: view.unmount,
    /** Every event on the scoresheet right now. The empty array before anything has been scored. */
    events: () => recorded[recorded.length - 1] ?? [],
  };
}

/** Open the Game menu and choose an entry from it. */
function chooseFromGameMenu(label: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Game' }));
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
}

/** The arcade, once its chunk has arrived. It is loaded on demand; see `ArcadeLauncher`. */
async function arcadePicker(): Promise<HTMLElement> {
  return (await screen.findByRole('button', { name: /QBBird/ })).closest('dialog') as HTMLElement;
}

beforeEach(() => {
  stubArcadeCanvas();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the Game menu entry', () => {
  test('the scoresheet offers a break, and it is not filed with anything that changes the game', () => {
    renderScorer();
    fireEvent.click(screen.getByRole('button', { name: 'Game' }));

    const entry = screen.getByRole('menuitem', { name: 'Take a break…' });
    expect(entry).toBeInTheDocument();
    expect(entry).not.toBeDisabled();
    // Not a destructive action, and not filed with the two that end a game.
    expect(entry.className).not.toContain('is-destructive');
  });

  test('it opens the arcade picker, with both games in it', async () => {
    renderScorer();
    chooseFromGameMenu('Take a break…');

    const dialog = await arcadePicker();
    expect(within(dialog).getByRole('heading', { name: 'Arcade' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /QBBird/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Snake/ })).toBeInTheDocument();
  });

  test('choosing a game renders that game and only that game', async () => {
    renderScorer();
    chooseFromGameMenu('Take a break…');
    await arcadePicker();

    fireEvent.click(screen.getByRole('button', { name: /QBBird/ }));
    expect(screen.getByLabelText(/QBBird play area/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Snake play area/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Back to Arcade' }));
    fireEvent.click(screen.getByRole('button', { name: /Snake/ }));
    expect(screen.getByLabelText(/Snake play area/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/QBBird play area/)).toBeNull();
  });

  test('returning to the picker takes the game off the screen', async () => {
    renderScorer();
    chooseFromGameMenu('Take a break…');
    await arcadePicker();

    fireEvent.click(screen.getByRole('button', { name: /Snake/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Arcade' }));

    expect(screen.queryByLabelText(/Snake play area/)).toBeNull();
    expect(screen.getByRole('button', { name: /QBBird/ })).toBeInTheDocument();
  });

  test('closing the arcade takes the whole thing off the screen', async () => {
    renderScorer();
    chooseFromGameMenu('Take a break…');
    await arcadePicker();
    fireEvent.click(screen.getByRole('button', { name: /QBBird/ }));
    expect(screen.getByLabelText(/QBBird play area/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));

    expect(screen.queryByLabelText(/QBBird play area/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Snake/ })).toBeNull();
  });
});

describe('the Settings entry', () => {
  test('Settings offers the arcade, and it opens the same picker the Game menu does', async () => {
    writeOperatorNameAsked();
    await openApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    expect(within(settings).getByRole('heading', { name: 'Arcade' })).toBeInTheDocument();
    expect(within(settings).getByText('QBBird and Snake')).toBeInTheDocument();

    fireEvent.click(within(settings).getByRole('button', { name: 'Play' }));

    // Settings gets out of the way rather than stacking a second modal behind this one.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());

    const dialog = await arcadePicker();
    expect(within(dialog).getByRole('button', { name: /QBBird/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Snake/ })).toBeInTheDocument();
  });
});

describe('what a screen reader gets', () => {
  test('the score and the best are text, not only pixels on a canvas', async () => {
    renderScorer();
    chooseFromGameMenu('Take a break…');
    await arcadePicker();
    fireEvent.click(screen.getByRole('button', { name: /QBBird/ }));

    const scores = document.querySelector('.arcade-scores') as HTMLElement;
    expect(within(scores).getByText('Score')).toBeInTheDocument();
    expect(within(scores).getByText('Best')).toBeInTheDocument();
    // Two readable numbers, with no canvas involved in either of them.
    expect(within(scores).getAllByText('0')).toHaveLength(2);
  });

  test('the board is labelled, and its controls are written down beside it', async () => {
    renderScorer();
    chooseFromGameMenu('Take a break…');
    await arcadePicker();
    fireEvent.click(screen.getByRole('button', { name: /Snake/ }));

    const board = screen.getByLabelText(/Snake play area/);
    expect(board.tagName).toBe('CANVAS');
    // The instructions are the board's description, so they are announced with it rather than being
    // decoration somebody has to go looking for.
    const described = board.getAttribute('aria-describedby');
    expect(described).not.toBeNull();
    expect(document.getElementById(described as string)?.textContent).toMatch(/arrow keys/i);
  });

  test('a game can be played entirely without the keyboard shortcuts it advertises', async () => {
    renderScorer();
    chooseFromGameMenu('Take a break…');
    await arcadePicker();
    fireEvent.click(screen.getByRole('button', { name: /Snake/ }));

    // Start, four directions and a way back, all as ordinary named buttons.
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    ['Steer up', 'Steer down', 'Steer left', 'Steer right'].forEach((name) =>
      expect(screen.getByRole('button', { name })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Back to Arcade' })).toBeInTheDocument();
  });

  test('nothing in the arcade announces itself continuously', async () => {
    renderScorer();
    chooseFromGameMenu('Take a break…');
    await arcadePicker();
    fireEvent.click(screen.getByRole('button', { name: /QBBird/ }));

    // A live region on a score that changes every second and a half would make the surrounding
    // application unusable with a screen reader running. The score is text that can be read on
    // request, and nothing here asks to be read aloud.
    const dialog = screen.getByLabelText(/QBBird play area/).closest('dialog') as HTMLElement;
    expect(dialog.querySelectorAll('[aria-live], [role="status"], [role="alert"]')).toHaveLength(0);
  });
});

describe('the scorekeeper’s keys', () => {
  /** Space, at the document, which is where the scoresheet listens for it. */
  const pressSpaceOnTheSheet = () => {
    act(() => {
      fireEvent.keyDown(document, { key: ' ' });
    });
  };

  test('Space records an unanswered tossup before the arcade is anywhere near it', () => {
    const scorer = renderScorer();
    expect(scorer.events()).toHaveLength(0);

    pressSpaceOnTheSheet();

    expect(scorer.events()).toHaveLength(1);
    expect(scorer.events()[0].type).toBe('tossup-dead');
  });

  test('with the arcade open, the game’s own keys reach the game and never the scoresheet', async () => {
    const scorer = renderScorer();
    pressSpaceOnTheSheet();
    const before = scorer.events().length;
    expect(before).toBe(1);

    chooseFromGameMenu('Take a break…');
    await arcadePicker();
    fireEvent.click(screen.getByRole('button', { name: /QBBird/ }));
    const board = screen.getByLabelText(/QBBird play area/);

    // The keys QBBird plays on, pressed at the board, which is where a player presses them.
    act(() => {
      fireEvent.keyDown(board, { key: ' ' });
      fireEvent.keyDown(board, { key: 'ArrowUp' });
    });
    // And the same keys at the document, which is the leak this is really about: the scoresheet's
    // listener is still attached and still runs, and still has to decide to do nothing.
    pressSpaceOnTheSheet();

    expect(scorer.events()).toHaveLength(before);
  });

  test('Snake’s arrows and letters do not steer the scoresheet either', async () => {
    const scorer = renderScorer();
    chooseFromGameMenu('Take a break…');
    await arcadePicker();
    fireEvent.click(screen.getByRole('button', { name: /Snake/ }));
    const board = screen.getByLabelText(/Snake play area/);

    act(() => {
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'w', 'a', 's', 'd', ' '].forEach((key) =>
        fireEvent.keyDown(board, { key }),
      );
      // A seat number and a ruling, which is a whole tossup on the scoresheet's keyboard layer.
      fireEvent.keyDown(document, { key: '1', code: 'Digit1' });
      fireEvent.keyDown(document, { key: 'c' });
    });

    expect(scorer.events()).toHaveLength(0);
  });

  test('closing the arcade hands every key straight back to the scoresheet', async () => {
    const scorer = renderScorer();
    chooseFromGameMenu('Take a break…');
    await arcadePicker();
    fireEvent.click(screen.getByRole('button', { name: /QBBird/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));

    /*
     * Closing restores focus to the control that opened it — the Game button — which is what every
     * dialog in QBSheet does and is why Space does not record on this line. Space belongs to a
     * focused button, deliberately and since long before this feature; see
     * `activationKeyBelongsToControl`. So the arcade leaves the scoresheet in exactly the state
     * Notes or Game details would have left it in, which is the actual requirement.
     */
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Game' }));
    pressSpaceOnTheSheet();
    expect(scorer.events()).toHaveLength(0);

    // And the moment focus leaves that button, as it does when a scorekeeper looks back at the
    // sheet, the key is the scoresheet's again — with nothing of the arcade's left in the way.
    (document.activeElement as HTMLElement).blur();
    pressSpaceOnTheSheet();

    expect(scorer.events()).toHaveLength(1);
    expect(scorer.events()[0].type).toBe('tossup-dead');
  });

  test('the arcade records nothing on the scoresheet, however long it is played', async () => {
    const scorer = renderScorer();
    chooseFromGameMenu('Take a break…');
    await arcadePicker();
    fireEvent.click(screen.getByRole('button', { name: /Snake/ }));
    const board = screen.getByLabelText(/Snake play area/);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    act(() => {
      fireEvent.keyDown(board, { key: 'ArrowUp' });
      fireEvent.keyDown(board, { key: 'ArrowLeft' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Steer down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Arcade' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));

    // Not "the score did not change" — nothing was written at all. The arcade has no route to an
    // event, and this is the assertion that would fail if one were ever added.
    expect(scorer.events()).toHaveLength(0);
  });
});
