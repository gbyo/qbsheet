import { describe, expect, test } from 'vitest';
import {
  applyPortablePlan,
  diffPortablePlan,
  exportPortablePlan,
  exportPrelimCsv,
  importPrelimCsv,
  parsePortablePlan,
  type CsvImportKnown,
  type PlanImportKnown,
  type PortableRoundPlan,
} from './planExchange';

const known: PlanImportKnown = {
  yftFingerprint: 'fp-current',
  roundIds: new Set(['round-1', 'round-2']),
  roomIds: new Set(['room-1', 'room-2']),
  teamIds: new Set(['a', 'b', 'c', 'd', 'e']),
};

function samplePlan(): PortableRoundPlan {
  return exportPortablePlan({
    tournamentName: 'Saturday Invitational',
    yftFingerprint: 'fp-current',
    exportedAt: '2026-09-11T18:00:00Z',
    rooms: [
      { id: 'room-1', name: 'Room 101' },
      { id: 'room-2', name: 'Room 102' },
    ],
    plans: [
      {
        roundId: 'round-1',
        pairings: [
          { roomId: 'room-1', leftTeamId: 'a', rightTeamId: 'b' },
          { roomId: 'room-2', leftTeamId: 'c', rightTeamId: 'd' },
        ],
      },
    ],
    dispositions: [{ roundId: 'round-1', byes: ['e'], inactive: [] }],
  });
}

describe('portable plan format', () => {
  test('export carries intent and fingerprint but no credentials or publication state', () => {
    const text = JSON.stringify(samplePlan());
    expect(text).not.toMatch(/token|secret|password|credential|pairingCode/i);
    expect(text).not.toMatch(/published|revision|epoch/i);
    const parsed = parsePortablePlan(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.yftFingerprint).toBe('fp-current');
    expect(parsed.plan.rounds).toHaveLength(1);
  });

  test('wrong format and versions are refused', () => {
    expect(parsePortablePlan('not json').ok).toBe(false);
    expect(parsePortablePlan(JSON.stringify({ format: 'something-else' })).ok).toBe(false);
    expect(parsePortablePlan(JSON.stringify({ format: 'qbbridge-round-plan', formatVersion: 99 })).ok).toBe(
      false,
    );
  });

  test('a matching plan diffs clean and applies whole rounds', () => {
    const plan = samplePlan();
    const diff = diffPortablePlan(plan, known);
    expect(diff.clean).toBe(true);
    expect(diff.fingerprintMatch).toBe(true);
    expect(diff.pairingCount).toBe(2);
    expect(diff.byeCount).toBe(1);
    const applied = applyPortablePlan(plan, known);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.plans).toHaveLength(1);
    expect(applied.dispositions).toEqual([{ roundId: 'round-1', byes: ['e'], inactive: [] }]);
  });

  test('unknown ids are listed and block application', () => {
    const plan = samplePlan();
    plan.rounds[0]!.pairings.push({ roomId: 'room-9', leftTeamId: 'a', rightTeamId: 'ghost' });
    const diff = diffPortablePlan(plan, known);
    expect(diff.clean).toBe(false);
    expect(diff.unknownRoomIds).toEqual([{ id: 'room-9', name: 'room-9' }]);
    expect(diff.unknownTeamIds).toEqual(['ghost']);
    const applied = applyPortablePlan(plan, known);
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error).toMatch(/room-9/);
  });

  test('an explicit id map resolves renamed teams without name guessing', () => {
    const plan = samplePlan();
    plan.rounds[0]!.pairings[0] = { roomId: 'room-1', leftTeamId: 'old-a', rightTeamId: 'b' };
    expect(applyPortablePlan(plan, known).ok).toBe(false);
    const applied = applyPortablePlan(plan, known, { teams: { 'old-a': 'a' } });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.plans[0]!.pairings[0]).toMatchObject({ leftTeamId: 'a', rightTeamId: 'b' });
  });

  test('a different fingerprint warns but still validates ids', () => {
    const plan = samplePlan();
    plan.yftFingerprint = 'fp-reseeded';
    const diff = diffPortablePlan(plan, known);
    expect(diff.fingerprintMatch).toBe(false);
    expect(diff.clean).toBe(true);
    // Ids still resolve: applying is the operator's explicit call after seeing the diff.
    expect(applyPortablePlan(plan, known).ok).toBe(true);
  });
});

function csvKnown(): CsvImportKnown {
  const names = new Map([
    ['Round 1', ['round-1']],
    ['Round 2', ['round-2']],
    ['Room 101', ['room-1']],
    ['Room 102', ['room-2']],
    ['Team A', ['a']],
    ['Team B', ['b']],
    ['Team C', ['c']],
    ['Team D', ['d']],
    ['Team E', ['e']],
  ]);
  const lookup = (name: string): string[] => names.get(name) ?? [];
  return {
    ...known,
    roundNameToId: lookup,
    roomNameToId: lookup,
    teamNameToId: lookup,
  };
}

describe('prelim CSV', () => {
  test('export and import round-trip games and byes', () => {
    const csv = exportPrelimCsv({
      rounds: [
        { id: 'round-1', displayName: 'Round 1' },
        { id: 'round-2', displayName: 'Round 2' },
      ],
      plans: [
        {
          roundId: 'round-1',
          pairings: [{ roomId: 'room-1', leftTeamId: 'a', rightTeamId: 'b' }],
        },
      ],
      dispositions: [{ roundId: 'round-1', byes: ['e'], inactive: [] }],
      roomName: (roomId) => (roomId === 'room-1' ? 'Room 101' : roomId),
      teamName: (teamId) => ({ a: 'Team A', b: 'Team B', e: 'Team E' })[teamId] ?? teamId,
    });
    expect(csv).toContain('Round 1,Room 101,Team A,Team B');
    expect(csv).toContain('Round 1,,Team E,BYE');
    const imported = importPrelimCsv(csv, csvKnown());
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.plans).toEqual([
      {
        roundId: 'round-1',
        pairings: [{ roomId: 'room-1', leftTeamId: 'a', rightTeamId: 'b' }],
      },
    ]);
    expect(imported.dispositions).toEqual([{ roundId: 'round-1', byes: ['e'], inactive: [] }]);
  });

  test('unknown and ambiguous names are errors naming the row', () => {
    const ambiguous: CsvImportKnown = {
      ...csvKnown(),
      teamNameToId: (name) => (name === 'Team A' ? ['a', 'a2'] : csvKnown().teamNameToId(name)),
    };
    expect(
      importPrelimCsv('round,room,left_team,right_team\nRound 1,Room 101,Team A,Team B\n', ambiguous),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/Row 2.*Team A/) });
    expect(
      importPrelimCsv('round,room,left_team,right_team\nRound 1,Room 101,Ghost,Team B\n', csvKnown()),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/Row 2.*Ghost/) });
  });

  test('duplicate room rows in one round are refused', () => {
    const result = importPrelimCsv(
      'round,room,left_team,right_team\nRound 1,Room 101,Team A,Team B\nRound 1,Room 101,Team C,Team D\n',
      csvKnown(),
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/already has a game/) });
  });

  test('a bad header is refused', () => {
    expect(importPrelimCsv('a,b,c\n', csvKnown()).ok).toBe(false);
  });
});
