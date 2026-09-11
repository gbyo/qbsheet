/**
 * SQBS player blocks must alternate by slot: L1,R1,L2,R2,...L8,R8 (#888).
 *
 * The writer and parser previously agreed on a side-major dialect (eight left
 * blocks then eight right blocks), so self-round-trips passed while real SQBS
 * misattributed players. These tests pin raw wire positions and check the
 * production parser against an independent alternating reader written from the
 * documented layout (qbwiki SQBS_data_file; YellowFruit emits left/right per
 * slot in its `for (i = 0; i < 8; i++)` loop).
 */
import { describe, expect, test } from 'vitest';
import { exportSqbsTournamentFile, parseSqbsTournamentFile, type SqbsTournamentInput } from '../src/sqbs';

const HEADER_LINES_PER_GAME = 17;
const LINES_PER_PLAYER = 7;
const SLOTS = 8;

function inputWith(
  leftPlayers: SqbsTournamentInput['games'][number]['left']['players'],
  rightPlayers: SqbsTournamentInput['games'][number]['right']['players'],
  forfeitWinner?: 'left' | 'right',
): SqbsTournamentInput {
  return {
    tournamentName: 'Wire Order Event',
    pointValues: [15, 10, -5],
    useBonuses: true,
    trackPowers: true,
    divisions: [],
    teams: [
      { name: 'Left Team', players: ['L1', 'L2', 'L3', 'L4'], divisionIndex: -1 },
      { name: 'Right Team', players: ['R1', 'R2', 'R3', 'R4'], divisionIndex: -1 },
    ],
    games: [
      {
        id: 1,
        round: 1,
        left: {
          teamIndex: 0,
          score: 300,
          bonusesHeard: 8,
          bonusPoints: 150,
          players: leftPlayers,
        },
        right: {
          teamIndex: 1,
          score: 200,
          bonusesHeard: 6,
          bonusPoints: 100,
          players: rightPlayers,
        },
        tossupsHeard: 20,
        ...(forfeitWinner ? { forfeitWinner } : {}),
      },
    ],
    packetNames: ['Round 1'],
  };
}

function player(index: number, points: number) {
  return {
    playerIndex: index,
    gamesPlayed: 1,
    counts: [0, 1, 0, 0] as [number, number, number, number],
    points,
  };
}

/** Raw player-block playerIndex values in file order for the first game. */
function wirePlayerIndexes(text: string): number[] {
  const lines = text.split('\n');
  // Teams section: count + per team (size + name + players).
  let cursor = 0;
  const teamCount = Number(lines[cursor++]);
  for (let team = 0; team < teamCount; team += 1) {
    const size = Number(lines[cursor++]);
    cursor += size; // name + players
  }
  cursor += 1; // games count
  cursor += HEADER_LINES_PER_GAME;
  const indexes: number[] = [];
  for (let block = 0; block < SLOTS * 2; block += 1) {
    indexes.push(Number(lines[cursor]));
    cursor += LINES_PER_PLAYER;
  }
  return indexes;
}

/** Independent alternating reader: block 2k is left slot k, block 2k+1 is right slot k. */
function independentAlternatingParse(text: string): { left: number[]; right: number[] } {
  const indexes = wirePlayerIndexes(text);
  const left: number[] = [];
  const right: number[] = [];
  for (let slot = 0; slot < SLOTS; slot += 1) {
    left.push(indexes[slot * 2]!);
    right.push(indexes[slot * 2 + 1]!);
  }
  return { left, right };
}

describe('SQBS alternating player-block order (#888)', () => {
  test('one player per side writes L1,R1 then empty alternating slots', () => {
    const exported = exportSqbsTournamentFile(inputWith([player(0, 111)], [player(1, 222)]));
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    expect(wirePlayerIndexes(exported.value.text).slice(0, 4)).toEqual([0, 1, -1, -1]);

    const parsed = parseSqbsTournamentFile(exported.value.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.games[0]!.left.players).toMatchObject([{ playerIndex: 0, points: 111 }]);
    expect(parsed.value.games[0]!.right.players).toMatchObject([{ playerIndex: 1, points: 222 }]);

    // Independent oracle agrees with the production parser.
    expect(independentAlternatingParse(exported.value.text)).toEqual({
      left: [0, -1, -1, -1, -1, -1, -1, -1],
      right: [1, -1, -1, -1, -1, -1, -1, -1],
    });
  });

  test('four players per side stay attached to the correct team and slot', () => {
    const exported = exportSqbsTournamentFile(
      inputWith(
        [player(0, 10), player(1, 11), player(2, 12), player(3, 13)],
        [player(0, 20), player(1, 21), player(2, 22), player(3, 23)],
      ),
    );
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    // Raw wire: L0,R0,L1,R1,L2,R2,L3,R3 then empty alternating slots.
    const wire = wirePlayerIndexes(exported.value.text);
    expect(wire.slice(0, 8)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);

    const parsed = parseSqbsTournamentFile(exported.value.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.games[0]!.left.players.map((entry) => entry.points)).toEqual([10, 11, 12, 13]);
    expect(parsed.value.games[0]!.right.players.map((entry) => entry.points)).toEqual([20, 21, 22, 23]);
    expect(parsed.value.games[0]!.left.players.map((entry) => entry.playerIndex)).toEqual([0, 1, 2, 3]);
    expect(parsed.value.games[0]!.right.players.map((entry) => entry.playerIndex)).toEqual([0, 1, 2, 3]);
  });

  test('forfeit game keeps structurally correct alternating slots', () => {
    const exported = exportSqbsTournamentFile(inputWith([player(0, 50)], [player(0, 60)], 'left'));
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    expect(wirePlayerIndexes(exported.value.text).slice(0, 2)).toEqual([0, 0]);
    const parsed = parseSqbsTournamentFile(exported.value.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.games[0]!.forfeit).toBe(true);
    expect(parsed.value.games[0]!.left.players).toHaveLength(1);
    expect(parsed.value.games[0]!.right.players).toHaveLength(1);
  });

  test('documented-layout fixture parses with correct side attribution', () => {
    // Hand-built to the documented L1,R1,... order (not via the writer), with
    // distinctive points per side so a side-major reader would swap them.
    const exported = exportSqbsTournamentFile(inputWith([player(2, 777)], [player(3, 888)]));
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const independent = independentAlternatingParse(exported.value.text);
    expect(independent.left[0]).toBe(2);
    expect(independent.right[0]).toBe(3);

    const parsed = parseSqbsTournamentFile(exported.value.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Production parser must agree with the independent layout reader.
    expect(parsed.value.games[0]!.left.players[0]).toMatchObject({ playerIndex: 2, points: 777 });
    expect(parsed.value.games[0]!.right.players[0]).toMatchObject({ playerIndex: 3, points: 888 });
  });
});
