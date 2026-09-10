import { describe, expect, test } from 'vitest';
import {
  buildResourceCenterReport,
  resourceCenterAllKinds,
  resourceCenterFileNames,
  resourceCenterReference,
  resourceCenterRequiredKinds,
  resourceCenterRoleLabels,
  resourceCenterSuffixes,
  sanitizeResourceCenterBaseName,
  type ResourceCenterReportKind,
} from '../src/resourceCenterReport';
import {
  buildReportPresentation,
  type ReportPresentationCapabilities,
  type ReportScoringDefinition,
} from '../src/reportPresentation';
import type { ReportOptions } from '../src/reportPresentation';
import type { GamePlayerStatsRow, GameTeamStatsRow } from '../src/reportDetail';
import type { GameStatsRow, StatsSnapshot } from '../src/stats';

const generatedAt = '2026-09-09T21:00:00.000Z';
const tournamentName = 'Cavalier Classic <&> "Quiz"';

function definition(overrides: Partial<ReportScoringDefinition> = {}): ReportScoringDefinition {
  return {
    tossupValue: 10,
    superpowerValue: 30,
    powerValue: 20,
    negValue: -5,
    useBonuses: true,
    tossupCount: 20,
    bouncebacks: false,
    lightning: false,
    overtime: false,
    ...overrides,
  };
}

const standardCapabilities: ReportPresentationCapabilities = {
  bouncebacksRecorded: false,
  lightningRecorded: false,
  packetRecorded: true,
  stageRecorded: false,
};

function snapshotFor(input: {
  tournament?: string;
  definitions?: ReportScoringDefinition[];
  capabilities?: ReportPresentationCapabilities;
  options?: ReportOptions;
  teams?: StatsSnapshot['teams'];
  players?: StatsSnapshot['players'];
  games?: GameStatsRow[];
}): StatsSnapshot {
  const name = input.tournament ?? tournamentName;
  const presentation = buildReportPresentation({
    metadata: { tournamentName: name, scopeLabel: 'Overall', generatedAt },
    definitions: input.definitions ?? [definition()],
    ...(input.options ? { options: input.options } : {}),
    capabilities: input.capabilities ?? standardCapabilities,
  });
  return {
    format: 'qbsheet-stats',
    version: 1,
    generatedAt,
    tournament: { id: 'tournament', name },
    teams: input.teams ?? [],
    players: input.players ?? [],
    games: input.games ?? [],
    extensions: { scopeLabel: 'Overall' },
    presentation,
  };
}

function detailedTeam(
  overrides: Partial<GameTeamStatsRow> & Pick<GameTeamStatsRow, 'teamId' | 'teamName' | 'points'>,
): GameTeamStatsRow {
  return {
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    tossupsHeard: 20,
    bonusesHeard: 0,
    bonusPoints: 0,
    ppb: null,
    bouncebacks: 0,
    ...overrides,
  };
}

function detailedPlayer(
  overrides: Partial<GamePlayerStatsRow> &
    Pick<GamePlayerStatsRow, 'playerId' | 'playerName' | 'teamId' | 'teamName'>,
): GamePlayerStatsRow {
  return {
    tossupsHeard: 20,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    bonusPoints: 0,
    points: 0,
    ...overrides,
  };
}

