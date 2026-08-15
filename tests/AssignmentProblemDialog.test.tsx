/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, test, vi } from 'vitest';
import AssignmentProblemDialog, {
  assignmentLine,
  problemMessage,
} from '../src/app/AssignmentProblemDialog';
import { HelpRequestCategory, HelpRequestResult } from '../src/app/HelpRequests';
import { validPackage } from './packages';

type ReportProblem = NonNullable<ComponentProps<typeof AssignmentProblemDialog>['onReportProblem']>;

function open(
  onReportProblem: ReportProblem,
) {
  const onSent = vi.fn();
  const onClose = vi.fn();
  render(
    <AssignmentProblemDialog
      packageValue={validPackage()}
      onReportProblem={onReportProblem}
      onSent={onSent}
      onClose={onClose}
    />,
  );
  return { onSent, onClose };
}

async function press(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
    await Promise.resolve();
  });
}

describe('the wrong-assignment report', () => {
  test('states the assignment without creating a confirmation wall', () => {
    render(
      <AssignmentProblemDialog
        packageValue={validPackage()}
        onReportProblem={vi.fn()}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Something wrong with this game?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wrong teams' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wrong packet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wrong round' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Everything matches' })).toBeNull();
  });

  test('reports the selected problem with the assignment attached and then closes', async () => {
    const onReportProblem = vi.fn(async (_category: HelpRequestCategory, _message: string): Promise<HelpRequestResult> => ({
      kind: 'accepted',
      request: { category: 'question-packet', message: 'reported', id: 'help-1' },
    }));
    const { onSent, onClose } = open(onReportProblem);

    await press('Wrong packet');
    await press('Tell tournament control');

    expect(onReportProblem).toHaveBeenCalledTimes(1);
    const call = onReportProblem.mock.calls[0];
    expect(call).toBeDefined();
    const [category, message] = call!;
    expect(category).toBe('question-packet');
    expect(message).toContain('Round 7 · Room 204');
    expect(message).toContain('Packet: Packet 7.');
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('keeps failure truthful and does not claim the request was delivered', async () => {
    const { onClose } = open(async () => ({ kind: 'unreachable', error: 'Tournament control did not answer.' }));

    await press('Wrong teams');
    await press('Tell tournament control');

    expect(screen.getByText(/The request was not delivered/)).toBeInTheDocument();
    expect(screen.getByText(/start scoring/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('assignment message helpers', () => {
  test('includes the room when it is named and otherwise leaves it out', () => {
    expect(assignmentLine(validPackage())).toBe('Round 7 · Room 204');
    expect(assignmentLine(validPackage({ room: undefined }))).toBe('Round 7');
  });

  test('distinguishes the three human problems and appends an optional note', () => {
    const teams = problemMessage('wrong-teams', validPackage(), '  the roster says Central  ');
    const packet = problemMessage('wrong-packet', validPackage(), 'reader has packet 8');
    const round = problemMessage('wrong-round', validPackage(), '');

    expect(teams).toContain('Wrong teams');
    expect(teams).toContain('Room says: the roster says Central');
    expect(packet).toContain('Wrong packet');
    expect(round).toContain('Wrong round');
    expect(teams).not.toEqual(round);
  });
});
