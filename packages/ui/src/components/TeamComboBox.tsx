/**
 * Choosing one entry from a list that may be long.
 *
 * # Why not a native select
 *
 * A twelve-team tournament is fine in a `<select>`. A sixty-team one is not: the operator is
 * scrolling a popup with the mouse while a room waits, and the two entries they are choosing
 * between are "Providence A" and "Providence B" thirty rows apart. Typing `prov` is the whole
 * difference.
 *
 * React Aria's ComboBox is used for the behaviour, which is the part that is genuinely hard:
 * the text input and the listbox share an accessible relationship, arrow keys move the active
 * option without moving focus, Home/End/Escape do what they should, and the announced state
 * stays correct while filtering.
 *
 * # The rules this list follows, because it picks a team in a real game
 *
 * - The value is the team's **identifier**, never its display text. A filter narrows what is
 *   shown and can never change which team is selected.
 * - Matching is a plain case-insensitive substring. No fuzzy matching, no scoring, no
 *   did-you-mean: "Wren B" must never be offered as a near-match for "Wren A".
 * - Typing that matches nothing selects nothing. The previous selection stands until the
 *   operator picks a different entry or clears it.
 * - Two teams whose names are identical stay distinguishable, because the list shows the
 *   disambiguating text the caller supplies.
 */

import { useMemo, useState } from 'react';
import {
  Button as AriaButton,
  ComboBox,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  type Key,
} from 'react-aria-components';

export interface TeamOption {
  id: string;
  name: string;
  /** Shown beside the name where two teams would otherwise read alike. Never part of matching. */
  detail?: string;
}

export interface TeamComboBoxProps {
  label: string;
  options: readonly TeamOption[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  placeholder?: string;
  isDisabled?: boolean;
}

export function TeamComboBox({
  label,
  options,
  selectedId,
  onSelect,
  placeholder = 'Choose a team',
  isDisabled,
}: TeamComboBoxProps) {
  const [filter, setFilter] = useState('');
  const selected = options.find((option) => option.id === selectedId) ?? null;

  const visible = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    if (needle === '') return options;
    return options.filter((option) => option.name.toLocaleLowerCase().includes(needle));
  }, [filter, options]);

  return (
    <ComboBox
      items={visible}
      selectedKey={selectedId}
      isDisabled={isDisabled}
      allowsEmptyCollection
      // The input text is the filter, not the value. Clearing it does not clear the selection;
      // only choosing another team or pressing Clear does.
      inputValue={filter === '' ? (selected?.name ?? '') : filter}
      onInputChange={setFilter}
      onSelectionChange={(key: Key | null) => {
        setFilter('');
        onSelect(key === null ? null : String(key));
      }}
      className="qbs-combobox"
    >
      <Label className="qbs-visually-hidden">{label}</Label>
      <div className="qbs-combobox__control">
        <Input className="qbs-combobox__input" placeholder={placeholder} />
        {selectedId !== null ? (
          <AriaButton
            // Not the ComboBox's own trigger: this clears, and it needs its own name.
            slot={null}
            aria-label={`Clear ${label}`}
            className="qbs-combobox__clear"
            excludeFromTabOrder
            onPress={() => {
              setFilter('');
              onSelect(null);
            }}
          >
            ×
          </AriaButton>
        ) : null}
        <AriaButton className="qbs-combobox__trigger" aria-label={`Show teams for ${label}`}>
          ▾
        </AriaButton>
      </div>
      <Popover className="qbs-combobox__popover">
        <ListBox
          className="qbs-listbox"
          renderEmptyState={() => <div className="qbs-listbox__empty">No team matches that.</div>}
        >
          {(option: TeamOption) => (
            <ListBoxItem id={option.id} textValue={option.name} className="qbs-listbox__item">
              <span className="qbs-listbox__label">{option.name}</span>
              {option.detail ? <span className="qbs-listbox__detail">{option.detail}</span> : null}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </ComboBox>
  );
}
