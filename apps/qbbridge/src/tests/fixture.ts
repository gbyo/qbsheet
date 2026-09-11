/**
 * The shared fixture: a real stock YellowFruit file, and the loaded tournament from it.
 *
 * It is the same 12-team two-stage `.yft` the formats package tests against — an observed file
 * from a real event, not a hand-written one, which is what makes it worth testing against.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadYellowFruitTournament, type BridgeTournament } from '../model/tournament';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '../../../..');

export const yftFixturePath = resolve(
  repositoryRoot,
  'packages/tournament-formats/tests/fixtures/yft-sample.yft.json',
);

export function yftFixtureText(): string {
  return readFileSync(yftFixturePath, 'utf8');
}

export function loadedFixture(): BridgeTournament {
  const report = loadYellowFruitTournament(yftFixtureText());
  if (!report.ok) throw new Error(`fixture failed to load: ${report.errors.join(' ')}`);
  return report.tournament;
}

/** A `.yft` with the timed flag flipped on and a 24-tossup regulation, for the timed cases. */
export function timedFixtureText(): string {
  const parsed = JSON.parse(yftFixtureText()) as {
    objects: { type?: string; scoring_rules?: Record<string, unknown> }[];
  };
  const tournament = parsed.objects.find((entry) => entry.type === 'Tournament') ?? parsed.objects[0];
  const rules = tournament.scoring_rules as Record<string, unknown>;
  rules.YfData = { timed: true };
  rules.maximum_regulation_tossup_count = 24;
  return JSON.stringify(parsed);
}
