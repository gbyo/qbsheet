import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildResourceCenterReport,
  resourceCenterRequiredKinds,
  resourceCenterRoleLabels,
  resourceCenterSuffixes,
  type ResourceCenterReportKind,
} from '../src/resourceCenterReport';
import { buildReportPresentation, type ReportScoringDefinition } from '../src/reportPresentation';
import type { GameStatsRow, StatsSnapshot } from '../src/stats';

/**
 * Parser-relevant structural compatibility (issue #764, workstream B).
 *
 * These tests compare QBSheet output against the structural conventions that matter
 * to the Resource Center uploader — one document per report, role -> filename mapping,
 * a coherent shared prefix, expected tables/headings, resolving internal links, safe
 * escaping, no scripts or remote dependencies, tournament identity, and cross-page
 * identity agreement — using genuine YellowFruit output and an honestly-labeled SQBS
 * structural reference as the comparison sets (see
 * `tests/fixtures/resource-center/README.md`). They deliberately assert structure,
 * never brittle byte-for-byte snapshots of whitespace, CSS, or document shells:
 * YellowFruit ships `<HTML>` with no doctype or charset, so those QBSheet-only
 * choices are pinned in `resourceCenterReport.test.ts`, not here.
 */

const fixtureRoot = join(__dirname, 'fixtures', 'resource-center');

interface ReportSet {
  label: string;
  files: Array<{ role: string; fileName: string; content: string }>;
}

function readSet(dir: string, label: string, roleOf: (fileName: string) => string): ReportSet {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.html'))
    .sort()
    .map((fileName) => ({
      role: roleOf(fileName),
      fileName,
      content: readFileSync(join(dir, fileName), 'utf8'),
    }));
  return { label, files };
}

function yellowfruitRole(fileName: string): string {
  switch (fileName) {
    case 'standings.html':
      return 'Standings';
    case 'individuals.html':
      return 'Individuals';
    case 'games.html':
      return 'Scoreboard';
    case 'teamdetail.html':
      return 'Team Detail';
    case 'playerdetail.html':
      return 'Player Detail';
    case 'rounds.html':
      return 'Round Report';
    default:
      throw new Error(`unknown YellowFruit fixture file ${fileName}`);
  }
}

function sqbsRole(fileName: string): string {
  const suffix = Object.entries(resourceCenterSuffixes).find(([, value]) => fileName.endsWith(value));
  if (!suffix) throw new Error(`unknown SQBS fixture file ${fileName}`);
  return resourceCenterRoleLabels[suffix[0] as ResourceCenterReportKind];
}

function definition(): ReportScoringDefinition {
  return {
    tossupValue: 10,
    superpowerValue: null,
    powerValue: 15,
    negValue: -5,
    useBonuses: true,
    tossupCount: 20,
    bouncebacks: false,
    lightning: false,
    overtime: false,
  };
}

