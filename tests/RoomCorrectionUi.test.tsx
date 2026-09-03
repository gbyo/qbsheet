/**
 * @vitest-environment jsdom
 */

/**
 * The surfaces a room reaches when the setup no longer matches the room.
 *
 * Two things are being tested at once, and the second is the harder one:
 *
 *   1. a scorekeeper who has been told something by a director can record it;
 *   2. a scorekeeper scoring an ordinary game never sees any of it.
 *
 * The second is why the anti-clutter assertions are here rather than in a separate file. A feature
 * that made the common case one press longer would have failed even if every escape route worked.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ScorerHost from '../src/scorer/ScorerHost';
import { rememberScoringLayoutChoice } from '../src/scorer/scoringLayoutPrompt';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import { IRoomProcedure } from '../src/scoring/RoomProcedure';
import { RoomConnectionState } from '../src/app/ConnectionState';
import { GameCorrectionRefusal, IGameCorrection } from '../src/scoring/gameCorrection';
import { ScoreEvent } from '../src/scoring/ScoreEvents';

const leftTeam = { name: 'Ninety Six', players: [{ name: 'Sarah Mitchell' }, { name: 'James Robinson' }] };
const rightTeam = { name: 'Greenwood', players: [{ name: 'Emma Turner' }, { name: 'Jordan Lee' }] };

function formatFor(): IScorekeeperFormat {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.maximumPlayersPerTeam = 2;
  rules.maximumRegulationTossupCount = 4;
  return scoringRulesToScorekeeperFormat(rules);
}

const oneTimeout: IRoomProcedure = { version: 3, halves: false, timeoutsPerTeam: 1 };

let gameCounter = 0;

function renderScorer(
  options: {
    procedure?: IRoomProcedure;
    onCorrectGame?: (correction: IGameCorrection) => void | Promise<void>;
    onEventsChanged?: (events: ScoreEvent[]) => void;
  } = {},
) {
  gameCounter += 1;
  const gameKey = `correction-ui-${gameCounter}`;
  rememberScoringLayoutChoice(gameKey);
  render(
    <ScorerHost
      gameKey={gameKey}
      format={formatFor()}
      leftTeam={leftTeam}
      rightTeam={rightTeam}
      tournamentName="Ninety Six Invitational"
      roundName="Round 4"
      roomName="Room 204"
      packetName="Packet 4"
      procedure={options.procedure}
      connection={RoomConnectionState.Connected}
      onDownload={() => undefined}
      onSubmit={vi.fn().mockResolvedValue({ ok: true, message: 'Sent' })}
      onCorrectGame={options.onCorrectGame}
      onEventsChanged={(events) => options.onEventsChanged?.(events)}
    />,
  );
}

/** Press a control wherever it currently lives — the footer, or the Game menu. */
function pressControl(name: string | RegExp) {
  const onFooter = screen.queryByRole('button', { name });
  if (onFooter) {
    fireEvent.click(onFooter);
    return;
  }
  fireEvent.click(screen.getByRole('button', { name: 'Game' }));
  fireEvent.click(screen.getByRole('menuitem', { name }));
}

function menuLabels(): string[] {
  fireEvent.click(screen.getByRole('button', { name: 'Game' }));
  const labels = screen.getAllByRole('menuitem').map((item) => item.textContent ?? '');
  fireEvent.keyDown(document, { key: 'Escape' });
  return labels;
}

afterEach(cleanup);

