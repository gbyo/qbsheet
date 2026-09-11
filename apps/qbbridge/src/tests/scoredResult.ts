/**
 * Assignment → scorer → completed result: the whole way a real game travels, offline.
 *
 * Used by the interop and round-trip tests, which both need a result that a scorer actually
 * produced rather than a hand-written document that resembles one.
 */

import deriveGame from '../../../../src/scoring/deriveGame';
import type { IGameSetup } from '../../../../src/scoring/deriveGame';
import type { ScoreEvent } from '../../../../src/scoring/ScoreEvents';
import type { IScorekeeperFormat } from '../../../../src/scoring/ScorekeeperFormat';
import { defineGame, readQbjSource } from '../../../../src/qbj/ParseQbjAssignment';
import { buildResultDocument } from '../../../../src/qbj/QbjResult';
import { buildAssignment } from '../model/assignment';
import type { BridgeTournament } from '../model/tournament';
import { loadedFixture } from './fixture';

type QbjObject = Record<string, unknown>;

function teamNamed(tournament: BridgeTournament, name: string) {
  const team = tournament.teams.find((entry) => entry.name === name);
  if (!team) throw new Error(`no team named ${name}`);
  return team;
}

function typeIndex(format: IScorekeeperFormat, value: number): number {
  const found = format.answerTypes.find((answerType) => answerType.value === value);
  if (!found) throw new Error(`no answer type worth ${value}`);
  return found.index;
}

let eventSequence = 0;
function scoreEvent(partial: Omit<ScoreEvent, 'id'>): ScoreEvent {
  eventSequence += 1;
  return { ...partial, id: `e${eventSequence}` } as ScoreEvent;
}

/** A short game with a power, a neg, and bonuses on both sides. */
function playedEvents(format: IScorekeeperFormat, left: string[], right: string[]): ScoreEvent[] {
  return [
    scoreEvent({
      type: 'tossup-buzz',
      questionNumber: 1,
      team: 'left',
      playerName: left[0],
      answerTypeIndex: typeIndex(format, 15),
    } as Omit<ScoreEvent, 'id'>),
    scoreEvent({
      type: 'bonus',
      questionNumber: 1,
      team: 'left',
      controlledPoints: 20,
    } as Omit<ScoreEvent, 'id'>),
    scoreEvent({
      type: 'tossup-buzz',
      questionNumber: 2,
      team: 'left',
      playerName: left[1],
      answerTypeIndex: typeIndex(format, -5),
    } as Omit<ScoreEvent, 'id'>),
    scoreEvent({
      type: 'tossup-buzz',
      questionNumber: 2,
      team: 'right',
      playerName: right[0],
      answerTypeIndex: typeIndex(format, 10),
    } as Omit<ScoreEvent, 'id'>),
    scoreEvent({
      type: 'bonus',
      questionNumber: 2,
      team: 'right',
      controlledPoints: 30,
    } as Omit<ScoreEvent, 'id'>),
  ];
}

/** Assignment → scorer → completed result, the whole way a real game travels. */
export function scoredResultDocument(options: { left?: string; right?: string } = {}): {
  result: { version: string; objects: QbjObject[] };
  matchId: string;
  tournament: BridgeTournament;
} {
  const tournament = loadedFixture();
  const built = buildAssignment({
    tournament,
    round: tournament.rounds[3],
    roomId: 'room-1',
    roomName: 'Room 101',
    left: teamNamed(tournament, options.left ?? 'Cony'),
    right: teamNamed(tournament, options.right ?? 'Deering'),
    assignmentRevision: 1,
  });
  if (!built.ok) throw new Error(built.error);

  const source = readQbjSource(built.assignment.document);
  if (!source.ok) throw new Error(source.errors.join(' '));
  const defined = defineGame(source.value, source.value.candidates[0].index);
  if (!defined.ok) throw new Error(defined.errors.join(' '));
  const definition = defined.definition;
  const format = definition.scorekeeperFormat;

  const setup: IGameSetup = {
    left: { name: definition.left.name, players: definition.left.players.map((entry) => entry.name) },
    right: { name: definition.right.name, players: definition.right.players.map((entry) => entry.name) },
  };
  const game = deriveGame(format, setup, playedEvents(format, setup.left.players, setup.right.players));
  const result = buildResultDocument({ definition, format, game }) as {
    version: string;
    objects: QbjObject[];
  };
  return { result, matchId: built.assignment.matchId, tournament };
}
