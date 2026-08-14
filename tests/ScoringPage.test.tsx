/**
 * What the scoring page must document, and the word it must never use.
 *
 * The structural claim is shared with every page here: the component is prerendered, so it has to
 * render completely from nothing.
 *
 * The claim specific to this page is the format-assumption guard, and it is not a formality. This is
 * the page most tempted to name a ruling, because a concrete example of a two-key sequence is exactly
 * what a reader wants. `KeyboardScoring` resolves every action through `tossupRulings`, so the meaning
 * of the second key is whatever the tournament's format defines, and a format without that ruling
 * leaves the key inert. Naming one would be wrong about the software as well as wrong for the reader
 * whose tournament does not have it.
 *
 * The rest is that the page documents corrections and recovery rather than only the happy path: undo,
 * correcting an earlier question mid-round, lineup changes governed by the tournament's procedure, and
 * the synchronous write on every accepted event.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import Scoring from '../src/about/Scoring';

/** An element's words with the JSX line breaks taken out. See `TournamentsPage.test.tsx`. */
function words(element: Element | null): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ');
}

describe('the scoring page', () => {
  test('states what the scorekeeper does and what QBSheet does', () => {
    const { container } = render(<Scoring />);

    expect(screen.getByRole('heading', { level: 1, name: 'Scoring with QBSheet' })).toBeInTheDocument();
    const hero = words(container.querySelector('.about-hero'));
    expect(hero).toContain('records who answered each question and what the answer was worth');
    expect(hero).toContain('derives the score, writes the game to the device as it is scored');
  });

  test('documents the per-question sequence as three steps', () => {
    const { container } = render(<Scoring />);

    expect(screen.getByRole('heading', { level: 2, name: 'Scoring a tossup' })).toBeInTheDocument();
    for (const name of ['Record the answer', 'Resolve the tossup', 'Score the bonus']) {
      expect(screen.getByRole('heading', { level: 3, name })).toBeInTheDocument();
    }
    expect(container.querySelector('.about-flow')?.querySelectorAll('.about-stages > li')).toHaveLength(3);

    // The bonus step is conditional in the implementation, so it is conditional here.
    const stages = words(container.querySelector('.about-stages'));
    expect(stages).toContain('When the format defines bonuses');
    expect(stages).toContain('When it does not, the step does not appear');
    expect(stages).toContain('The available outcomes come from the tournament’s scoring rules');
  });

  test('documents corrections and recovery', () => {
    const { container } = render(<Scoring />);

    expect(screen.getByRole('heading', { level: 2, name: 'Corrections and recovery' })).toBeInTheDocument();
    for (const title of ['Undo and redo', 'Correcting an earlier question', 'Lineup changes', 'Local recovery']) {
      expect(screen.getByRole('heading', { level: 3, name: title })).toBeInTheDocument();
    }

    const bands = container.querySelectorAll('.about-band');
    expect(bands).toHaveLength(1);
    const said = words(bands[0] ?? null);
    // A correction is recorded rather than an overwrite, and the journal write is synchronous. Both
    // are properties of the implementation.
    expect(said).toContain('the correction is recorded rather than replacing the original silently');
    expect(said).toContain('written to the device as it is scored, in the same operation rather than afterwards');
    // When substitutions are permitted belongs to the tournament, never to QBSheet.
    expect(said).toContain('When substitutions are permitted is set by the tournament’s room procedure');
  });

  test('documents the keyboard without naming a single ruling', () => {
    const { container } = render(<Scoring />);

    expect(screen.getByRole('heading', { level: 2, name: 'Keyboard shortcuts' })).toBeInTheDocument();
    const keyboard = container.querySelector('.about-keyboard');
    for (const term of ['Seats', 'Outcome keys', 'Unanswered question', 'Undo and redo']) {
      expect(within(keyboard as HTMLElement).getByText(term, { selector: 'dt' })).toBeInTheDocument();
    }

    const said = words(keyboard);
    // The seat numbering and the bindings come from `KeyboardScoring`.
    expect(said).toContain('are the left team’s seats');
    expect(said).toContain('Ctrl/⌘ + Z');
    expect(said).toContain('Ctrl/⌘ + Shift + Z');
    // The second key is described by what decides it, not by what it might be.
    expect(said).toContain('Which keys are active depends on the tournament’s scoring rules');
    expect(said).toContain('a key with no corresponding ruling does nothing');
  });

  test('documents the guided practice game, which nothing else on the site mentions', () => {
    const { container } = render(<Scoring />);

    expect(screen.getByRole('heading', { level: 2, name: 'Guided practice' })).toBeInTheDocument();
    const practice = words(container.querySelector('.about-practice'));
    expect(practice).toContain('runs the real scoresheet through a full round with a prompt at each step');
    expect(practice).toContain('does not require a tournament server or a game file');

    expect(screen.getByRole('link', { name: 'Open the practice game' })).toHaveAttribute('href', '../../');
  });

  test('documents finishing a game on both paths', () => {
    const { container } = render(<Scoring />);

    expect(screen.getByRole('heading', { level: 2, name: 'Finishing a game' })).toBeInTheDocument();
    const finish = words(container.querySelector('.about-finish'));
    expect(finish).toContain('shows the completed scoresheet for review before the game is submitted');
    expect(finish).toContain('the result is downloaded as a QBJ file');
    expect(finish).toContain('remains on the device after it has been handed over');
  });

  test('links out from two directories deep', () => {
    const { container } = render(<Scoring />);

    for (const link of screen.getAllByRole('link', { name: 'Open QBSheet' })) {
      expect(link).toHaveAttribute('href', '../../');
    }
    expect(container.querySelector('.about-brand')).toHaveAttribute('href', '../../');
    for (const link of screen.getAllByRole('link', { name: 'About' })) {
      expect(link).toHaveAttribute('href', '../');
    }
    expect(screen.getByRole('link', { name: 'How connected rooms work' })).toHaveAttribute(
      'href',
      '../tournaments/',
    );

    for (const region of ['.about-nav', '.about-footer nav']) {
      const nav = container.querySelector(region);
      const self = within(nav as HTMLElement).getByRole('link', { name: 'Scoring' });
      expect(self).toHaveAttribute('href', './');
      expect(self).toHaveAttribute('aria-current', 'page');
    }
  });

  test('assumes no quiz bowl format', () => {
    const { container } = render(<Scoring />);
    const said = words(container).toLowerCase();

    // The page most likely to break this rule, and the reason the rule is worth a test here. See the
    // note at the top of this file.
    for (const assumption of ['naqt', 'acf', 'power', 'neg', 'bounce', 'four players a side', 'between tossups']) {
      expect(said).not.toContain(assumption);
    }
  });
});