/** The same synthetic 4-team tournament the fixtures describe, in canonical form. */
function syntheticSnapshot(): StatsSnapshot {
  const generatedAt = '2026-09-10T12:00:00.000Z';
  const presentation = buildReportPresentation({
    metadata: { tournamentName: 'Synthetic Invitational', scopeLabel: 'Overall', generatedAt },
    definitions: [definition()],
    capabilities: { packetRecorded: false, stageRecorded: false },
  });
  const teams = [
    { id: 'alder', name: 'Alder', wins: 3, losses: 0, pf: 925, pa: 565 },
    { id: 'birch', name: 'Birch', wins: 2, losses: 1, pf: 645, pa: 645 },
    { id: 'cedar', name: 'Cedar', wins: 1, losses: 2, pf: 605, pa: 795 },
    { id: 'dogwood', name: 'Dogwood', wins: 0, losses: 3, pf: 660, pa: 830 },
  ];
  const pairings: Array<[number, string, string, number, number]> = [
    [1, 'alder', 'birch', 310, 150],
    [1, 'cedar', 'dogwood', 270, 245],
    [2, 'alder', 'cedar', 310, 175],
    [2, 'birch', 'dogwood', 255, 175],
    [3, 'alder', 'dogwood', 305, 240],
    [3, 'birch', 'cedar', 240, 160],
  ];
  const byId = new Map(teams.map((team) => [team.id, team]));
  // Per-game star lines, coherent with the individuals rows above.
  const starLines: Record<string, { powers: number; gets: number; negs: number; points: number }> = {
    'game-1:ava': { powers: 1, gets: 3, negs: 0, points: 45 },
    'game-3:ava': { powers: 1, gets: 3, negs: 0, points: 45 },
    'game-5:ava': { powers: 1, gets: 3, negs: 1, points: 40 },
    'game-1:dev': { powers: 1, gets: 2, negs: 1, points: 25 },
    'game-4:dev': { powers: 1, gets: 3, negs: 0, points: 45 },
    'game-6:dev': { powers: 0, gets: 3, negs: 1, points: 25 },
  };
  const games: GameStatsRow[] = pairings.map(([round, one, two, onePoints, twoPoints], index) => ({
    gameId: `game-${index + 1}`,
    roundId: `round-${round}`,
    roundName: `Round ${round}`,
    teamOneId: one,
    teamOneName: byId.get(one)!.name,
    teamOnePoints: onePoints,
    teamTwoId: two,
    teamTwoName: byId.get(two)!.name,
    teamTwoPoints: twoPoints,
    winnerId: onePoints > twoPoints ? one : two,
    status: 'accepted',
    detail: 'complete',
    tossupsRead: 20,
    overtimeTossupsRead: 0,
    playerStats: ['ava', 'dev']
      .map((playerId) => {
        const line = starLines[`game-${index + 1}:${playerId}`];
        if (!line) return null;
        const teamId = playerId === 'ava' ? 'alder' : 'birch';
        return {
          playerId,
          playerName: playerId === 'ava' ? 'Ava Rios' : 'Dev Patel',
          teamId,
          teamName: byId.get(teamId)!.name,
          tossupsHeard: 20,
          superpowers: null,
          powers: line.powers,
          gets: line.gets,
          negs: line.negs,
          bonusPoints: null,
          points: line.points,
        };
      })
      .filter((line): line is NonNullable<typeof line> => line !== null),
  }));
  return {
    format: 'qbsheet-stats',
    version: 1,
    generatedAt,
    tournament: { id: 'tournament', name: 'Synthetic Invitational' },
    teams: teams.map((team, index) => ({
      rank: index + 1,
      teamId: team.id,
      teamName: team.name,
      gamesPlayed: 3,
      wins: team.wins,
      losses: team.losses,
      ties: 0,
      winPercentage: team.wins / 3,
      pointsFor: team.pf,
      pointsAgainst: team.pa,
      ppg: team.pf / 3,
      papg: team.pa / 3,
      margin: team.pf - team.pa,
      superpowers: 0,
      powers: 0,
      gets: 0,
      negs: 0,
      tossupsHeard: 60,
      tossupsHeardKnown: true,
      pptuh: team.pf / 60,
      bonusPoints: 0,
      bonusesHeard: 0,
      ppb: null,
    })),
    players: [
      {
        rank: 1,
        playerId: 'ava',
        playerName: 'Ava Rios',
        teamId: 'alder',
        teamName: 'Alder',
        gamesPlayed: 3,
        tossupsHeard: 60,
        superpowers: 0,
        powers: 3,
        gets: 9,
        negs: 1,
        points: 130,
        ppg: 130 / 3,
        pptuh: 130 / 60,
        bonusesHeard: 0,
        bonusPoints: 0,
        ppb: null,
      },
      {
        rank: 2,
        playerId: 'dev',
        playerName: 'Dev Patel',
        teamId: 'birch',
        teamName: 'Birch',
        gamesPlayed: 3,
        tossupsHeard: 60,
        superpowers: 0,
        powers: 2,
        gets: 8,
        negs: 2,
        points: 95,
        ppg: 95 / 3,
        pptuh: 95 / 60,
        bonusesHeard: 0,
        bonusPoints: 0,
        ppb: null,
      },
    ],
    games,
    extensions: { scopeLabel: 'Overall' },
    presentation,
  };
}

