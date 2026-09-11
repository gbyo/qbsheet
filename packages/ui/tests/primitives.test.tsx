/**
 * Behaviour tests for the shared primitives.
 *
 * These check the things React Aria is here to provide and that a hand-rolled control gets wrong:
 * a disabled button that cannot be activated at all, arrow-key movement through tabs, a dialog
 * that traps and restores focus, and a combo box whose value stays the team's identifier however
 * the text is filtered. There are no snapshots and nothing asserts a pixel — CSS is not what
 * breaks a tournament.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import {
  Button,
  ConfirmDialog,
  Notice,
  StatusBadge,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TeamComboBox,
  TextField,
  type TeamOption,
} from '../src';

describe('Button', () => {
  test('activates by pointer and by keyboard', async () => {
    const user = userEvent.setup();
    const press = vi.fn();
    render(<Button onPress={press}>Publish Round 4</Button>);
    const button = screen.getByRole('button', { name: 'Publish Round 4' });

    await user.click(button);
    expect(press).toHaveBeenCalledTimes(1);

    button.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(press).toHaveBeenCalledTimes(3);
  });

  test('a disabled button cannot be activated and is announced as disabled', async () => {
    const user = userEvent.setup();
    const press = vi.fn();
    render(
      <Button isDisabled onPress={press}>
        Publish Round 4
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Publish Round 4' });
    expect(button).toBeDisabled();

    await user.click(button);
    button.focus();
    await user.keyboard('{Enter}');
    expect(press).not.toHaveBeenCalled();
  });
});

describe('Tabs', () => {
  function Harness() {
    const [tab, setTab] = useState('rooms');
    return (
      <Tabs aria-label="Sections" selectedKey={tab} onSelectionChange={setTab}>
        <TabList aria-label="Sections">
          <Tab id="setup">Tournament</Tab>
          <Tab id="rooms">Rooms</Tab>
          <Tab id="results">Results</Tab>
        </TabList>
        <TabPanel id="setup">Tournament panel</TabPanel>
        <TabPanel id="rooms">Rooms panel</TabPanel>
        <TabPanel id="results">Results panel</TabPanel>
      </Tabs>
    );
  }

  test('the current tab is announced as selected and shows only its own panel', () => {
    render(<Harness />);
    expect(screen.getByRole('tab', { name: 'Rooms' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('Rooms panel')).toBeInTheDocument();
    expect(screen.queryByText('Results panel')).not.toBeInTheDocument();
  });

  test('arrow keys move between tabs, which a row of buttons does not do', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('tab', { name: 'Rooms' }).focus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Results panel')).toBeInTheDocument();

    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Tournament' })).toHaveAttribute('aria-selected', 'true');
  });

  test('the whole tab list is one tab stop', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Harness />
        <button type="button">After</button>
      </>,
    );
    screen.getByRole('tab', { name: 'Rooms' }).focus();
    await user.tab();
    // Into the panel, then out — never through the other two tabs.
    expect(screen.getByRole('tab', { name: 'Tournament' })).not.toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Results' })).not.toHaveFocus();
  });
});

describe('ConfirmDialog', () => {
  function Harness({ onConfirm = vi.fn(), onCancel = vi.fn() }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onPress={() => setOpen(true)}>Switch Round</Button>
        <ConfirmDialog
          isOpen={open}
          title="Switch to Round 5?"
          confirmLabel="Switch Round"
          onConfirm={() => {
            setOpen(false);
            onConfirm();
          }}
          onCancel={() => {
            setOpen(false);
            onCancel();
          }}
        >
          Team selections will be cleared.
        </ConfirmDialog>
      </>
    );
  }

  test('opens as a named dialog and moves focus into it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Switch Round' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Switch to Round 5?' });
    expect(within(dialog).getByText('Team selections will be cleared.')).toBeInTheDocument();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  test('Escape cancels and returns focus to whatever opened it', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<Harness onCancel={onCancel} onConfirm={onConfirm} />);
    const trigger = screen.getByRole('button', { name: 'Switch Round' });

    await user.click(trigger);
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  test('confirming reports the confirmation and nothing else', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<Harness onCancel={onCancel} onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: 'Switch Round' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Switch Round' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('Cancel comes before the confirmation in the tab order', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Switch Round' }));
    const dialog = await screen.findByRole('alertdialog');
    const buttons = within(dialog).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Cancel', 'Switch Round']);
  });
});

describe('TextField', () => {
  test('the label, the hint and the value are connected to the input', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = useState('');
      return (
        <TextField
          label="Relay URL"
          value={value}
          onChange={setValue}
          description="The address the rooms connect to."
        />
      );
    }
    render(<Harness />);

    const input = screen.getByRole('textbox', { name: 'Relay URL' });
    expect(input).toHaveAccessibleDescription('The address the rooms connect to.');
    await user.type(input, 'https://relay.example');
    expect(input).toHaveValue('https://relay.example');
  });
});

describe('TeamComboBox', () => {
  const options: TeamOption[] = [
    { id: 'Team_Providence A', name: 'Providence A' },
    { id: 'Team_Providence B', name: 'Providence B' },
    { id: 'Team_Wren A', name: 'Wren A' },
    { id: 'Team_Dorman', name: 'Dorman', detail: 'Prelim B' },
    { id: 'Team_Dorman_2', name: 'Dorman', detail: 'Prelim A' },
  ];

  function Harness({ onSelect = vi.fn() }: { onSelect?: (id: string | null) => void }) {
    const [selected, setSelected] = useState<string | null>(null);
    return (
      <TeamComboBox
        label="Left team in Room 101"
        options={options}
        selectedId={selected}
        onSelect={(id) => {
          setSelected(id);
          onSelect(id);
        }}
      />
    );
  }

  test('typing filters, and choosing yields the team identifier rather than the text', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);

    const input = screen.getByRole('combobox', { name: 'Left team in Room 101' });
    await user.type(input, 'prov');

    const listbox = await screen.findByRole('listbox');
    const names = within(listbox)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(names).toEqual(['Providence A', 'Providence B']);

    await user.click(within(listbox).getByRole('option', { name: 'Providence B' }));
    // The identity, never the display string.
    expect(onSelect).toHaveBeenCalledWith('Team_Providence B');
    expect(input).toHaveValue('Providence B');
  });

  test('is fully keyboard operable', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);

    const input = screen.getByRole('combobox', { name: 'Left team in Room 101' });
    input.focus();
    await user.keyboard('{ArrowDown}');
    await screen.findByRole('listbox');
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(String(onSelect.mock.calls[0][0])).toMatch(/^Team_/);
  });

  test('matching is a plain substring, so a near-miss is never offered as a match', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Left team in Room 101' });

    await user.type(input, 'Wren B');
    const listbox = await screen.findByRole('listbox');
    // "Wren A" is not a fuzzy match for "Wren B". No team is offered — the only thing in the
    // list is the empty state, which React Aria renders as an option so the list is not silent.
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['No team matches that.']);
    expect(input).toHaveValue('Wren B');
  });

  test('two teams with the same name stay distinguishable', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole('combobox', { name: 'Left team in Room 101' }), 'Dorman');

    const listbox = await screen.findByRole('listbox');
    const rendered = within(listbox)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(rendered).toEqual(['DormanPrelim B', 'DormanPrelim A']);
  });

  test('clearing removes the selection without choosing another team', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const input = screen.getByRole('combobox', { name: 'Left team in Room 101' });

    await user.type(input, 'Wren');
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Wren A' }));
    expect(onSelect).toHaveBeenLastCalledWith('Team_Wren A');

    await user.click(screen.getByRole('button', { name: 'Clear Left team in Room 101' }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(input).toHaveValue('');
  });
});

describe('status is never carried by colour alone', () => {
  test('a badge states its status in words', () => {
    render(<StatusBadge tone="success">Result received</StatusBadge>);
    expect(screen.getByText('Result received')).toBeInTheDocument();
  });

  test('a notice labels its tone and can be a live region when it should be', () => {
    const { rerender } = render(
      <Notice tone="danger" live="assertive">
        Publishing failed.
      </Notice>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Problem:');
    expect(screen.getByRole('alert')).toHaveTextContent('Publishing failed.');

    rerender(
      <Notice tone="success" live="polite">
        Saved.
      </Notice>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Done:');
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');

    // A notice that is simply part of the page announces nothing.
    rerender(<Notice tone="warning">Check the roster.</Notice>);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('Check the roster.')).toBeInTheDocument();
  });
});
