/**
 * The public schedule follows the explicit tournament-day sequence.
 *
 * A no-time tournament — Rounds 1-5, Lunch, Rounds 6-9, none of it with a
 * clock time — must still project in day order, with the sequence carried on
 * each timeline event and scheduled game. Sequenceless snapshots keep the
 * legacy time/id order.
 */

import { describe, expect, test } from 'vitest';
import {
  defaultLivePublicationSettings,
  defaultRules,
  emptyDirectorState,
  type DirectorState,
} from '@qbsheet/tournament-domain';
import type { QbliveCapabilities } from '@qbsheet/qblive-protocol';
import { projectLiveSnapshot } from '../src/projection';

const capabilities: QbliveCapabilities = { snapshot: true, events: true, stream: true, applePush: false };
const generatedAt = new Date('2026-09-05T14:30:00.000Z');

function settings() {
  const next = defaultLivePublicationSettings();
  next.enabled = true;
  next.releasedSchedule = true;
  return next;
}

function project(state: DirectorState) {
  return projectLiveSnapshot({
    state,
    settings: settings(),
    publicationId: 'bcdfghjkmnpqrstvwxyz',
    revision: 1,
    generatedAt,
    capabilities,
  });
}

/** Rounds 1, 2 and lunch between them; no clock time anywhere. */
function untimedDay(): DirectorState {
  const state = emptyDirectorState();
  const at = '2026-09-05T14:00:00.000Z';
  state.tournament = {
    id: 'tournament-1',
    name: 'Saturday Invitational',
    date: '2026-09-05',
    venue: '',
    organizer: '',
    status: 'running',
    timeZone: 'UTC',
    rules: structuredClone(defaultRules),
    formatId: null,
    currentPhaseId: 'phase-1',
    currentPacketId: null,
    currentRoundId: 'round-1',
    createdAt: at,
    updatedAt: at,
  };
  state.phases = [
    {
      id: 'phase-1',
      name: 'Preliminary',
      kind: 'preliminary',
      order: 0,
      formatId: 'format-1',
      roundIds: ['round-1', 'round-2'],
      poolIds: [],
      advancementRule: null,
      carryover: false,
      status: 'active',
    },
  ];
  state.rounds = [
    {
      id: 'round-1',
      phaseId: 'phase-1',
      name: 'Round 1',
      number: 1,
      revision: 1,
      status: 'released',
      packetId: null,
      scheduledGameIds: ['game-1'],
      dayOrder: 0,
      scheduledStart: null,
      releasedAt: null,
      startedAt: null,
      closedAt: null,
    },
    {
      id: 'round-2',
      phaseId: 'phase-1',
      name: 'Round 2',
      number: 2,
      revision: 1,
      status: 'released',
      packetId: null,
      scheduledGameIds: ['game-2'],
      dayOrder: 2,
      scheduledStart: null,
      releasedAt: null,
      startedAt: null,
      closedAt: null,
    },
  ];
  state.timeline = [
    {
      id: 'lunch',
      type: 'lunch',
      title: 'Lunch',
      visibility: 'public',
      dayOrder: 1,
      scheduledStart: null,
      scheduledEnd: null,
      createdAt: '',
      updatedAt: '',
    },
  ];
  state.scheduledGames = [
    {
      id: 'game-1',
      roundId: 'round-1',
      poolId: null,
      roomId: null,
      packetId: null,
      leftTeamId: 'team-a',
      rightTeamId: 'team-b',
      bye: false,
      status: 'released',
      assignmentRevision: 1,
    },
    {
      id: 'game-2',
      roundId: 'round-2',
      poolId: null,
      roomId: null,
      packetId: null,
      leftTeamId: 'team-a',
      rightTeamId: 'team-b',
      bye: false,
      status: 'released',
      assignmentRevision: 1,
    },
  ];
  return state;
}

describe('sequence-first public schedule', () => {
  test('timeline events carry the day sequence in day order', () => {
    const snapshot = project(untimedDay());
    expect(snapshot.timeline.map((event) => event.id)).toEqual(['lunch']);
    expect(snapshot.timeline[0].sequence).toBe(1);
    expect(snapshot.timeline[0].scheduledStart).toBeNull();
  });

  test('scheduled games carry their round sequence and sort by it', () => {
    const snapshot = project(untimedDay());
    expect(snapshot.schedule.map((game) => game.id)).toEqual(['game-1', 'game-2']);
    expect(snapshot.schedule.map((game) => game.sequence)).toEqual([0, 2]);
  });

  test('sequenceless snapshots keep the legacy order', () => {
    const state = untimedDay();
    for (const round of state.rounds) delete round.dayOrder;
    for (const event of state.timeline) delete event.dayOrder;
    const snapshot = project(state);
    expect(snapshot.timeline[0].sequence).toBeNull();
    expect(snapshot.schedule.map((game) => game.sequence)).toEqual([null, null]);
    expect(snapshot.schedule.map((game) => game.id)).toEqual(['game-1', 'game-2']);
  });

  test('day order beats round number when they disagree', () => {
    const state = untimedDay();
    // Round 2 deliberately sequenced before Round 1: the director moved it.
    state.rounds[0].dayOrder = 5;
    state.rounds[1].dayOrder = 1;
    const snapshot = project(state);
    expect(snapshot.schedule.map((game) => game.id)).toEqual(['game-2', 'game-1']);
  });
});
