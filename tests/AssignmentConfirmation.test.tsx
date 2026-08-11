/**
 * The step between an assignment and a scoresheet.
 *
 * Every mistake this card exists to catch is one that cannot be caught afterwards: a round scored
 * against the wrong pairing has to be thrown out, and a round read from the wrong packet is worse
 * because the result looks fine. So the assertions are about the card being *specific* — the round, the
 * room and the packet each said plainly — and about it never becoming a wall between a room and a game
 * it has been told to play.
 */
import { act, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import AssignmentConfirmation, {
  assignmentLine,
  problemMessage,
} from '../src/app/AssignmentConfirmation';
import { needsAssignmentConfirmation } from '../src/app/App';
import { IStoredGameRecord } from '../src/game/GameStore';
import { HelpRequestCategory } from '../src/app/HelpRequests';
import { validPackage } from './packages';

function packageWith(overrides: Parameters<typeof validPackage>[0] = {}) {
  return validPackage(overrides);
}

/** Render the card and hand back the two callbacks a test asserts on. */
function open(options: { canReport?: boolean; reportFails?: boolean; packageOverrides?: object } = {}) {
  const onConfirm = vi.fn();
  const onBack = vi.fn();
  // Typed explicitly so `mock.calls[0]` is the two arguments the card sends rather than an empty tuple
  // inferred from a zero-parameter implementation.
  const onReportProblem = vi.fn<(category: HelpRequestCategory, message: string) => Promise<{ ok: boolean; error?: string }>>(
    async () =>
      options.reportFails === true ? { ok: false, error: 'Tournament control did not answer.' } : { ok: true },
  );
  render(
    <AssignmentConfirmation
      packageValue={packageWith(options.packageOverrides ?? {})}
      onReportProblem={options.canReport === false ? undefined : onReportProblem}
      onConfirm={onConfirm}
      onBack={onBack}
    />,
  );
  return { onConfirm, onBack, onReportProblem };
}

async function press(name: string) {
  await act(async () => {
    screen.getByRole('button', { name }).click();
  });
}

describe('what the card says', () => {
  test('the round and the room, together, as one line to read out', () => {
    open({ packageOverrides: { round: { number: 5, name: 'Round 5', revision: 1, packetName: '5' }, room: { name: 'Room 204' } } });

    expect(screen.getByText('Round 5 · Room 204')).toBeInTheDocument();
  });

  test('the round alone when the tournament named no room', () => {
    expect(assignmentLine(packageWith({ round: { number: 5, name: 'Round 5', revision: 1 }, room: undefined }))).toBe(
      'Round 5',
    );
  });

  test('the packet, prominently, because that is the one nobody checks', () => {
    open({ packageOverrides: { round: { number: 5, name: 'Round 5', revision: 1, packetName: '5' } } });

    expect(screen.getByText('Packet 5')).toBeInTheDocument();
  });

  test('a round with no packet named says so rather than staying silent', () => {
    // Silence here reads as "the packet is fine". It is the case where a wrong packet cannot be caught
    // by reading the screen at all, so it is stated.
    open({ packageOverrides: { round: { number: 5, name: 'Round 5', revision: 1 } } });

    expect(screen.getByText('No packet named for this round')).toBeInTheDocument();
  });

  test('the matchup and the tournament', () => {
    open();

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByText(packageWith().tournament.name)).toBeInTheDocument();
  });
});

describe('confirming', () => {
  test('one press starts the game', async () => {
    const { onConfirm } = open();

    await press('Everything matches');

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test('the room can go back without starting', async () => {
    const { onBack, onConfirm } = open();

    await press('Back to the room');

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('the three things that are actually wrong', () => {
  test.each(['Wrong teams', 'Wrong packet', 'Wrong round'])('%s is one press, not a text box', async (label) => {
    open();

    expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    await press(label);
    expect(screen.getByRole('heading', { name: label })).toBeInTheDocument();
  });

  test('the report reaches tournament control with the assignment attached', async () => {
    const { onReportProblem } = open({
      packageOverrides: { round: { number: 5, name: 'Round 5', revision: 1, packetName: '5' }, room: { name: 'Room 204' } },
    });

    await press('Wrong packet');
    await press('Tell tournament control');

    expect(onReportProblem).toHaveBeenCalledTimes(1);
    const [category, message] = onReportProblem.mock.calls[0];
    // The category tournament control already triages on, not one this client invented.
    expect(category).toBe('question-packet');
    // The whole point of the report is that control and the room disagree about the assignment, and
    // control cannot see this screen — so it travels with the message rather than being asked for.
    expect(message).toContain('Round 5 · Room 204');
    expect(message).toContain('Packet: 5.');
  });

  test('the two problems that share a wire category are still distinguishable', () => {
    const teams = problemMessage('wrong-teams', packageWith(), '');
    const round = problemMessage('wrong-round', packageWith(), '');

    expect(teams).toContain('Wrong teams');
    expect(round).toContain('Wrong round');
    expect(teams).not.toEqual(round);
  });

  test('what the scorekeeper typed is appended, and an empty note is still actionable', () => {
    expect(problemMessage('wrong-packet', packageWith(), '  reader has packet 6  ')).toContain(
      'Room says: reader has packet 6',
    );
    expect(problemMessage('wrong-packet', packageWith(), '   ')).not.toContain('Room says');
  });

  test('the card says what is already attached, so nobody retypes the round', async () => {
    open();

    await press('Wrong teams');

    expect(screen.getByText(/sent automatically/)).toBeInTheDocument();
  });
});

describe('never a wall between a room and a game', () => {
  test('after reporting, the game can still be started', async () => {
    // A director's answer to "we have the wrong packet" is often "read it anyway". Software that
    // refuses until a flag clears is software that gets worked around by reloading the page.
    const { onConfirm } = open();

    await press('Wrong packet');
    await press('Tell tournament control');
    expect(screen.getByRole('status')).toHaveTextContent('Tournament control has been told');

    await press('Start anyway');

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test('a report that could not be sent says so and still allows scoring', async () => {
    open({ reportFails: true });

    await press('Wrong packet');
    await press('Tell tournament control');

    expect(screen.getByRole('alert')).toHaveTextContent('Tournament control did not answer.');
    // The sentence that matters: the game is not lost because a help request was not.
    expect(screen.getByRole('alert')).toHaveTextContent('can still be scored');
  });

  test('a file game says to find staff rather than hiding the problem buttons', async () => {
    open({ canReport: false });

    expect(screen.getByRole('button', { name: 'Wrong packet' })).toBeInTheDocument();
    expect(screen.getByText(/cannot notify tournament control/)).toBeInTheDocument();

    // And choosing one does not offer a send button that would do nothing.
    await press('Wrong packet');
    expect(screen.queryByRole('button', { name: 'Tell tournament control' })).toBeNull();
  });
});

describe('when the card appears at all', () => {
  const record = (events: unknown[]): IStoredGameRecord =>
    ({ completedAt: undefined, events } as unknown as IStoredGameRecord);

  test('a game with nothing scored into it is confirmed', () => {
    expect(needsAssignmentConfirmation(record([]))).toBe(true);
  });

  test('a room resuming mid-round is not asked to re-approve its own game', () => {
    // It has already checked the packet, and it is under more time pressure than it was at kickoff.
    expect(needsAssignmentConfirmation(record([{ id: 'e1' }]))).toBe(false);
  });

  test('a finished game is never confirmed', () => {
    expect(
      needsAssignmentConfirmation({ completedAt: '2026-04-11T15:00:00Z', events: [] } as unknown as IStoredGameRecord),
    ).toBe(false);
  });
});
