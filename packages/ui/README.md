# @qbsheet/ui

QBSheet's design tokens and the interaction primitives its surfaces share.

## Why it exists

Director had a mature visual system — a six-level type scale, a 4px spacing rhythm, complete
status triples, one focus ring — and no home for it outside Director. So the next desktop
application, [QBBridge](../../apps/qbbridge), invented a six-variable palette of its own
(`--ink`, `--paper`, `--accent`, `--good`…) and QBSheet had two visual vocabularies within a
month.

This is Director's system under a product-wide name, plus the smallest set of components the
second consumer actually needed.

## What is here

```text
src/tokens.css        type, colour, spacing, radii, control metrics, focus, elevation, motion
src/components.css    the styling for the primitives below; every value is a token
src/components/       Button · Tabs · ConfirmDialog · TextField · TeamComboBox
                      Notice · StatusBadge
```

## The division of labour

`react-aria-components` supplies **behaviour**: keyboard and pointer activation that agree with
each other, focus management, dialog focus trapping and restoration, ARIA relationships, and the
`data-hovered` / `data-pressed` / `data-focus-visible` / `data-disabled` / `data-selected` state
hooks the stylesheet targets.

QBSheet supplies **every pixel**. No third-party theme is imported and no starter CSS is copied.
A QBSheet surface should not look like Adobe's, GitHub's, or anybody else's design system.

## Rules

- **Tokens are the only values.** A component that needs a colour, a size or a duration takes it
  from `tokens.css`. Nothing here declares a literal outside that file.
- **Application layout is not shared.** Director's sidebar width, rail, top-bar height, page
  gutter and page maximum stay in Director. They answer "how is Director laid out", which is
  Director's question.
- **Native HTML stays native.** There is no `Table`, no `Section`, no `DescriptionList` and no
  `Text`. A `<table>` already gives a screen reader row and column context, and wrapping it would
  be a worse version of what the element does. Components exist where behaviour is genuinely
  hard, and nowhere else.
- **Status is never colour alone.** A badge states its status in words; a notice labels its tone.

## Consumers

- `apps/qbbridge` — renders entirely from these tokens and components.
- `src/director` — `styles/tokens.css` is now aliases onto this layer. Its `--director-*` names
  are unchanged, because hundreds of rules reference them and renaming them would be an enormous
  diff that changes no pixel.

## Where this is going

A later focused change can promote this into the full shared design-system package — more
primitives, and Director's own components migrated onto them. This version is deliberately only
what QBBridge justified: enough that QBSheet has one source of truth for how it looks, and
nowhere near a component-library project.