function standardTeams(): StatsSnapshot['teams'] {
  return [
    {
      rank: 1,
      teamId: 'team-a',
      teamName: 'Aiken <A>',
      gamesPlayed: 3,
      wins: 2,
      losses: 0,
      ties: 1,
      winPercentage: 2 / 3,
      pointsFor: 650,
      pointsAgainst: 410,
      ppg: 650 / 3,
      papg: 410 / 3,
      margin: 240,
      superpowers: 1,
      powers: 3,
      gets: 12,
      negs: 1,
      tossupsHeard: 60,
      tossupsHeardKnown: true,
      pptuh: 650 / 60,
      bonusPoints: 220,
      bonusesHeard: 12,
      ppb: 220 / 12,
    },
    {
      rank: 2,
      teamId: 'team-b',
      teamName: 'Wren & Friends',
      gamesPlayed: 3,
      wins: 0,
      losses: 2,
      ties: 1,
      winPercentage: 0,
      pointsFor: 410,
      pointsAgainst: 650,
      ppg: 410 / 3,
      papg: 650 / 3,
      margin: -240,
      superpowers: 0,
      powers: 1,
      gets: 8,
      negs: 3,
      tossupsHeard: 60,
      tossupsHeardKnown: true,
      pptuh: 410 / 60,
      bonusPoints: 120,
      bonusesHeard: 8,
      ppb: 15,
    },
  ];
}

function standardPlayers(): StatsSnapshot['players'] {
  return [
    {
      rank: 1,
      playerId: 'player-a',
      playerName: 'Alice & Co.',
      teamId: 'team-a',
      teamName: 'Aiken <A>',
      gamesPlayed: 2,
      tossupsHeard: 40,
      superpowers: 1,
      powers: 2,
      gets: 6,
      negs: 0,
      points: 110,
      ppg: 55,
      pptuh: 2.75,
      bonusesHeard: 0,
      bonusPoints: 40,
      ppb: null,
    },
    {
      rank: 2,
      playerId: 'player-b',
      playerName: 'Bob "Buzz" Béla',
      teamId: 'team-b',
      teamName: 'Wren & Friends',
      gamesPlayed: 2,
      tossupsHeard: null,
      superpowers: 0,
      powers: 1,
      gets: 4,
      negs: 1,
      points: 55,
      ppg: 27.5,
      pptuh: null,
      bonusesHeard: 0,
      bonusPoints: 0,
      ppb: null,
    },
  ];
}

function standardGames(): GameStatsRow[] {
  return [
    {
      gameId: 'game-one',
      roundId: 'round-1',
      roundName: 'Round 1',
      packetName: 'Packet <A>',
      teamOneId: 'team-a',
      teamOneName: 'Aiken <A>',
      teamOnePoints: 400,
      teamTwoId: 'team-b',
      teamTwoName: 'Wren & Friends',
      teamTwoPoints: 160,
      winnerId: 'team-a',
      status: 'accepted',
      detail: 'complete',
      tossupsRead: 20,
      overtimeTossupsRead: 0,
      teamStats: [
        detailedTeam({
          teamId: 'team-a',
          teamName: 'Aiken <A>',
          points: 400,
          superpowers: 1,
          powers: 2,
          gets: 6,
          bonusesHeard: 8,
          bonusPoints: 160,
          ppb: 20,
        }),
        detailedTeam({
          teamId: 'team-b',
          teamName: 'Wren & Friends',
          points: 160,
          powers: 1,
          gets: 3,
          negs: 1,
          bonusesHeard: 4,
          bonusPoints: 60,
          ppb: 15,
        }),
      ],
      playerStats: [
        detailedPlayer({
          playerId: 'player-a',
          playerName: 'Alice & Co.',
          teamId: 'team-a',
          teamName: 'Aiken <A>',
          superpowers: 1,
          powers: 2,
          gets: 6,
          points: 95,
        }),
        detailedPlayer({
          playerId: 'player-b',
          playerName: 'Bob "Buzz" Béla',
          teamId: 'team-b',
          teamName: 'Wren & Friends',
          powers: 1,
          gets: 3,
          negs: 1,
          tossupsHeard: null,
          points: 40,
        }),
      ],
    },
    {
      gameId: 'game-forfeit',
      roundId: 'round-2',
      roundName: 'Round 2',
      teamOneId: 'team-a',
      teamOneName: 'Aiken <A>',
      teamOnePoints: 0,
      teamTwoId: 'team-b',
      teamTwoName: 'Wren & Friends',
      teamTwoPoints: 0,
      forfeitedTeamId: 'team-b',
      status: 'accepted',
      detail: 'complete',
      tossupsRead: null,
      overtimeTossupsRead: null,
    },
    {
      gameId: 'game-tie',
      roundId: 'round-3',
      roundName: 'Round 3',
      teamOneId: 'team-a',
      teamOneName: 'Aiken <A>',
      teamOnePoints: 250,
      teamTwoId: 'team-b',
      teamTwoName: 'Wren & Friends',
      teamTwoPoints: 250,
      status: 'accepted',
      detail: 'partial',
      tossupsRead: null,
      overtimeTossupsRead: null,
    },
  ];
}

