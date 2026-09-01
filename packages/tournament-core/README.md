# `@qbsheet/tournament-core`

The platform-neutral tournament domain used by QBSheet Director. It contains no React, Tauri,
SQLite, network, or file-system code. A native or browser host owns persistence and transport; this
package owns the objects and decisions that must remain consistent regardless of host.

## Boundaries

- `model.ts` defines the serializable tournament snapshot and small immutable entity operations.
- `rules.ts` provides standard rulesets and rules validation.
- `scheduling.ts` generates deterministic round-robin and pool schedules and reports conflicts.
- `results.ts` validates submissions, fingerprints raw payloads, and creates accepted game results.
- `statistics.ts` derives team/player statistics and ranks by configured tiebreakers.
- `advancement.ts` previews pool advancement/rebracketing and refuses ambiguous cut lines without an
  explicit policy or override.
- `preflight.ts` checks whether a snapshot is ready to start, including optional QBTCP and storage
  capabilities.

All operations are pure or return a new `TournamentSnapshot`; callers can persist the resulting
snapshot in SQLite, an archive, or another store without leaking storage rows into the UI.

## Example

```ts
import {
  createTournament,
  defaultRules,
  generateRoundRobinSchedule,
  runPreflight,
} from '@qbsheet/tournament-core';

const tournament = createTournament({ name: 'Saturday Invitational' });
const schedule = generateRoundRobinSchedule({
  phaseId: 'prelim',
  teams: [],
});
const preflight = runPreflight({ tournament, schedule: schedule.games });
```

The example intentionally leaves the teams empty: hosts should load real registrations before
generating a schedule. The package does not ship tournament fixtures or fake application state.
