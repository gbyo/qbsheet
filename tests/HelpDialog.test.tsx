/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { HelpDialog } from '../src/director/help/HelpDialog';

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(() => {
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

describe('Director help dialog', () => {
  test('reports one close when controlled state catches up after the close button', () => {
    const onClose = vi.fn();
    const { rerender } = render(<HelpDialog open onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<HelpDialog open={false} onClose={onClose} />);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * The only two links in Director that leave Director.
   *
   * Followed in place, `https://github.com/…` replaces the running tournament with a documentation
   * page, and the Director window has no address bar and no back button to return with. Every
   * external link on the About site already opens in a new context and says so in words; these two
   * did neither.
   */
  test('the documentation links open away from the running tournament, and say so', () => {
    render(<HelpDialog open onClose={vi.fn()} />);

    for (const name of ['QBTCP', 'QBLive']) {
      const link = screen.getByRole('link', { name: `${name} (opens in a new tab)` });
      expect(link.getAttribute('href')).toContain('github.com/gbyo/qbsheet');
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  test('the table of contents still moves within the dialog rather than out of it', () => {
    render(<HelpDialog open onClose={vi.fn()} />);

    const toc = screen.getByRole('navigation', { name: 'Help sections' });
    for (const link of Array.from(toc.querySelectorAll('a'))) {
      expect(link.getAttribute('href')).toMatch(/^#help-/);
      expect(link.getAttribute('target')).toBeNull();
    }
  });
});
