# @qbsheet/ui

The shared design tokens and interaction primitives for QBSheet web interfaces.

## Reference language

QBSheet Scorer is the reference visual implementation. The shared layer captures the language
already used by Scorer: flat ruled surfaces, restrained radii and elevation, compact practical
spacing, strong numerical hierarchy, semantic state colour, and blue reserved primarily for active
or primary interaction. The initial migration is an ownership change, not a Scorer redesign.

The shared light and dark palettes, IBM Plex typography stack, spacing, radii, control sizing,
focus, elevation, and motion values belong in `@qbsheet/ui`. New shared values use the `--qbs-*`
namespace.

## Contents

```text
src/tokens.css        canonical light/dark design tokens
src/room-compat.css   --room-* aliases used by the existing Scorer stylesheets
src/components.css    token-driven styling for the shared primitives
src/components/       Button · Tabs · ConfirmDialog · TextField · TeamComboBox
                      Notice · StatusBadge
```

`room-compat.css` is intentionally small and contains aliases, not another palette. It lets Scorer
keep its established CSS structure while `tokens.css` owns the values. New code should use the
canonical `--qbs-*` names.

## Boundaries

- Shared tokens answer “what does a QBSheet web interface look like?” Application layout remains
  application-specific: page grids, sidebars, rails, breakpoints, and content widths stay with the
  application that needs them.
- Shared controls use the canonical tokens. `react-aria-components` supplies behavior such as
  keyboard interaction, focus management, dialog focus trapping, and ARIA relationships; QBSheet
  supplies the appearance.
- Introduce a shared component only when multiple surfaces genuinely benefit from the same
  interaction or behavior. Native HTML is preferred for ordinary sections, tables, lists, and
  static text.
- Avoid unnecessary cards, gradients, pills, decorative shadows, and generic “modern SaaS”
  styling. Prefer 1px rules and adjoining surfaces for structure.
- Use colour to communicate state, not decoration. Status must not rely on colour alone.
- Recovery Mode may load `room-compat.css`, which is CSS-only. It must not depend on the normal
  Scorer React/component bundle or application bootstrap.

## Consumers

- Scorer and its application shell use `room-compat.css`; their existing `--room-*` selectors remain
  intact while the values resolve from the canonical theme.
- Recovery Mode uses the same CSS-only compatibility entry point and stays independently bootable.
- Director keeps its `--director-*` aliases for reviewable migration while those names resolve to
  the Scorer-led shared values.
- Director uses the canonical tokens and the shared controls directly.
