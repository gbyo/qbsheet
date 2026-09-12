/**
 * The file-handoff lifecycle marker in `_qbtcp.file_state`.
 *
 * Assignments say `assignment`, mid-game downloads say `partial`, finished results say
 * `complete` — declared by the writer at the moment of writing, never inferred from the score
 * by the reader. Stock YellowFruit ignores the key (it is novel to its conversion table, like
 * the rest of the block), and QBSheet's own importer reads straight through it.
 */

import { describe, expect, test } from 'vitest';
import {
  buildQbtcpExtension,
  readFileState,
  readQbtcpExtension,
  withFileState,
} from '../src/qbj/QbtcpExtension';
import { readQbjSource } from '../src/qbj/ParseQbjAssignment';

describe('file_state', () => {
  test('round-trips through the extension reader', () => {
    for (const state of ['assignment', 'partial', 'complete'] as const) {
      const block = buildQbtcpExtension({ fileState: state });
      expect(block).not.toBeNull();
      expect(readQbtcpExtension({ _qbtcp: block })?.fileState).toBe(state);
    }
  });

  test('an unknown state reads as absent rather than guessed', () => {
    expect(readFileState({ match_teams: [], _qbtcp: { version: 1, file_state: 'eventual' } })).toBeNull();
    expect(readFileState({ match_teams: [] })).toBeNull();
    expect(readFileState(null)).toBeNull();
  });

  test('stamping merges into an existing block and preserves its keys', () => {
    const match = {
      type: 'Match',
      id: 'm1',
      match_teams: [{}, {}],
      _qbtcp: { version: 1, room_id: 'slot-gold-1', handoff_instruction: 'Carry this out.' },
    };
    const stamped = withFileState(match, 'complete') as Record<string, unknown>;
    const block = stamped._qbtcp as Record<string, unknown>;
    expect(block.file_state).toBe('complete');
    expect(block.room_id).toBe('slot-gold-1');
    expect(block.handoff_instruction).toBe('Carry this out.');
  });

  test('stamping a whole document reaches its matches and nothing else', () => {
    const document = {
      version: '2.1.1',
      objects: [
        { type: 'Tournament', id: 't', phases: [] },
        { type: 'Team', id: 'a', players: [] },
        { type: 'Match', id: 'm1', match_teams: [{}, {}] },
      ],
    };
    const stamped = withFileState(document, 'partial') as {
      objects: Record<string, unknown>[];
    };
    const match = stamped.objects.find((entry) => entry.type === 'Match')!;
    expect((match._qbtcp as Record<string, unknown>).file_state).toBe('partial');
    const team = stamped.objects.find((entry) => entry.type === 'Team')!;
    expect(team._qbtcp).toBeUndefined();
  });

  test('a marked document still opens in QBSheet’s own importer', () => {
    const document = {
      version: '2.1.1',
      objects: [
        {
          type: 'Tournament',
          id: 't',
          name: 'T',
          scoring_rules: { $ref: 's' },
          registrations: [],
          phases: [],
        },
        { type: 'Team', id: 'a', name: 'A', players: [] },
        { type: 'Team', id: 'b', name: 'B', players: [] },
        {
          type: 'Match',
          id: 'm1',
          match_teams: [{ team: { $ref: 'a' } }, { team: { $ref: 'b' } }],
          _qbtcp: { version: 1, file_state: 'complete' },
        },
      ],
    };
    const source = readQbjSource(document);
    if (!source.ok) throw new Error(source.errors.join(' '));
    expect(source.ok).toBe(true);
  });
});
