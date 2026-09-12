/**
 * The `YellowFruit Import` tree is derived output, never authoritative.
 *
 * For a given assignment, the destination filename inside a round batch is deterministic —
 * the same readable name as the assignment itself — so preparing a round twice converges on
 * exactly one file per returned game instead of accumulating suffixed copies. Re-preparing
 * overwrites the previously generated derived copy; IN and OUT originals are never touched
 * by this plan (it only names files inside one import folder).
 *
 * Cleanup is ownership-scoped: the manifest records which derived filenames YF Shuttle wrote
 * (`derivedFiles`, per Match id). A re-prepare removes an owned file only when that Match no
 * longer resolves to it (renamed room, corrected duplicate choice). Files the operator placed
 * by hand are never owned, never removed, and reported back as unknown so the UI can say the
 * folder holds something unexpected.
 */

export interface BatchEntry {
  matchId: string;
  /** Deterministic destination filename for this assignment in this round's batch. */
  destName: string;
}

export interface BatchPlan {
  /** Copies to perform: source OUT bytes → deterministic destination (overwrite is safe). */
  writes: BatchEntry[];
  /** Owned derived files that no longer correspond to any chosen result. Remove these. */
  removals: string[];
  /** Existing files that are neither expected nor owned. Leave alone, report back. */
  unknownKept: string[];
  /** Owned derived files that remain correct. Untouched. */
  retained: string[];
}

export function planBatchUpdate(input: {
  /** One entry per assignment with a chosen result, with its deterministic destination. */
  expected: BatchEntry[];
  /** Filenames currently in the round's import folder. */
  existingNames: readonly string[];
  /** Manifest's derived-file ownership, restricted to this round's Match ids. */
  ownedNames: Readonly<Record<string, string>>;
}): BatchPlan {
  const expectedNames = new Map(input.expected.map((entry) => [entry.destName, entry.matchId]));
  const ownedSet = new Set(Object.values(input.ownedNames));
  const existingSet = new Set(input.existingNames);

  const removals: string[] = [];
  const unknownKept: string[] = [];
  const retained: string[] = [];
  for (const name of existingSet) {
    if (expectedNames.has(name)) {
      if (ownedSet.has(name)) retained.push(name);
      // An expected file that was placed by hand (or predates ownership tracking) is adopted,
      // not duplicated: preparing overwrites it with the chosen bytes and records ownership.
      continue;
    }
    if (ownedSet.has(name)) removals.push(name);
    else unknownKept.push(name);
  }

  return {
    writes: input.expected,
    removals: [...new Set(removals)].sort(),
    unknownKept: [...new Set(unknownKept)].sort(),
    retained: [...new Set(retained)].sort(),
  };
}

/**
 * The ownership map after a successful prepare: every written destination recorded under its
 * Match id, stale ownership dropped. Unknown files never enter the map.
 */
export function nextDerivedOwnership(
  previous: Readonly<Record<string, string>>,
  roundMatchIds: ReadonlySet<string>,
  written: readonly BatchEntry[],
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [matchId, destName] of Object.entries(previous)) {
    if (!roundMatchIds.has(matchId)) next[matchId] = destName;
  }
  for (const entry of written) next[entry.matchId] = entry.destName;
  return next;
}
