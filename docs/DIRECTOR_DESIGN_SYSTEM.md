# Director Design System

How Director looks and behaves, and the rules that keep it one application
rather than several admin interfaces sharing a sidebar.

Read `DIRECTOR_PRODUCT_PRINCIPLES.md` first. That document says *what* should be
visible; this one says *how* it is built.

## The shape of the code

```
src/director/styles/
  tokens.css      every value: type scale, control heights, spacing, surfaces,
                  borders, radii, status tones, focus, elevation, z-index
  base.css        reset, document typography, focus, type utilities
  controls.css    every interactive primitive
  surfaces.css    page rhythm, panels, sections, status, empty states, metadata
  tables.css      the table contract, including responsive column priority
  dialogs.css     one modal/sheet/confirmation language
  shell.css       sidebar, navigation, top bar, search, responsive behaviour
  pages/*.css     rules only that destination needs
src/director/components/
  the control layer; `index.ts` is the barrel every feature imports from
```

A page-level file may compose tokens and layer classes. **It may not redefine a
control, a status colour, or a type size.** If a feature needs a control that
does not exist, it goes in `components/`, not in the feature.

## Typography

Six levels, each with a job. Nothing operationally important below 13px.

| Token | Size | Used for |
| --- | --- | --- |
| `--director-text-display` | 28px | the startup screen only |
| `--director-text-title` | 22px | page `<h1>` |
| `--director-text-section` | 16px | panel and section headings |
| `--director-text-subhead` | 14px semibold | sub-sections, dialog groups |
| `--director-text-body` | 14px | body copy, controls, table cells |
| `--director-text-secondary` | 13px | supporting copy, field labels, hints |
| `--director-text-meta` | 12px | table headers, timestamps, counts, badges |
| `--director-text-micro` | 11px | keycaps only |

The font is the platform UI face. Director loads no webfont.

Ink is a hierarchy: `--director-ink` carries information, `--director-muted`
supports it, `--director-faint` timestamps it. Anything the operator has to act
on is `ink` or a status tone — never `faint`.

## Controls

`--director-control-md` (36px) is the default; `sm` (32px) is for genuinely
dense table rows. Icon-only controls are never smaller than
`--director-target-min` (32px).

### Action hierarchy

| Variant | Rule |
| --- | --- |
| `primary` | **One per surface.** The thing the operator came to do. |
| `secondary` | Ordinary actions beside it. The default. |
| `quiet` | Low emphasis, dense toolbars, row actions. |
| `danger` | Destructive or tournament-altering. Outlined. |
| `danger-solid` | **Only** the confirm button in a destructive confirmation. |

Anything that navigates is a `Link`. Anything that only reports state is a
`Badge`. A row with more than one visible action wants an `ActionMenu` — the
literal `•••` is gone; the trigger is the shared `more` icon.

### No raw browser controls

There are no visible native dropdowns, checkboxes, multi-selects, datalists,
`<details>`, or `confirm()` dialogs in Director.

| Instead of | Use |
| --- | --- |
| `<select>` | `Select` (scannable) or `Combobox` (searchable) |
| `<select multiple>` | `MultiSelect` or `Checklist` |
| `<datalist>` | `Combobox` |
| `type="checkbox"` | `Checkbox` / `CheckboxGroup` / `Checklist` |
| `type="radio"` | `RadioGroup` / `ChoiceCards` / `Segmented` |
| `<details>` | `Disclosure` / `AdvancedSection` / `Diagnostics` |
| `confirm()` | `useConfirm()` |
| a timezone text field | `TimeZoneField` |
| a file `<label>` | `FilePicker` / `MenuFileItem` |