function qbsheetSet(): ReportSet {
  const artifact = buildResourceCenterReport(syntheticSnapshot(), { baseName: 'synthetic-invitational' });
  return {
    label: 'QBSheet',
    files: artifact.files.map((file) => ({
      role: resourceCenterRoleLabels[file.kind],
      fileName: file.fileName,
      content: file.content,
    })),
  };
}

const requiredRoles = new Set(resourceCenterRequiredKinds.map((kind) => resourceCenterRoleLabels[kind]));

function sets(): ReportSet[] {
  return [
    readSet(join(fixtureRoot, 'yellowfruit', 'naqt-synthetic'), 'YellowFruit 4.0.18', yellowfruitRole),
    readSet(join(fixtureRoot, 'sqbs', 'naqt-synthetic'), 'SQBS structural reference', sqbsRole),
    qbsheetSet(),
  ];
}

/** The six required upload slots; the stat-key companion stays out of role loops. */
function requiredFiles(set: ReportSet): ReportSet['files'] {
  return set.files.filter((file) => requiredRoles.has(file.role));
}

/** href/src targets handling quoted and unquoted (YellowFruit) attribute styles. */
function linkTargets(content: string): string[] {
  const targets: string[] = [];
  const pattern = /(?:href|HREF)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    const target = raw.split('#')[0] ?? '';
    if (target.toLowerCase().endsWith('.html')) targets.push(target);
  }
  return targets;
}

function tableCount(content: string): number {
  return (content.match(/<table[\s>]/gi) ?? []).length;
}

