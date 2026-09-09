/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { Checkbox, CheckboxGroup, ChoiceCards, RadioGroup, Switch } from './Choice';

const HINT = "Marks this player as the team's captain.";

describe('Choice control hints', () => {
  test('Checkbox exposes hint as description, not part of the name', () => {
    render(<Checkbox checked={false} onChange={() => {}} label="Captain" hint={HINT} />);

    const box = screen.getByRole('checkbox', { name: 'Captain' });
    expect(box).toHaveDescription(HINT);
  });

  test('Checkbox keeps hint described when ariaLabel overrides the name', () => {
    render(
      <Checkbox
        checked={false}
        onChange={() => {}}
        label="Captain"
        ariaLabel="Captain for Alex Smith"
        hint={HINT}
      />,
    );

    const box = screen.getByRole('checkbox', { name: 'Captain for Alex Smith' });
    expect(box).toHaveDescription(HINT);
  });

  test('Checkbox combines an external description with its built-in hint', () => {
    render(
      <>
        <p id="external-note">Chosen by the head coach.</p>
        <Checkbox
          checked={false}
          onChange={() => {}}
          label="Captain"
          hint={HINT}
          ariaDescribedBy="external-note"
        />
      </>,
    );

    const box = screen.getByRole('checkbox', { name: 'Captain' });
    expect(box).toHaveDescription(`Chosen by the head coach. ${HINT}`);
  });

  test('RadioGroup exposes its hint as the fieldset description', () => {
    render(
      <RadioGroup
        value="a"
        onChange={() => {}}
        legend="Formation"
        hint="Applies to the next round."
        options={[{ value: 'a', label: 'Alpha' }]}
      />,
    );

    expect(screen.getByRole('group', { name: 'Formation' })).toHaveDescription('Applies to the next round.');
  });

  test('ChoiceCards exposes its hint as the fieldset description', () => {
    render(
      <ChoiceCards
        value="a"
        onChange={() => {}}
        legend="Backend"
        hint="Pick one backend."
        options={[{ value: 'a', title: 'Local' }]}
      />,
    );

    expect(screen.getByRole('group', { name: 'Backend' })).toHaveDescription('Pick one backend.');
  });

  test('CheckboxGroup exposes its hint as the fieldset description', () => {
    render(
      <CheckboxGroup legend="Flags" hint="Checked flags are saved.">
        <Checkbox checked={false} onChange={() => {}} label="Captain" />
      </CheckboxGroup>,
    );

    expect(screen.getByRole('group', { name: 'Flags' })).toHaveDescription('Checked flags are saved.');
  });

  test('Switch keeps both its hint and an external description', () => {
    render(
      <>
        <p id="external-note">Takes effect immediately.</p>
        <Switch
          checked={false}
          onChange={() => {}}
          label="Publishing"
          hint="Pushes results live."
          ariaDescribedBy="external-note"
        />
      </>,
    );

    const control = screen.getByRole('switch', { name: 'Publishing' });
    expect(control).toHaveDescription('Takes effect immediately. Pushes results live.');
  });

  test('repeated controls generate unique hint ids', () => {
    render(
      <>
        <Checkbox checked={false} onChange={() => {}} label="Captain" hint={HINT} />
        <Checkbox checked={false} onChange={() => {}} label="Vice captain" hint={HINT} />
      </>,
    );

    const first = screen.getByRole('checkbox', { name: 'Captain' });
    const second = screen.getByRole('checkbox', { name: 'Vice captain' });
    expect(first).toHaveDescription(HINT);
    expect(second).toHaveDescription(HINT);
    expect(first.getAttribute('aria-describedby')).not.toBe(second.getAttribute('aria-describedby'));
  });
});
