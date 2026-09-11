import { describe, expect, test } from 'vitest';
import {
  accountRound,
  dispositionFor,
  normalizeRoundDispositions,
  reconcileDispositions,
  roundPublishGate,
  setTeamDisposition,
  type RoundDisposition,
} from './roundAccountability';
import type { PlannedPairing } from './roundPlans';

const teams = new Set(['a', 'b', 'c', 'd']);
const rooms = new Set(['room-1', 'room-2']);

function pairing(roomId: string, left: string | null, right: string | null): PlannedPairing {
  return { roomId, leftTeamId: left, rightTeamId: right };
}

describe('team dispositions', () => {
  test('setting a bye records it and clearing drops the round entry', () => {
    let dispositions: RoundDisposition[] = [];
    dispositions = setTeamDisposition(dispositions, 'round-1', 'a', 'bye');
    expect(dispositionFor(dispositions, 'round-1', 'a')).toBe('bye');
    dispositions = setTeamDisposition(dispositions, 'round-1', 'a', null);
    expect(dispositions).toEqual([]);
  });

  test('bye and inactive are mutually exclusive per team', () => {
    let dispositions: RoundDisposition[] = [];
    dispositions = setTeamDisposition(dispositions, 'round-1', 'a', 'bye');
    dispositions = setTeamDisposition(dispositions, 'round-1', 'a', 'inactive');
    expect(dispositionFor(dispositions, 'round-1', 'a')).toBe('inactive');
    expect(dispositions).toEqual([{ roundId: 'round-1', byes: [], inactive: ['a'] }]);
  });

  test('stored contradictions normalize to unaccounted rather than decided', () => {
    const normalized = normalizeRoundDispositions([
      { roundId: 'round-1', byes: ['a'], inactive: ['a', 'b'] },
    ]);
    expect(normalized).toEqual([{ roundId: 'round-1', byes: [], inactive: ['b'] }]);
    const account = accountRound({
      pairings: [],
      dispositions: normalized,
      roundId: 'round-1',
      teamIds: new Set(['a', 'b']),
      roomIds: new Set(),
    });
    expect(account.unaccounted).toEqual(['a']);
  });

  test('reconciliation drops unknown teams and rounds by id only', () => {
    const report = reconcileDispositions(
      [
        { roundId: 'round-1', byes: ['a', 'gone'], inactive: [] },
        { roundId: 'gone-round', byes: ['b'], inactive: [] },
      ],
      { roundIds: new Set(['round-1']), teamIds: new Set(['a', 'b']) },
    );
    expect(report.dispositions).toEqual([{ roundId: 'round-1', byes: ['a'], inactive: [] }]);
    expect(report.droppedTeamCount).toBe(1);
    expect(report.droppedRoundIds).toEqual(['gone-round']);
  });
});

