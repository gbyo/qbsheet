import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import HelpTooltip from './HelpTooltip';

afterEach(cleanup);

describe('HelpTooltip', () => {
  test('names the help control and exposes its explanation as a description', () => {
    render(<HelpTooltip label="What is a neg?">A neg is a penalty for an incorrect early buzz.</HelpTooltip>);

    const trigger = screen.getByRole('button', { name: 'What is a neg?' });
    expect(trigger).toHaveAccessibleDescription('A neg is a penalty for an incorrect early buzz.');
    expect(screen.getByRole('tooltip')).toHaveTextContent('A neg is a penalty for an incorrect early buzz.');
  });

  test('Escape dismisses a keyboard-open tooltip without moving focus', () => {
    render(<HelpTooltip label="About timed rounds">The moderator calls time.</HelpTooltip>);

    const trigger = screen.getByRole('button', { name: 'About timed rounds' });
    const wrapper = trigger.closest('.help-tooltip');
    trigger.focus();
    expect(trigger).toHaveFocus();

    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(wrapper).toHaveAttribute('data-dismissed', 'true');
  });

  test('the next focus, click, or pointer entry clears dismissal', () => {
    render(<HelpTooltip label="About timed rounds">The moderator calls time.</HelpTooltip>);

    const trigger = screen.getByRole('button', { name: 'About timed rounds' });
    const wrapper = trigger.closest('.help-tooltip');
    trigger.focus();

    fireEvent.keyDown(trigger, { key: 'Escape' });
    fireEvent.click(trigger);
    expect(wrapper).not.toHaveAttribute('data-dismissed');

    fireEvent.keyDown(trigger, { key: 'Escape' });
    trigger.blur();
    trigger.focus();
    expect(wrapper).not.toHaveAttribute('data-dismissed');

    fireEvent.keyDown(trigger, { key: 'Escape' });
    fireEvent.pointerEnter(wrapper!);
    expect(wrapper).not.toHaveAttribute('data-dismissed');
  });
});