describe('an ordinary game is exactly as it was', () => {
  test('the scoring surface gains no permanent control', () => {
    renderScorer({ procedure: oneTimeout });

    const footer = document.querySelector('.scorer-footer');
    const labels = Array.from(footer?.querySelectorAll('button') ?? []).map(
      (button) => button.textContent ?? '',
    );

    expect(labels.join('|')).not.toMatch(/unusual|exception|correct|procedure|advanced/i);
    expect(screen.queryByRole('button', { name: /procedure changed/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /allowed another one/i })).toBeNull();
  });

  test('the Game menu did not become a toolbox', () => {
    renderScorer({ procedure: oneTimeout, onCorrectGame: vi.fn() });
    const labels = menuLabels();

    expect(labels).toContain('Game details');
    // Corrections to the game's own definition are reached from the row they correct, not from here.
    expect(labels.join('|')).not.toContain('Correct scoring rules');
    expect(labels.join('|')).not.toMatch(/procedure|exception/i);
  });

  test('a team with a timeout left is offered a timeout and nothing else', () => {
    renderScorer({ procedure: oneTimeout });
    pressControl('Timeout');

    const dialog = screen.getByRole('dialog', { name: 'Timeout' });
    expect(within(dialog).getByRole('button', { name: /Ninety Six/ })).not.toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: /allowed another one/i })).toBeNull();
  });
});

describe('a timeout the tournament director allowed', () => {
  /** Spend the configured timeout, then reopen the dialog on the exhausted team. */
  function useTheOnlyTimeout() {
    pressControl('Timeout');
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Timeout' })).getByRole('button', { name: /Ninety Six/ }),
    );
    pressControl('Resume play');
  }

  test('the exhausted team is offered a way out, and the other team is not', () => {
    renderScorer({ procedure: oneTimeout });
    useTheOnlyTimeout();
    pressControl('Timeout');

    const dialog = screen.getByRole('dialog', { name: 'Timeout' });
    const escapes = within(dialog).getAllByRole('button', { name: /allowed another one/i });
    expect(escapes).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: /Greenwood/ })).not.toBeDisabled();
  });

  test('recording the ruling makes the second timeout available, and says why on the scoresheet', () => {
    const changed = vi.fn();
    renderScorer({ procedure: oneTimeout, onEventsChanged: changed });
    useTheOnlyTimeout();
    pressControl('Timeout');

    fireEvent.click(screen.getByRole('button', { name: /allowed another one/i }));
    // The question first: a one-off ruling, or a room that was set up wrong.
    fireEvent.click(screen.getByRole('button', { name: 'We were told we could, this once' }));

    const reason = screen.getByLabelText('Why');
    // A reason is the whole value of the record, so nothing is recorded without one.
    expect(screen.getByRole('button', { name: 'Record this ruling' })).toBeDisabled();
    fireEvent.change(reason, { target: { value: 'Director ruled the first timeout did not count' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record this ruling' }));

    const recorded = changed.mock.calls.at(-1)?.[0] as ScoreEvent[];
    expect(recorded.some((candidate) => candidate.type === 'procedure-exception')).toBe(true);

    pressControl('Timeout');
    expect(
      within(screen.getByRole('dialog', { name: 'Timeout' })).getByRole('button', { name: /Ninety Six/ }),
    ).not.toBeDisabled();
  });

  test('the ruling shows up in Game details afterwards', () => {
    renderScorer({ procedure: oneTimeout });
    useTheOnlyTimeout();
    pressControl('Timeout');
    fireEvent.click(screen.getByRole('button', { name: /allowed another one/i }));
    fireEvent.click(screen.getByRole('button', { name: 'We were told we could, this once' }));
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'Director allowed it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record this ruling' }));

    pressControl('Game details');
    const dialog = screen.getByRole('dialog', { name: 'Game details' });
    expect(within(dialog).getByText(/An extra timeout for Ninety Six/)).toBeTruthy();
    expect(within(dialog).getByText(/Director allowed it/)).toBeTruthy();
  });
});