function standardSnapshot(): StatsSnapshot {
  return snapshotFor({
    teams: standardTeams(),
    players: standardPlayers(),
    games: standardGames(),
  });
}

function fileOf(artifact: ReturnType<typeof buildResourceCenterReport>, kind: ResourceCenterReportKind) {
  const file = artifact.files.find((entry) => entry.kind === kind);
  if (!file) throw new Error(`missing ${kind} file`);
  return file;
}

describe('resource center report artifact', () => {
  test('emits the six required roles plus the optional stat-key companion', () => {
    const artifact = buildResourceCenterReport(standardSnapshot());
    expect(artifact.files.map((file) => file.kind)).toEqual([...resourceCenterAllKinds]);
    expect(artifact.scopeLabel).toBe('Overall');
    expect(artifact.warnings).toEqual([]);
    expect(artifact.errors).toEqual([]);
    for (const file of artifact.files) {
      expect(file.requiredForResourceCenter).toBe(file.kind !== 'statKey');
    }
    expect(resourceCenterRequiredKinds).toHaveLength(6);
    expect(resourceCenterRequiredKinds).not.toContain('statKey');
  });

  test('uses conventional SQBS/YellowFruit-compatible suffixes under one stable base', () => {
    const artifact = buildResourceCenterReport(standardSnapshot());
    expect(resourceCenterSuffixes).toEqual({
      standings: '_standings.html',
      individuals: '_individuals.html',
      scoreboard: '_games.html',
      teamDetail: '_teamdetail.html',
      playerDetail: '_playerdetail.html',
      rounds: '_rounds.html',
      statKey: '_statkey.html',
    });
    const expected = resourceCenterFileNames(artifact.baseName);
    for (const file of artifact.files) {
      expect(file.fileName).toBe(expected[file.kind]);
      expect(file.fileName.startsWith(`${artifact.baseName}_`)).toBe(true);
    }
    // The Scoreboard upload slot is the *_games.html file.
    expect(fileOf(artifact, 'scoreboard').fileName.endsWith('_games.html')).toBe(true);
  });

  test('derives the base name from the tournament name unless overridden', () => {
    const fromTournament = buildResourceCenterReport(standardSnapshot());
    expect(fromTournament.baseName).toBe(sanitizeResourceCenterBaseName(tournamentName));
    const overridden = buildResourceCenterReport(standardSnapshot(), { baseName: 'Regional Final' });
    expect(overridden.baseName).toBe('Regional-Final');
    for (const file of overridden.files) {
      expect(file.fileName.startsWith('Regional-Final_')).toBe(true);
    }
  });

  test('sanitizes base names predictably, including Unicode and hostile input', () => {
    expect(sanitizeResourceCenterBaseName('Cavalier Classic')).toBe('Cavalier-Classic');
    expect(sanitizeResourceCenterBaseName('  Spring Invitational 2026! ')).toBe('Spring-Invitational-2026');
    expect(sanitizeResourceCenterBaseName('')).toBe('report');
    expect(sanitizeResourceCenterBaseName('   ')).toBe('report');
    expect(sanitizeResourceCenterBaseName('///')).toBe('report');
    // Unicode letters survive; reserved filesystem characters collapse to one hyphen.
    expect(sanitizeResourceCenterBaseName('Café — «Quiz» & <Friends>')).toBe('Café-Quiz-Friends');
    expect(sanitizeResourceCenterBaseName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(sanitizeResourceCenterBaseName('a\tb\nc\rd')).toBe('a-b-c-d');
    // Composed and decomposed spellings map identically; results are idempotent and bounded.
    const composed = sanitizeResourceCenterBaseName('Café Classic');
    expect(sanitizeResourceCenterBaseName('Cafe\u0301 Classic')).toBe(composed);
    expect(sanitizeResourceCenterBaseName(composed)).toBe(composed);
    expect(sanitizeResourceCenterBaseName('x'.repeat(200))).toHaveLength(80);
    expect(sanitizeResourceCenterBaseName('UPPER_case.Name')).toBe('UPPER_case.Name');
  });

  test('never presents index.html as an upload slot', () => {
    const artifact = buildResourceCenterReport(standardSnapshot());
    expect(artifact.files.map((file) => file.fileName)).not.toContain('index.html');
    for (const file of artifact.files) {
      expect(file.content).not.toContain('"index.html');
      expect(file.content).not.toContain("'index.html");
    }
  });

  test('omits the stat-key companion on request without touching required roles', () => {
    const artifact = buildResourceCenterReport(standardSnapshot(), { includeStatKey: false });
    expect(artifact.files.map((file) => file.kind)).toEqual([...resourceCenterRequiredKinds]);
    expect(artifact.files).toHaveLength(6);
    for (const file of artifact.files) {
      expect(file.requiredForResourceCenter).toBe(true);
      expect(file.content).not.toContain('_statkey.html');
    }
  });
});

describe('resource center document structure', () => {
  const markers: Array<{ kind: ResourceCenterReportKind; marker: string }> = [
    { kind: 'standings', marker: 'Team standings' },
    { kind: 'individuals', marker: 'Individual statistics' },
    { kind: 'scoreboard', marker: 'Alice &amp; Co.' },
    { kind: 'teamDetail', marker: 'Game-by-game' },
    { kind: 'playerDetail', marker: 'Game-by-game' },
    { kind: 'rounds', marker: 'Round 1' },
    { kind: 'statKey', marker: 'Stat key' },
  ];

  test('every file carries the accepted document shell and its role content', () => {
    const artifact = buildResourceCenterReport(standardSnapshot());
    for (const { kind, marker } of markers) {
      const file = fileOf(artifact, kind);
      expect(file.content.startsWith('<!doctype html>')).toBe(true);
      expect(file.content).toContain('<html lang="en">');
      expect(file.content).toContain('<meta charset="utf-8">');
      expect(file.content).toContain('Cavalier Classic &lt;&amp;&gt; &quot;Quiz&quot;</title>');
      expect(file.content).toContain('<h1>Cavalier Classic &lt;&amp;&gt; &quot;Quiz&quot;</h1>');
      expect(file.content).toContain(marker);
      expect(file.content).toContain(`aria-label="Resource Center reports"`);
    }
  });

  test('navigation uses resource center vocabulary and upload filenames', () => {
    const artifact = buildResourceCenterReport(standardSnapshot());
    const names = resourceCenterFileNames(artifact.baseName);
    const standings = fileOf(artifact, 'standings').content;
    for (const kind of resourceCenterAllKinds) {
      expect(standings).toContain(`href="${names[kind]}">${resourceCenterRoleLabels[kind]}</a>`);
    }
    expect(standings).toContain('>Scoreboard</a>');
    expect(standings).toContain('>Team Detail</a>');
    expect(standings).toContain('>Round Report</a>');
    expect(standings).not.toContain('>Games</a>');
  });

  test('escapes special characters and Unicode safely in every file', () => {
    const artifact = buildResourceCenterReport(standardSnapshot());
    // The stat key documents abbreviations (no team/player names) and the round report
    // carries team lines only (no player names), so player-name coverage is per-file below.
    const withTeams = artifact.files.filter((file) => file.kind !== 'statKey');
    for (const file of withTeams) {
      expect(file.content).toContain('Aiken &lt;A&gt;');
      expect(file.content).toContain('Wren &amp; Friends');
      expect(file.content).not.toContain('Aiken <A>');
      expect(file.content).not.toContain('Wren & Friends');
    }
    for (const kind of ['individuals', 'scoreboard', 'teamDetail', 'playerDetail'] as const) {
      const content = fileOf(artifact, kind).content;
      expect(content).toContain('Alice &amp; Co.');
      expect(content).not.toContain('Alice & Co.');
    }
    const individuals = fileOf(artifact, 'individuals').content;
    expect(individuals).toContain('Bob &quot;Buzz&quot; Béla');
    expect(individuals).not.toContain('Bob "Buzz" Béla');
  });

  test('every internal report link resolves to a file and anchor in the set', () => {
    const artifact = buildResourceCenterReport(standardSnapshot());
    const byName = new Map(artifact.files.map((file) => [file.fileName, file.content]));
    for (const file of artifact.files) {
      const links = [...file.content.matchAll(/href="([^"#]+\.html)(#[^"]*)?"/g)];
      expect(links.length).toBeGreaterThan(0);
      for (const [, target, anchor] of links) {
        expect(byName.has(target), `${file.fileName} links to missing ${target}`).toBe(true);
        if (anchor) {
          const id = anchor.slice(1);
          expect(
            byName.get(target)!.includes(`id="${id}"`),
            `${file.fileName} links to missing anchor ${anchor} in ${target}`,
          ).toBe(true);
        }
      }
    }
  });

  test('no file links back to printable-report filenames', () => {
    const artifact = buildResourceCenterReport(standardSnapshot());
    const legacy = [
      '"standings.html',
      '"individuals.html',
      '"games.html',
      '"rounds.html',
      '"teamdetail.html',
      '"playerdetail.html',
    ];
    for (const file of artifact.files) {
      for (const stale of legacy) {
        expect(file.content).not.toContain(stale);
      }
    }
  });
});

describe('resource center canonical semantics', () => {
  test('names forfeits without fabricating a winner and marks real ties', () => {
    const artifact = buildResourceCenterReport(standardSnapshot());
    const scoreboard = fileOf(artifact, 'scoreboard').content;
    expect(scoreboard).toContain('Forfeit: Wren &amp; Friends forfeited');
    expect(scoreboard).toContain('Result: Tie');
    const teamDetail = fileOf(artifact, 'teamDetail').content;
    expect(teamDetail).toContain('L (forfeit)');
    expect(teamDetail).toContain('W (forfeit)');
  });

  test('renders canonical totals exactly, including ties in the record', () => {
    const artifact = buildResourceCenterReport(standardSnapshot());
    const standings = fileOf(artifact, 'standings').content;
    expect(standings).toContain('2–0–1');
    expect(standings).toContain('650');
    const teamDetail = fileOf(artifact, 'teamDetail').content;
    expect(teamDetail).toContain('650');
  });

  test('keeps unknown statistics honest instead of printing zeroes', () => {
    const snap = standardSnapshot();
    snap.teams[0]!.tossupsHeardKnown = false;
    snap.teams[0]!.pptuh = null;
    snap.teams[0]!.ppb = null;
    const artifact = buildResourceCenterReport(snap);
    const standings = fileOf(artifact, 'standings').content;
    expect(standings).toContain('<td class="num">—</td>');
    const individuals = fileOf(artifact, 'individuals').content;
    // Bob's tossups-heard is unknown: his TUH cell is an em dash, not zero.
    expect(individuals).toContain('Bob &quot;Buzz&quot; Béla');
    expect(individuals).toContain('<td class="num">—</td>');
  });

  test('flags partial detail and overtime distinctly', () => {
    const snap = standardSnapshot();
    const artifact = buildResourceCenterReport(snap);
    expect(fileOf(artifact, 'scoreboard').content).toContain('Partial detailed statistics');

    const overtime = snapshotFor({
      definitions: [definition({ overtime: true })],
      capabilities: { ...standardCapabilities, packetRecorded: false },
      teams: standardTeams(),
      players: [],
      games: [
        {
          gameId: 'game-ot',
          roundId: 'round-1',
          roundName: 'Round 1',
          teamOneId: 'team-a',
          teamOneName: 'Aiken <A>',
          teamOnePoints: 300,
          teamTwoId: 'team-b',
          teamTwoName: 'Wren & Friends',
          teamTwoPoints: 290,
          winnerId: 'team-a',
          status: 'accepted',
          tossupsRead: 20,
          overtimeTossupsRead: 3,
        },
      ],
    });
    expect(fileOf(buildResourceCenterReport(overtime), 'scoreboard').content).toContain(
      'Overtime tossups: 3',
    );
  });

  test('carries divisions and stage context without inventing columns', () => {
    const teams = standardTeams().map((row) =>
      row.teamId === 'team-a' ? { ...row, classifications: ['Small School'] } : row,
    );
    const games = standardGames().map((game) => ({ ...game, phaseId: 'phase-1' }));
    const snap = snapshotFor({
      teams,
      players: standardPlayers(),
      games,
      capabilities: { ...standardCapabilities, stageRecorded: true },
    });
    const artifact = buildResourceCenterReport(snap);
    expect(fileOf(artifact, 'standings').content).toContain('Small School');
    expect(fileOf(artifact, 'scoreboard').content).toContain('Stage: phase-1');
    expect(fileOf(artifact, 'rounds').content).toContain('phase-1');
  });

  test('renders zero-value teams and empty tournaments without hiding unknowns', () => {
    const idle: StatsSnapshot['teams'] = [
      {
        rank: 3,
        teamId: 'team-c',
        teamName: 'Idle',
        gamesPlayed: 0,
        wins: 0,
        losses: 0,
        ties: 0,
        winPercentage: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        ppg: 0,
        papg: 0,
        margin: 0,
        superpowers: 0,
        powers: 0,
        gets: 0,
        negs: 0,
        tossupsHeard: 0,
        tossupsHeardKnown: true,
        pptuh: null,
        bonusPoints: 0,
        bonusesHeard: 0,
        ppb: null,
      },
    ];
    const withIdle = snapshotFor({
      teams: [...standardTeams(), ...idle],
      players: standardPlayers(),
      games: standardGames(),
    });
    const standings = fileOf(buildResourceCenterReport(withIdle), 'standings').content;
    expect(standings).toContain('Idle');
    expect(standings).toContain('<td class="num">—</td>');

    const empty = buildResourceCenterReport(snapshotFor({}));
    expect(empty.files).toHaveLength(7);
    expect(fileOf(empty, 'scoreboard').content).toContain('No accepted games');
    expect(fileOf(empty, 'standings').content).toContain('Team standings');
    expect(fileOf(empty, 'statKey').content).toContain('Stat key');
  });

  test('custom point values flow into headers and the stat key', () => {
    const snap = snapshotFor({
      definitions: [definition({ superpowerValue: 30, powerValue: 25, tossupValue: 10, negValue: -5 })],
      teams: standardTeams(),
      players: [],
      games: [],
    });
    const artifact = buildResourceCenterReport(snap);
    expect(fileOf(artifact, 'standings').content).toContain('Power (25)');
    expect(fileOf(artifact, 'statKey').content).toContain('25 per power');
  });
});

describe('resource center stat key', () => {
  test('documents the full column set for a standard powers/bonus event', () => {
    const statKey = fileOf(buildResourceCenterReport(standardSnapshot()), 'statKey').content;
    expect(statKey).toContain('Super (30)');
    expect(statKey).toContain('Power (20)');
    expect(statKey).toContain('30 per superpower');
    expect(statKey).toContain('>BH</td>');
    expect(statKey).toContain('>PPB</td>');
    expect(statKey).toContain('>TUH</td>');
    expect(statKey).toContain('>PPG</td>');
    expect(statKey).toContain('Ties (the record column shows');
    expect(statKey).toContain('never a silent zero');
  });

  test('a tossup-only format omits powers, bonuses, and negs instead of printing zeroes', () => {
    const snap = snapshotFor({
      definitions: [
        definition({
          superpowerValue: null,
          powerValue: null,
          tossupValue: 10,
          negValue: null,
          useBonuses: false,
        }),
      ],
      teams: standardTeams().map((row) => ({ ...row, ties: 0 })),
      players: [],
      games: [],
    });
    const artifact = buildResourceCenterReport(snap);
    const statKey = fileOf(artifact, 'statKey').content;
    expect(statKey).toContain('>Get (10)</td>');
    expect(statKey).toContain('10 per get');
    expect(statKey).not.toContain('Power');
    expect(statKey).not.toContain('Super');
    expect(statKey).not.toContain('Neg');
    expect(statKey).not.toContain('>BH</td>');
    expect(statKey).not.toContain('>PPB</td>');
    expect(statKey).not.toContain('Bonus');
    expect(statKey).not.toContain('>T</td>');
    const standings = fileOf(artifact, 'standings').content;
    expect(standings).not.toContain('>PPB</th>');
    expect(standings).not.toContain('>Power</th>');
  });

  test('no-powers formats keep negs and bonuses but drop the power tier', () => {
    const snap = snapshotFor({
      definitions: [definition({ superpowerValue: null, powerValue: null })],
      teams: standardTeams(),
      players: [],
      games: [],
    });
    const statKey = fileOf(buildResourceCenterReport(snap), 'statKey').content;
    expect(statKey).not.toContain('Power answers');
    expect(statKey).toContain('Neg answers');
    expect(statKey).toContain('>PPB</td>');
  });

  test('bouncebacks and overtime appear only when the tournament records them', () => {
    const withBouncebacks = snapshotFor({
      definitions: [definition({ bouncebacks: true })],
      capabilities: { ...standardCapabilities, bouncebacksRecorded: true },
      teams: standardTeams(),
      players: [],
      games: [],
    });
    const bounceKey = fileOf(buildResourceCenterReport(withBouncebacks), 'statKey').content;
    expect(bounceKey).toContain('Bouncebacks');
    expect(bounceKey).not.toContain('Lightning');

    const standardKey = fileOf(buildResourceCenterReport(standardSnapshot()), 'statKey').content;
    expect(standardKey).not.toContain('Bouncebacks');
    expect(standardKey).not.toContain('Lightning');
    expect(standardKey).not.toContain('Overtime');
  });

  test('mixed scoring definitions are disclosed, not merged', () => {
    const snap = snapshotFor({
      definitions: [
        definition({ powerValue: 15, tossupCount: 20 }),
        definition({ powerValue: 20, tossupCount: 24 }),
      ],
      teams: standardTeams(),
      players: [],
      games: [],
    });
    const statKey = fileOf(buildResourceCenterReport(snap), 'statKey').content;
    expect(statKey).toContain('mixed values 20, 15');
    expect(statKey).toContain('vary within this report');
  });
});

describe('resource center reference contract', () => {
  test('pins the accepted YellowFruit six-view shape and the SQBS suffix convention', () => {
    expect(resourceCenterReference.url).toBe('https://hsquizbowl.org/db/tournaments/10615/stats/all_games/');
    expect(resourceCenterReference.generator).toBe('YellowFruit');
    expect([...resourceCenterReference.views]).toEqual([
      'Standings',
      'Individuals',
      'Scoreboard',
      'Team Detail',
      'Player Detail',
      'Round Report',
    ]);
    // Semantic roles line up with the public views one-to-one.
    expect(resourceCenterRequiredKinds.map((kind) => resourceCenterRoleLabels[kind])).toEqual([
      ...resourceCenterReference.views,
    ]);
  });
});
