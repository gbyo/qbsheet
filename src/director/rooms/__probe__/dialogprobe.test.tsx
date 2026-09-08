import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Dialog } from '../../../src/director/components/Dialog';

test('dialog renders in jsdom', () => {
  render(
    <Dialog title="Probe" onClose={() => {}} submitLabel="Save" onSubmit={() => {}}>
      <input aria-label="Field" />
    </Dialog>,
  );
  expect(screen.getByRole('dialog', { hidden: true })).toBeTruthy();
  expect(screen.getByLabelText('Field')).toBeTruthy();
});
