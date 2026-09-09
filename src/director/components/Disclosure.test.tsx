/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { Disclosure } from './Disclosure';
import { AdvancedSection, Diagnostics } from './Layout';

const HINT = 'Protocol, storage, and recovery details';

describe('Disclosure trigger hint', () => {
  test('label alone names the button', () => {
    render(
      <Disclosure label="Diagnostics">
        <div>Panel body</div>
      </Disclosure>,
    );

    const trigger = screen.getByRole('button', { name: 'Diagnostics' });
    expect(trigger).not.toHaveAttribute('aria-describedby');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('hint is a description, not part of the accessible name', () => {
    render(
      <Disclosure label="Diagnostics" hint={HINT}>
        <div>Panel body</div>
      </Disclosure>,
    );

    const trigger = screen.getByRole('button', { name: 'Diagnostics' });
    expect(trigger).toHaveDescription(HINT);
    expect(trigger.textContent).toContain(HINT);
  });

  test('toggling keeps disclosure state and panel wiring', () => {
    render(
      <Disclosure label="Diagnostics" hint={HINT}>
        <div>Panel body</div>
      </Disclosure>,
    );

    const trigger = screen.getByRole('button', { name: 'Diagnostics' });
    const panelId = trigger.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(panelId!)).not.toHaveAttribute('hidden');
    expect(screen.getByText('Panel body')).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(panelId!)).toHaveAttribute('hidden');
  });

  test('multiple disclosures keep unique label, hint, and panel ids', () => {
    render(
      <>
        <Disclosure label="First" hint="First hint">
          <div>First body</div>
        </Disclosure>
        <Disclosure label="Second" hint="Second hint">
          <div>Second body</div>
        </Disclosure>
      </>,
    );

    const first = screen.getByRole('button', { name: 'First' });
    const second = screen.getByRole('button', { name: 'Second' });
    expect(first).toHaveDescription('First hint');
    expect(second).toHaveDescription('Second hint');
    const ids = [
      first.getAttribute('aria-labelledby'),
      first.getAttribute('aria-describedby'),
      first.getAttribute('aria-controls'),
      second.getAttribute('aria-labelledby'),
      second.getAttribute('aria-describedby'),
      second.getAttribute('aria-controls'),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('Diagnostics and AdvancedSection pass hints through as descriptions', () => {
    render(
      <>
        <Diagnostics hint={HINT}>
          <div>Diagnostic body</div>
        </Diagnostics>
        <AdvancedSection label="Advanced packet settings" hint="Packet internals">
          <div>Advanced body</div>
        </AdvancedSection>
      </>,
    );

    expect(screen.getByRole('button', { name: 'Diagnostics' })).toHaveDescription(HINT);
    expect(screen.getByRole('button', { name: 'Advanced packet settings' })).toHaveDescription(
      'Packet internals',
    );
  });
});
