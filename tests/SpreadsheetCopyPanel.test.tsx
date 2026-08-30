/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import SpreadsheetCopyPanel from '../src/scorer/SpreadsheetCopyPanel';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
});

function installClipboard(writeText: Clipboard['writeText']): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

describe('SpreadsheetCopyPanel', () => {
  test('copies from the button and gives the safe new-tab instruction', async () => {
    const tsv = 'QBSHEET_GAME\t1\tQBSHEET_TEXT:"game-1"';
    const writeText = vi.fn<Clipboard['writeText']>(async () => undefined);
    installClipboard(writeText);

    render(
      <SpreadsheetCopyPanel
        tsv={tsv}
        gameLabel="Round 7 · Cornell 410–275 Chicago"
        suggestedTabName="R07 Cornell–Chicago"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy game for tournament spreadsheet' }));

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith(tsv);
    expect(screen.getByRole('status')).toHaveTextContent('Game copied');
    expect(screen.getByRole('status')).toHaveTextContent('Round 7 · Cornell 410–275 Chicago');
    expect(screen.getByRole('status')).toHaveTextContent('NEW BLANK TAB');
    expect(screen.getByRole('status')).toHaveTextContent('A1');
    expect(screen.getByRole('status')).toHaveTextContent('NEW TAB → A1 → PASTE');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Never paste into a tab that already contains a QBSheet game.',
    );
  });

  test('shows the complete manual-select fallback when clipboard access fails', async () => {
    const tsv = 'QBSHEET_GAME\t1\tQBSHEET_TEXT:"game-1"';
    installClipboard(vi.fn<Clipboard['writeText']>(async () => Promise.reject(new Error('blocked'))));

    render(<SpreadsheetCopyPanel tsv={tsv} gameLabel="Round 7 · Cornell 410–275 Chicago" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy game for tournament spreadsheet' }));

    const fallback = await screen.findByRole('alert');
    expect(fallback).toHaveTextContent('NEW BLANK TAB');
    expect(fallback).toHaveTextContent('A1');
    expect(screen.getByLabelText('Game text to copy manually')).toHaveValue(tsv);

    fireEvent.click(screen.getByRole('button', { name: 'Select game text' }));
    expect(screen.getByLabelText('Game text to copy manually')).toHaveFocus();
  });
});