describe('Game details', () => {
  test('reads as a summary, with an action only beside what can be changed', () => {
    renderScorer({ procedure: oneTimeout });
    pressControl('Game details');
    const dialog = screen.getByRole('dialog', { name: 'Game details' });

    expect(within(dialog).getByText('Ninety Six Invitational')).toBeTruthy();
    expect(within(dialog).getByText('Packet 4')).toBeTruthy();
    expect(within(dialog).getByText(/1 timeout each/)).toBeTruthy();
    // The moderator has always been editable; nothing else is, because this host cannot persist it.
    expect(within(dialog).getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
    expect(within(dialog).queryByRole('button', { name: 'Correct…' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Change…' })).toBeNull();
  });

  test('offers the corrections a host that can persist them supports', () => {
    renderScorer({ procedure: oneTimeout, onCorrectGame: vi.fn() });
    pressControl('Game details');
    const dialog = screen.getByRole('dialog', { name: 'Game details' });

    // Two teams, two rosters and the scoring rules.
    expect(within(dialog).getAllByRole('button', { name: 'Correct…' })).toHaveLength(5);
    expect(within(dialog).getByRole('button', { name: 'Change…' })).toBeTruthy();
  });

  test('a team name correction reaches the host with the history intact', async () => {
    const correct = vi.fn();
    renderScorer({ procedure: oneTimeout, onCorrectGame: correct });
    pressControl('Game details');

    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Game details' })).getAllByRole('button', {
        name: 'Correct…',
      })[0],
    );
    fireEvent.change(screen.getByLabelText('Team name'), { target: { value: 'Ninety Six A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(correct).toHaveBeenCalled());
    const correction = correct.mock.calls[0][0] as IGameCorrection;
    expect(correction.setup?.left.name).toBe('Ninety Six A');
    expect(correction.summary).toContain('Ninety Six → Ninety Six A');
    // The audit note travels with it rather than being written separately.
    expect(
      correction.events.some(
        (candidate) => candidate.type === 'note' && candidate.text.includes('Ninety Six A'),
      ),
    ).toBe(true);
  });

  /**
   * What a rename does while it is being written, and what it does when the device says no.
   *
   * `ScoringScreen.correctGame` throws `GameCorrectionRefusal` when the journal or the record store
   * will not take a correction. These forms used to close on the promise settling either way, so a
   * refused rename was indistinguishable from an applied one: the editor went away, the old name was
   * still on the scoresheet, and nothing said why.
   */
  describe('a rename that the device has to persist', () => {
    /** Open the team-name editor and type a new name into it. */
    function typeTeamName(value: string): void {
      pressControl('Game details');
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'Game details' })).getAllByRole('button', {
          name: 'Correct…',
        })[0],
      );
      fireEvent.change(screen.getByLabelText('Team name'), { target: { value } });
    }

    /** Open the roster, then one player's editor, and type a new name into it. */
    function typePlayerName(value: string): void {
      pressControl('Game details');
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'Game details' })).getAllByRole('button', {
          name: 'Correct…',
        })[2],
      );
      fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Correct' })[0]);
      fireEvent.change(screen.getByLabelText('Player name'), { target: { value } });
    }

    test('a team rename says it is saving and closes only once it has', async () => {
      let settle!: () => void;
      const correct = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)));
      renderScorer({ procedure: oneTimeout, onCorrectGame: correct });
      typeTeamName('Ninety Six A');

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      // Mid-write: the editor is still on screen, and pressing again cannot start a second one.
      const saving = screen.getByRole('button', { name: 'Saving…' });
      expect(saving).toBeDisabled();
      fireEvent.click(saving);
      expect(correct).toHaveBeenCalledTimes(1);

      settle();
      await waitFor(() => expect(screen.queryByLabelText('Team name')).toBeNull());
      expect(screen.getByRole('dialog', { name: 'Game details' })).toBeTruthy();
    });

    test('a refused team rename keeps the editor, the typed name, and says nothing was saved', async () => {
      const correct = vi.fn().mockRejectedValue(new Error('quota'));
      renderScorer({ procedure: oneTimeout, onCorrectGame: correct });
      typeTeamName('Ninety Six A');

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(
          screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('Nothing has changed')),
        ).toBe(true),
      );
      expect((screen.getByLabelText('Team name') as HTMLInputElement).value).toBe('Ninety Six A');
      expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
      // And the scoresheet still shows the name that was not changed.
      expect(screen.getByLabelText('Ninety Six score')).toBeTruthy();
    });

    test('a refusal the host worded is shown in the host’s own words', async () => {
      const correct = vi.fn().mockRejectedValue(new GameCorrectionRefusal('This device is out of space.'));
      renderScorer({ procedure: oneTimeout, onCorrectGame: correct });
      typeTeamName('Ninety Six A');

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(
          screen
            .getAllByRole('alert')
            .some((alert) => alert.textContent?.includes('This device is out of space.')),
        ).toBe(true),
      );
    });

    test('a player rename reaches the host and then closes', async () => {
      const correct = vi.fn();
      renderScorer({ procedure: oneTimeout, onCorrectGame: correct });
      typePlayerName('Sara Mitchell');

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(correct).toHaveBeenCalled());
      const correction = correct.mock.calls[0][0] as IGameCorrection;
      expect(correction.setup?.left.players).toContain('Sara Mitchell');
      await waitFor(() => expect(screen.queryByLabelText('Player name')).toBeNull());
    });

    test('a refused player rename stays open with what was typed', async () => {
      const correct = vi.fn().mockRejectedValue(new Error('quota'));
      renderScorer({ procedure: oneTimeout, onCorrectGame: correct });
      typePlayerName('Sara Mitchell');

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(
          screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('Nothing has changed')),
        ).toBe(true),
      );
      expect((screen.getByLabelText('Player name') as HTMLInputElement).value).toBe('Sara Mitchell');
    });

    test('a refused merge stays open too, with the merge still offered', async () => {
      const correct = vi.fn().mockRejectedValue(new Error('quota'));
      renderScorer({ procedure: oneTimeout, onCorrectGame: correct });
      // The other player on the same roster: renaming onto them is the merge offer.
      typePlayerName('James Robinson');

      fireEvent.click(screen.getByRole('button', { name: /same person/ }));

      await waitFor(() =>
        expect(
          screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('Nothing has changed')),
        ).toBe(true),
      );
      expect((screen.getByLabelText('Player name') as HTMLInputElement).value).toBe('James Robinson');
      expect(screen.getByRole('button', { name: /same person/ })).not.toBeDisabled();
    });
  });

  test('a name that would make the two teams the same is refused while it is being typed', () => {
    renderScorer({ procedure: oneTimeout, onCorrectGame: vi.fn() });
    pressControl('Game details');
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Game details' })).getAllByRole('button', {
        name: 'Correct…',
      })[0],
    );

    fireEvent.change(screen.getByLabelText('Team name'), { target: { value: 'Greenwood' } });

    expect(screen.getByRole('alert').textContent).toContain('same name');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('correcting the procedure instead', () => {
  test('applies through the host and shows what it would change first', async () => {
    const correct = vi.fn();
    renderScorer({ procedure: oneTimeout, onCorrectGame: correct });
    pressControl('Game details');
    fireEvent.click(screen.getByRole('button', { name: 'Change…' }));

    fireEvent.change(screen.getByLabelText('Timeouts each team gets'), { target: { value: '2' } });
    expect(screen.getByText('Timeouts per team')).toBeTruthy();
    expect(screen.getByText('1 → 2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Apply corrected procedure' }));
    await waitFor(() => expect(correct).toHaveBeenCalled());
    const correction = correct.mock.calls[0][0] as IGameCorrection;
    expect(correction.procedure?.timeoutsPerTeam).toBe(2);
    expect(correction.summary).toContain('Timeouts per team: 1 → 2');
  });

  test('a refused write leaves the dialog open and says nothing was saved', async () => {
    const correct = vi.fn().mockRejectedValue(new Error('no'));
    renderScorer({ procedure: oneTimeout, onCorrectGame: correct });
    pressControl('Game details');
    fireEvent.click(screen.getByRole('button', { name: 'Change…' }));
    fireEvent.change(screen.getByLabelText('Timeouts each team gets'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply corrected procedure' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Nothing has changed; try again.'),
    );
    // Still open, still holding the proposal, and the button is pressable again.
    expect(screen.getByRole('dialog', { name: 'Room procedure' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply corrected procedure' })).not.toBeDisabled();
  });
});

describe('a correction made offline', () => {
  /**
   * The scorer's own journal is the copy that decides everything, and the server is consulted only
   * when the device has nothing. So a room that loses tournament control mid-correction is a room
   * that finishes its game; a snapshot arriving afterwards cannot take the correction back.
   */
  test('survives a reload, with a disconnected room and a server holding a stale snapshot', async () => {
    gameCounter += 1;
    const gameKey = `offline-correction-${gameCounter}`;
    rememberScoringLayoutChoice(gameKey);
    const recoverFromServer = vi.fn().mockResolvedValue({});
    const render1 = (
      <ScorerHost
        gameKey={gameKey}
        format={formatFor()}
        leftTeam={leftTeam}
        rightTeam={rightTeam}
        tournamentName="Ninety Six Invitational"
        roundName="Round 4"
        procedure={oneTimeout}
        connection={RoomConnectionState.Offline}
        onDownload={() => undefined}
        onSubmit={vi.fn().mockResolvedValue({ ok: true, message: 'Sent' })}
        onRecoverFromServer={recoverFromServer}
      />
    );
    const first = render(render1);

    // Spend the timeout, then record the ruling that allows a second one — all with no network.
    pressControl('Timeout');
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Timeout' })).getByRole('button', { name: /Ninety Six/ }),
    );
    pressControl('Resume play');
    pressControl('Timeout');
    fireEvent.click(screen.getByRole('button', { name: /allowed another one/i }));
    fireEvent.click(screen.getByRole('button', { name: 'We were told we could, this once' }));
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'Director allowed it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record this ruling' }));
    first.unmount();

    // The reload. The local journal wins, and the server is not asked again, because now there is
    // something local to lose. (It was asked on the first mount, when there was not.)
    recoverFromServer.mockClear();
    render(render1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Game' })).toBeTruthy());
    expect(recoverFromServer).not.toHaveBeenCalled();

    pressControl('Game details');
    expect(
      within(screen.getByRole('dialog', { name: 'Game details' })).getByText(/Director allowed it/),
    ).toBeTruthy();
  });
});

