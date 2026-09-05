/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import RulingPicker from '../src/scorer/RulingPicker';

afterEach(() => cleanup());

describe('RulingPicker', () => {
  test('dismisses once for a touch-style pointer outside the picker', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    const onDismiss = vi.fn();

    render(
      <RulingPicker
        playerName="Avery"
        teamName="Wildcats"
        choices={[{ kind: 'wrong', label: '0', name: 'No penalty' }]}
        anchor={anchor}
        id="ruling-picker"
        onChoose={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Ruling for Avery, Wildcats' })).toBeTruthy();

    fireEvent.pointerDown(document.body, { pointerType: 'touch' });
    fireEvent.mouseDown(document.body);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(false);

    anchor.remove();
  });
});