describe('resource center parser-relevant structure across generators', () => {
  test('every set covers the six upload roles with one file each', () => {
    for (const set of sets()) {
      const roles = requiredFiles(set)
        .map((file) => file.role)
        .sort();
      expect(roles, set.label).toEqual(
        [...resourceCenterRequiredKinds.map((kind) => resourceCenterRoleLabels[kind])].sort(),
      );
    }
  });

  test('every file carries data tables and its role heading', () => {
    const roleHeading: Record<string, RegExp> = {
      Standings: /team standings/i,
      Individuals: /individual statistics|individuals/i,
      Scoreboard: /scoreboard|round 1/i,
      'Team Detail': /team detail|game-by-game/i,
      'Player Detail': /player detail|game-by-game/i,
      'Round Report': /round report|round 1/i,
    };
    for (const set of sets()) {
      for (const file of requiredFiles(set)) {
        const hasTables = tableCount(file.content) >= 1;
        // Scoreboards may render anchored per-game sections instead of tables
        // (QBSheet box scores do); every other role must carry data tables.
        const hasGameSections = file.role === 'Scoreboard' && file.content.includes('id="game-');
        expect(hasTables || hasGameSections, `${set.label}/${file.fileName} has no tables`).toBe(true);
        expect(
          roleHeading[file.role]!.test(file.content),
          `${set.label}/${file.fileName} lacks its role heading`,
        ).toBe(true);
      }
    }
  });

  test('tournament identity is present in each set, and in every QBSheet file', () => {
    // Genuine YellowFruit output repeats the tournament name on the standings page
    // only; QBSheet holds itself to the stricter per-file identity its preflight
    // enforces (preflight code `missing-tournament-identity`).
    for (const set of sets()) {
      const standings = set.files.find((file) => file.role === 'Standings')!.content;
      expect(
        /synthetic invitational/i.test(standings),
        `${set.label} standings lacks tournament identity`,
      ).toBe(true);
      if (set.label === 'QBSheet') {
        for (const file of set.files) {
          expect(
            /synthetic invitational/i.test(file.content),
            `${set.label}/${file.fileName} lacks tournament identity`,
          ).toBe(true);
        }
      }
    }
  });

  test('internal report links resolve to files in the same set', () => {
    for (const set of sets()) {
      const names = new Set(set.files.map((file) => file.fileName.toLowerCase()));
      for (const file of set.files) {
        const links = linkTargets(file.content);
        expect(links.length, `${set.label}/${file.fileName} links to no sibling reports`).toBeGreaterThan(0);
        for (const target of links) {
          expect(
            names.has(target.toLowerCase()),
            `${set.label}/${file.fileName} links to missing ${target}`,
          ).toBe(true);
        }
      }
    }
  });

  test('no set requires scripts to render its stats', () => {
    for (const set of sets()) {
      for (const file of set.files) {
        expect(/<script[\s>]/i.test(file.content), `${set.label}/${file.fileName} requires a script`).toBe(
          false,
        );
      }
    }
  });

  test('team identities and game counts agree across pages within each set', () => {
    for (const set of sets()) {
      const standings = set.files.find((file) => file.role === 'Standings')!.content;
      const scoreboard = set.files.find((file) => file.role === 'Scoreboard')!.content;
      const teamDetail = set.files.find((file) => file.role === 'Team Detail')!.content;
      for (const team of ['Alder', 'Birch', 'Cedar', 'Dogwood']) {
        expect(standings, `${set.label} standings lacks ${team}`).toContain(team);
        expect(scoreboard, `${set.label} scoreboard lacks ${team}`).toContain(team);
        expect(teamDetail, `${set.label} team detail lacks ${team}`).toContain(team);
      }
      // Six games: each set's scoreboard and team detail carry every pairing.
      for (const pairing of ['Alder', 'Birch', 'Cedar', 'Dogwood']) {
        expect(
          scoreboard.match(new RegExp(pairing, 'g'))!.length >= 3,
          `${set.label} scoreboard undercounts ${pairing}`,
        ).toBe(true);
      }
    }
  });

  test('standings records agree across generators for the shared tournament', () => {
    const records: Record<string, string[]> = {};
    for (const set of sets()) {
      const standings = set.files.find((file) => file.role === 'Standings')!.content;
      const text = standings.replace(/<[^>]+>/g, ' ');
      records[set.label] = ['Alder', 'Birch', 'Cedar', 'Dogwood'].map((team) => {
        const at = text.indexOf(team);
        const slice = text.slice(at, at + 120);
        const record = slice.match(
          /([0-9])\s+([0-9])\s+(?:[0-9]\s+)?[01]\.000|([0-9]-[0-9])|([0-9])[^0-9]{1,8}([0-9])/,
        );
        return record ? record[0].replace(/\s+/g, ' ') : 'not-found';
      });
    }
    // Alder 3-0 through Dogwood 0-3 in every set (whitespace-tolerant).
    for (const [label, rows] of Object.entries(records)) {
      expect(rows[0], `${label} Alder record`).toMatch(/3\D*0/);
      expect(rows[3], `${label} Dogwood record`).toMatch(/0\D*3/);
    }
  });
});

describe('resource center filename conventions across generators', () => {
  test('YellowFruit uses bare role names; the same suffixes QBSheet and SQBS share', () => {
    const set = readSet(join(fixtureRoot, 'yellowfruit', 'naqt-synthetic'), 'YellowFruit', yellowfruitRole);
    expect(set.files.map((file) => file.fileName).sort()).toEqual([
      'games.html',
      'individuals.html',
      'playerdetail.html',
      'rounds.html',
      'standings.html',
      'teamdetail.html',
    ]);
    // Scoreboard is the *_games.html / games.html role in every convention.
    expect(set.files.find((file) => file.role === 'Scoreboard')!.fileName).toBe('games.html');
  });

  test('QBSheet role suffixes match the SQBS-advertised convention', () => {
    expect(resourceCenterSuffixes.scoreboard).toBe('_games.html');
    const artifact = buildResourceCenterReport(syntheticSnapshot(), { baseName: 'synthetic-invitational' });
    for (const file of artifact.files) {
      expect(file.fileName.startsWith('synthetic-invitational_')).toBe(true);
    }
  });
});