Native elements that *stay*, because the platform's behaviour is genuinely
better and the popup is transient rather than part of the page's appearance:
`type="date"`, `type="time"`, `type="file"`, and the real `input` inside every
`Checkbox`/`Switch`/radio (visually hidden, so labels, `indeterminate`, form
participation, and screen-reader roles are the platform's).

## The edit model

One answer to "what happens when I edit something?"

- **Entity editing → a focused `Dialog`.** Teams, players, rooms, staff,
  equipment, packets, day events, games, manual results, announcements. `size="sheet"`
  for surfaces that want to stay beside their list.
- **Inline editing → only one field, low risk, one step.** `InlineEdit`
  commits on blur/Enter, reverts on Escape.
- **Read-only detail → an expanded row or `Specs`.** Never a form.
- **Destructive → `useConfirm()`** with a stated consequence.

## Save semantics

1. **Forms** collect and commit on Save. `useFormState` reports `dirty`, and
   `SaveState` says so on screen. Cancel and Escape discard. Enter submits.
2. **Inline edits** commit on blur/Enter and confirm visibly.
3. **Operations** apply immediately and are `Switch`es or buttons — never
   checkboxes in a form. The `Checkbox`/`Switch` choice *is* the signal.

## Dialog action convention

Header: title, optional description, one icon-only close. **Never Cancel.**
Footer: `Cancel` then the primary action, right-aligned, in that order.
A destructive action goes in `dangerAction`, at the far left.
Escape and the close button do exactly what Cancel does.

## Status

Five tones — `neutral`, `info`, `success`, `warning`, `danger` — and four
presentations. The choice between presentations is about *what kind of thing* is
in the state, never about emphasis:

| Presentation | For |
| --- | --- |
| `Badge` | the state of an object, inline |
| `StateLabel` | the same fact where a pill would out-shout the data |
| `Callout` | a state needing a sentence and usually an action |
| `Panel data-tone` | a container that is itself in that state |

Tinted surfaces mean a status. Nothing is tinted for variety.

## Panels, sections, insets

Three graded answers to "these things belong together":

- `Section` — a heading and content, **no border**. The default.
- `Panel` — a bordered container for a body of content that needs an edge.
  One to three per page.
- `Inset` — a recessed group inside one of those.

## Tables

Tables are right for standings, submissions, and inventory. They are not the
default layout for every operational object — `SummaryList`/`SummaryItem` is,
for rounds, rooms, staff, and transfer locations.

`DataTable` columns declare a priority:

| Priority | Meaning |
| --- | --- |
| 1 | identity. Never hidden. |
| 2 | what the page is *for*. |
| 3 | useful context. Hidden below 1040px. |
| 4 | telemetry and secondary detail. Hidden below 1240px. |

Anything hidden stays reachable in the row's detail surface. No table sets a
`min-width` and blanket `nowrap`; only numeric cells refuse to wrap.

A row gets **at most one visible action** plus an `ActionMenu`.

## Metadata and diagnostics

Identifiers, revisions, session ids, protocol versions, storage backends, and
schema versions go in `Specs` (with `mono: true`) inside `Diagnostics` — a
disclosure labelled for what it is. They must remain reachable; they must not
compete with tournament information.

## Progressive disclosure

`Disclosure`, `AdvancedSection`, and conditional rendering on the tournament's
actual shape. One stage means no stage controls; no QBTCP means no server
controls; no USB means no transfer prominence. Advanced capability is moved a
layer down, never removed.

## Accessibility

- One focus treatment: `--director-focus-outline`, or
  `--director-focus-ring` for controls that paint their own surface. Nothing
  removes an outline without setting one of them.
- Every icon-only control takes a required `label`.
- `Dialog` uses native `<dialog>` + `showModal()`, so the focus trap, top
  layer, and Escape are the platform's. Focus starts on the first field and
  returns to the opener.
- Confirmations focus **Cancel**, not the destructive action.
- Custom selects are real `combobox`/`listbox` pairs with
  `aria-activedescendant` and type-ahead. Focus never leaves the trigger.
- Reordering has a keyboard route of equal capability, not a worse one.
- Motion is switched off wholesale under `prefers-reduced-motion`.

## Information architecture

`Overview`, then **Plan** (Teams, Format, Rooms, Packets), **Run** (Tournament
day, Results, Transfers), **Review** (Standings, Exports, QBSheet Live), then
**Settings**. These are the only names for these groups, and they appear in the
sidebar, in Help, and in search results.

Navigation label, page `<h1>`, and search results all read the destination's
name from `labelForSection`. They cannot drift apart.

Legacy `tournament` deep links resolve to Tournament day via
`canonicalSection`. Stored navigation targets must keep resolving.

### Where global things live

| Home | Owns |
| --- | --- |
| Tournament switcher (sidebar top) | switching tournaments; New, Open, Details, Manage |
| Operator (sidebar bottom) | operator identity, Settings, Help |
| Settings (a destination) | everything editable |
| Top bar | global search, and the operational "now" strip |

Global search is a command/entity navigator. It **never** filters a page —
page-local filtering is `SearchField` on the page.

Settings is the canonical editing surface for tournament and operator identity.
Menu entries navigate to it with a deep link rather than opening copies of its
forms.