describe('the escape route appears only where a setting caused the refusal', () => {
  test('a lineup change the procedure forbids offers a way out', () => {
    renderScorer({
      procedure: {
        version: 3,
        halves: true,
        timeoutsPerTeam: 0,
        substitutionPolicy: 'breaks-timeouts-overtime',
      },
    });
    pressControl('Players');

    expect(screen.getByRole('button', { name: 'Procedure changed?' })).toBeTruthy();
  });

  test('a lineup change a director allowed becomes available on screen, for that team only', () => {
    renderScorer({
      procedure: {
        version: 3,
        halves: true,
        timeoutsPerTeam: 0,
        substitutionPolicy: 'breaks-timeouts-overtime',
      },
    });
    pressControl('Players');

    const leftPanel = () => screen.getByRole('region', { name: 'Ninety Six lineup' });
    const rightPanel = () => screen.getByRole('region', { name: 'Greenwood lineup' });
    expect(within(leftPanel()).getByRole('button', { name: 'Change lineup' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Procedure changed?' }));
    fireEvent.click(screen.getByRole('button', { name: 'We were told we could, this once' }));
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'Late arrival allowed on' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record this ruling' }));

    // The ruling was for the left team, so the way in is open there and nowhere else.
    pressControl('Players');
    expect(within(leftPanel()).getByRole('button', { name: 'Change lineup' })).not.toBeDisabled();
    expect(within(leftPanel()).getByText('One lineup change was allowed')).toBeTruthy();
    expect(within(rightPanel()).getByRole('button', { name: 'Change lineup' })).toBeDisabled();
  });

  test('a lineup change the procedure allows offers nothing', () => {
    renderScorer({ procedure: oneTimeout });
    pressControl('Players');

    expect(screen.queryByRole('button', { name: 'Procedure changed?' })).toBeNull();
  });
});
