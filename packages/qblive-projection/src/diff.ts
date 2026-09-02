/**
 * Which parts of the public state changed.
 *
 * # Why sections and not JSON Patch
 *
 * A 64-team tournament's snapshot is a few hundred kilobytes, and a live score tick changes one
 * number in it. Resending the whole thing every few seconds would be wasteful; a general patch
 * format would be precise but would put a patch engine on the App Clip's size budget and make
 * "what does this update mean" a question with a non-obvious answer.
 *
 * Whole-section replacement is the middle: a score tick sends `liveGames`, which is small; an
 * accepted result sends `results`, `standings`, `statistics` and `schedule`, which is most of what
 * changed anyway. A client applies a section by assignment, which is one line and cannot be
 * subtly wrong. If measurement ever shows a section that is both large and frequently barely
 * changed, that is the moment to reconsider — not before.
 */

import {
  qbliveSectionNames,
  type QbliveSectionName,
  type QbliveSections,
  type QbliveSnapshot,
} from '@qbsheet/qblive-protocol';

/**
 * Sections whose serialization differs between two snapshots.
 *
 * Compared by canonical JSON rather than by reference or by a structural walk, because the
 * projection is deterministic: equal content really does serialize identically, and equal
 * serialization really does mean nothing a client can observe has changed. That equivalence is what
 * lets the publication worker decide "nothing to publish" and stay quiet.
 */
export function changedSections(previous: QbliveSnapshot | null, next: QbliveSnapshot): QbliveSectionName[] {
  if (previous === null) return [...qbliveSectionNames];
  const changed: QbliveSectionName[] = [];
  for (const name of qbliveSectionNames) {
    if (JSON.stringify(previous[name]) !== JSON.stringify(next[name])) changed.push(name);
  }
  return changed;
}

export function pickSections(
  snapshot: QbliveSnapshot,
  names: readonly QbliveSectionName[],
): Partial<QbliveSections> {
  const sections: Partial<QbliveSections> = {};
  for (const name of names) {
    (sections as Record<string, unknown>)[name] = snapshot[name];
  }
  return sections;
}

/**
 * Sections that carry transient state, and sections that carry durable state.
 *
 * The distinction drives replay after an outage. A spectator who reconnects does not want the
 * score history of a game that finished forty minutes ago; they want the current state. But they do
 * want every accepted result and every announcement that happened while they were away.
 *
 * So the outbox coalesces transient sections down to the newest value and preserves durable ones.
 * See `docs/QBLIVE.md#high-frequency-state`.
 */
export const transientSections: readonly QbliveSectionName[] = ['liveGames'];

export function isTransientOnly(names: readonly QbliveSectionName[]): boolean {
  return names.length > 0 && names.every((name) => transientSections.includes(name));
}
