import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { DirectorToast } from './DirectorToast';
import { errorNotice, infoNotice, toDirectorNotice, warningNotice } from '../notices';

describe('DirectorToast tones', () => {
  test('a plain string keeps the success treatment with status semantics', () => {
    render(<DirectorToast announcement="Checkpoint created." />);
    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('Checkpoint created.');
    expect(toast.className).not.toMatch(/error|warning|info/);
    // Success keeps the check icon and has no alert icon.
    expect(toast.querySelector('svg')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('an error notice uses alert semantics and never the success check', () => {
    const { container } = render(
      <DirectorToast announcement={errorNotice('Checkpoint could not be saved.')} />,
    );
    const toast = screen.getByRole('alert');
    expect(toast).toHaveTextContent('Checkpoint could not be saved.');
    expect(toast.className).toMatch(/director-toast-error/);
    // The rendered icon is the alert icon, not the success check: exactly one svg, inside an
    // error-toned toast.
    expect(container.querySelectorAll('.director-toast-error svg')).toHaveLength(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('info stays neutral with status semantics', () => {
    render(<DirectorToast announcement={infoNotice('Tournament archived.')} />);
    const toast = screen.getByRole('status');
    expect(toast.className).toMatch(/director-toast-info/);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('warning gets warning treatment without alert semantics', () => {
    render(<DirectorToast announcement={warningNotice('Two rooms share a name.')} />);
    const toast = screen.getByRole('status');
    expect(toast.className).toMatch(/director-toast-warning/);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('dismiss notifies the shell', () => {
    const onDismiss = vi.fn();
    render(<DirectorToast announcement="Saved." onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('toDirectorNotice', () => {
  test('bare strings preserve legacy success treatment', () => {
    expect(toDirectorNotice('Saved.')).toEqual({ message: 'Saved.', tone: 'success' });
  });

  test('toned notices pass through unchanged', () => {
    const notice = errorNotice('Failed.');
    expect(toDirectorNotice(notice)).toBe(notice);
  });
});