describe('round accounting', () => {
  test('a clean 12-team round proves all teams accounted for', () => {
    const teamIds = new Set(Array.from({ length: 12 }, (_, index) => `team-${index + 1}`));
    const roomIds = new Set(Array.from({ length: 6 }, (_, index) => `room-${index + 1}`));
    const pairings = [...roomIds].map((roomId, index): PlannedPairing => ({
      roomId,
      leftTeamId: `team-${index * 2 + 1}`,
      rightTeamId: `team-${index * 2 + 2}`,
    }));
    const account = accountRound({ pairings, dispositions: [], roundId: 'r1', teamIds, roomIds });
    expect(account.summary).toBe('12 teams accounted for · 6 games · 0 byes');
    expect(account.unaccounted).toEqual([]);
    expect(roundPublishGate(account)).toEqual({ blocks: [], warnings: [] });
  });

  test('an 11-team round represents one bye without inventing a sixth game', () => {
    const teamIds = new Set(Array.from({ length: 11 }, (_, index) => `team-${index + 1}`));
    const roomIds = new Set(Array.from({ length: 6 }, (_, index) => `room-${index + 1}`));
    const pairings = [...roomIds].slice(0, 5).map((roomId, index): PlannedPairing => ({
      roomId,
      leftTeamId: `team-${index * 2 + 1}`,
      rightTeamId: `team-${index * 2 + 2}`,
    }));
    const dispositions = setTeamDisposition([], 'r1', 'team-11', 'bye');
    const account = accountRound({ pairings, dispositions, roundId: 'r1', teamIds, roomIds });
    expect(account.summary).toBe('11 teams accounted for · 5 games · 1 bye');
    expect(account.byes).toEqual(['team-11']);
    expect(roundPublishGate(account)).toEqual({ blocks: [], warnings: [] });
  });

  test('missing teams are visible before publish', () => {
    const account = accountRound({
      pairings: [pairing('room-1', 'a', 'b')],
      dispositions: [],
      roundId: 'r1',
      teamIds: teams,
      roomIds: rooms,
    });
    expect(account.unaccounted).toEqual(['c', 'd']);
    expect(account.summary).toBe('2 teams accounted for · 1 game · 0 byes');
    const gate = roundPublishGate(account);
    expect(gate.blocks).toEqual([]);
    expect(gate.warnings).toHaveLength(1);
    expect(gate.warnings[0]).toMatch(/c.*d|2 teams are neither assigned/);
  });

  test('a team in two rooms blocks publication', () => {
    const account = accountRound({
      pairings: [pairing('room-1', 'a', 'b'), pairing('room-2', 'a', 'c')],
      dispositions: [setTeamDisposition([], 'r1', 'd', 'bye')[0]],
      roundId: 'r1',
      teamIds: teams,
      roomIds: rooms,
    });
    expect(account.duplicates).toEqual([{ teamId: 'a', roomIds: ['room-1', 'room-2'] }]);
    const gate = roundPublishGate(account);
    expect(gate.blocks).toHaveLength(1);
    expect(gate.blocks[0]).toMatch(/a.*2 rooms/);
  });

  test('assigned plus bye contradictions block publication', () => {
    const account = accountRound({
      pairings: [pairing('room-1', 'a', 'b')],
      // A stored contradiction cannot come from the setter, which is exclusive — but a stale
      // persisted state or a future caller could still hand one to the report.
      dispositions: [{ roundId: 'r1', byes: ['a'], inactive: [] }],
      roundId: 'r1',
      teamIds: teams,
      roomIds: rooms,
    });
    expect(account.contradictions).toEqual(['a']);
    const gate = roundPublishGate(account);
    expect(gate.blocks.some((block) => /both assigned.*bye/i.test(block))).toBe(true);
  });

  test('stale team and room references block publication', () => {
    const account = accountRound({
      pairings: [pairing('room-1', 'a', 'withdrawn'), pairing('deleted-room', 'b', 'c')],
      dispositions: [],
      roundId: 'r1',
      teamIds: teams,
      roomIds: rooms,
    });
    expect(account.staleTeamIds).toEqual(['withdrawn']);
    expect(account.staleRoomIds).toEqual(['deleted-room']);
    // The stale team itself never counts as assigned; the known side reads as incomplete.
    expect(account.assigned.find((entry) => entry.teamId === 'withdrawn')).toBeUndefined();
    expect(account.incomplete).toEqual([{ roomId: 'room-1', chosenTeamId: 'a', side: 'left' }]);
    const gate = roundPublishGate(account);
    expect(gate.blocks).toHaveLength(2);
  });

  test('incomplete pairings surface with the chosen side', () => {
    const account = accountRound({
      pairings: [pairing('room-1', 'a', null)],
      dispositions: [],
      roundId: 'r1',
      teamIds: teams,
      roomIds: rooms,
    });
    expect(account.incomplete).toEqual([{ roomId: 'room-1', chosenTeamId: 'a', side: 'left' }]);
    expect(account.games).toBe(0);
  });

  test('same-team pairings build nothing and read as unaccounted', () => {
    const account = accountRound({
      pairings: [pairing('room-1', 'a', 'a')],
      dispositions: [],
      roundId: 'r1',
      teamIds: teams,
      roomIds: rooms,
    });
    expect(account.games).toBe(0);
    expect(account.unaccounted).toContain('a');
  });
});
