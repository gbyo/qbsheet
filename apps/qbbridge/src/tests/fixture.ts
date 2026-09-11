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

/** A file whose first round has a display label but still supplies YellowFruit's numeric identity. */
export function nonnumericRoundFixtureText(): string {
  const parsed = JSON.parse(yftFixtureText()) as { objects: Record<string, unknown>[] };
  const tournament = parsed.objects.find((entry) => entry.type === 'Tournament') ?? parsed.objects[0];
  const phases = Array.isArray(tournament?.phases) ? tournament.phases : [];
  const firstPhase = phases.find(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
  const rounds = Array.isArray(firstPhase?.rounds) ? firstPhase.rounds : [];
  const firstRound = rounds.find(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
  if (!firstRound) throw new Error('fixture has no first round');
  firstRound.name = 'Finals';
  firstRound.number = 9;
  return JSON.stringify(parsed);
}

/** A copy of the real fixture with two concrete unplayed games and one invalid one in round 1. */
export function unplayedGamesFixtureText(): string {
  const parsed = JSON.parse(yftFixtureText()) as { objects: Record<string, unknown>[] };
  const tournament = parsed.objects.find((entry) => entry.type === 'Tournament') ?? parsed.objects[0];
  const phases = Array.isArray(tournament?.phases)
    ? tournament.phases.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      )
    : [];
  const rounds = Array.isArray(phases[0]?.rounds)
    ? phases[0].rounds.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      )
    : [];
  const matches = Array.isArray(rounds[0]?.matches)
    ? rounds[0].matches.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      )
    : [];

  const removeScoring = (match: Record<string, unknown>): void => {
    for (const key of ['tossups_read', 'overtime_tossups_read', 'match_questions']) delete match[key];
    if (!Array.isArray(match.match_teams)) return;
    for (const side of match.match_teams) {
      if (!side || typeof side !== 'object' || Array.isArray(side)) continue;
      const record = side as Record<string, unknown>;
      for (const key of [
        'points',
        'bonus_points',
        'forfeit_loss',
        'correct_tossups_without_bonuses',
        'bonuses_heard',
        'match_players',
      ])
        delete record[key];
    }
  };

  removeScoring(matches[0]);
  matches[0].location = 'Room 1';
  removeScoring(matches[1]);
  removeScoring(matches[2]);
  const invalidTeams = Array.isArray(matches[2].match_teams) ? matches[2].match_teams : [];
  matches[2].match_teams = invalidTeams.slice(0, 1);
  return JSON.stringify(parsed);
}
