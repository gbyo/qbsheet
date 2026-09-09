import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { GlobalSearch, rankSearchResults, type SearchResultView } from './DirectorShell';
import { pageSearchTargets, revealSettingsTarget, settingsSearchTargets } from './searchTargets';

/**
 * What global search is for: finding a destination, a setting, or a thing, by
 * whatever the operator would type for it.
 *
 * The ranking is tested on its own because that is where the judgement is. A
 * subsequence scorer will match `standings` against "Venue · Settings ·
 * Tournament details" — every letter is in there somewhere — so "does the right
 * answer come first" is a weaker claim than the one worth making, which is that
 * the wrong answers are not offered at all.
 */

const pages: SearchResultView[] = pageSearchTargets.map((page) => ({
  id: `page:${page.section}`,
  kind: 'page',
  section: page.section,
  label: page.label,
  detail: page.detail,
  keywords: page.keywords,
  group: null,
}));

const settings: SearchResultView[] = settingsSearchTargets.map((setting) => ({
  id: `setting:${setting.id}`,
  kind: 'setting',
  section: 'settings',
  label: setting.label,
  detail: setting.detail,
  keywords: setting.keywords,
  settingsEntityId: setting.entityId,
  settingsPanelId: setting.panelId,
  settingsFieldLabel: setting.fieldLabel,
  group: null,
}));

const northview: SearchResultView = {
  id: 'team-1',
  kind: 'entity',
  section: 'teams',
  label: 'Northview A',
  detail: 'Northview High · confirmed',
  keywords: ['A', 'confirmed', 'Northview High', 'team'],
  entityType: 'team',
  group: 'Plan',
};

const index = [...pages, ...settings, northview];

function labels(query: string): string[] {
  return rankSearchResults(index, query).flatMap((group) => group.results.map((result) => result.label));
}

describe('global search ranking', () => {
  test('a destination is found by its own name and by what it is for', () => {
    expect(labels('standings')[0]).toBe('Standings');
    // "roster" is nowhere in the Teams label or description; it is what a
    // director calls the thing.
    expect(labels('roster')).toContain('Teams');
    expect(labels('lunch')).toContain('Tournament day');
  });

  test('an individual setting is found by the word it is called, not its panel', () => {
    expect(labels('timezone')[0]).toBe('Tournament timezone');
    expect(labels('tz')[0]).toBe('Tournament timezone');
    expect(labels('question set')[0]).toBe('Question set');
    expect(labels('audit')).toContain('Audit history');
  });

  test('a typo still finds it', () => {
    expect(labels('northvew')).toContain('Northview A');
    expect(labels('recovry')[0]).toBe('Recovery');
  });

  test('scorer noise is not offered', () => {
    // Every letter of "standings" appears, in order, in "Venue · Settings ·
    // Tournament details". Only the floor keeps it out of the list.
    expect(labels('standings')).not.toContain('Venue');
    expect(labels('lunch')).not.toContain('Venue');
  });

  test('no query offers nothing, and no match offers nothing', () => {
    expect(rankSearchResults(index, '')).toEqual([]);
    expect(rankSearchResults(index, '   ')).toEqual([]);
    expect(rankSearchResults(index, 'zzzzqqq')).toEqual([]);
  });

  test('the list is capped and the group that answers the query leads', () => {
    const groups = rankSearchResults(index, 'e');
    expect(groups.flatMap((group) => group.results)).toHaveLength(12);

    expect(rankSearchResults(index, 'northview')[0]?.heading).toBe('Tournament');
    expect(rankSearchResults(index, 'timezone')[0]?.heading).toBe('Settings');
    expect(rankSearchResults(index, 'standings')[0]?.heading).toBe('Pages');
  });
});

function Harness({ onSelect }: { onSelect: (result: SearchResultView) => void }) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <GlobalSearch value={value} onChange={setValue} results={index} onSelect={onSelect} inputRef={inputRef} />
  );
}

function field() {
  return screen.getByRole('combobox', { name: 'Search the tournament' });
}

describe('GlobalSearch', () => {
  test('offers nothing until there is a query', () => {
    render(<Harness onSelect={vi.fn()} />);
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.change(field(), { target: { value: 'timezone' } });

    expect(screen.getByRole('option', { name: /Tournament timezone/ })).toBeInTheDocument();
  });

  test('groups the results and runs the best match on Enter', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);

    fireEvent.change(field(), { target: { value: 'timezone' } });
    // The heading, not the destination badge on the result itself.
    expect(screen.getByText('Settings', { selector: '[cmdk-group-heading]' })).toBeInTheDocument();

    fireEvent.keyDown(field(), { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({
      kind: 'setting',
      label: 'Tournament timezone',
      settingsEntityId: 'tournament',
      settingsPanelId: 'settings-tournament',
      settingsFieldLabel: 'Tournament timezone',
    });
  });

  test('a page result carries the destination and nothing to deep-link', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);

    fireEvent.change(field(), { target: { value: 'standings' } });
    fireEvent.click(screen.getByRole('option', { name: /Standings/ }));

    expect(onSelect.mock.calls[0][0]).toMatchObject({ kind: 'page', section: 'standings' });
  });

  test('a query that matches nothing says what is searchable', () => {
    render(<Harness onSelect={vi.fn()} />);
    fireEvent.change(field(), { target: { value: 'zzzzqqq' } });

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent(/Nothing matches “zzzzqqq”/);
    expect(screen.getByRole('status')).toHaveTextContent(/Pages, settings, teams/);
  });

  test('Escape clears the query before it gives up the field', () => {
    render(<Harness onSelect={vi.fn()} />);
    const input = field();
    input.focus();
    fireEvent.change(input, { target: { value: 'timezone' } });

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input).toHaveValue('');
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input).not.toHaveFocus();
  });
});

describe('revealSettingsTarget', () => {
  function settingsPanel() {
    document.body.innerHTML = `
      <div id="settings-tournament">
        <label class="director-field-label" for="field-name"><span>Name</span></label>
        <input id="field-name" />
        <label class="director-field-label" for="field-timezone"><span>Tournament timezone</span></label>
        <input id="field-timezone" />
      </div>`;
  }

  test('focuses the field the operator searched for, not the top of the panel', async () => {
    settingsPanel();

    revealSettingsTarget({ panelId: 'settings-tournament', fieldLabel: 'Tournament timezone' });

    await waitFor(() => expect(document.getElementById('field-timezone')).toHaveFocus());
  });

  test('a panel with no field named falls back to the first control inside it', async () => {
    settingsPanel();

    revealSettingsTarget({ panelId: 'settings-tournament' });

    await waitFor(() => expect(document.getElementById('field-name')).toHaveFocus());
  });

  test('a target that names neither panel nor field touches focus at all', async () => {
    settingsPanel();
    const before = document.activeElement;

    revealSettingsTarget({});

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(before);
  });
});
