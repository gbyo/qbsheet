/**
 * What a prepared assignment is allowed to contain, and what it must never contain.
 *
 * The leak tests are the ones worth reading twice. An assignment goes onto a USB stick handed to a
 * volunteer, so "does this file contain next round's bracket" and "does this file contain a token"
 * are not code-review questions — they are properties that have to be asserted about the bytes.
 */
import { describe, expect, it } from 'vitest';
import { buildAssignment, currentOperationalRound, selectScheduledGames } from './assignment';
import { findSecretKeys } from './canonical';
import { assignmentFileName, sanitizeFileSegment, uniqueFileName } from './filenames';
import { buildManifest, exchangePaths, parseManifest, readmeText } from './layout';
import { assignmentFor, directorFixture, fixtureTournamentId } from './testFixtures';

describe('a one-game assignment', () => {
  it('is an official serialized QBJ document with exactly one unplayed match', () => {
    const state = directorFixture();
    const assignment = assignmentFor(state, 'game-5-1');
    const document = assignment.document as { version: string; objects: Array<Record<string, unknown>> };

    expect(document.version).toBe('2.1.1');
    const matches = document.objects.filter((object) => object.type === 'Match');
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('game-5-1');
    expect(matches[0].location).toBe('Room 101');

    // Unplayed means the absence of scoring content, not a fabricated zero. A zeroed total is what
    // makes an assignment indistinguishable from a 0-0 result to an importer.
    expect(matches[0].tossups_read).toBeUndefined();
    const teams = matches[0].match_teams as Array<Record<string, unknown>>;
    expect(teams).toHaveLength(2);
    teams.forEach((team) => {
      expect(team.points).toBeUndefined();
      expect(team.match_players).toBeUndefined();
    });
  });

  it('carries the tournament, scoring rules, the two teams, the phase and the round', () => {
    const state = directorFixture();
    const document = assignmentFor(state, 'game-5-1').document as {
      objects: Array<Record<string, unknown>>;
    };
    const types = document.objects.map((object) => object.type);
    expect(types).toContain('Tournament');
    expect(types).toContain('ScoringRules');
    expect(types).toContain('Phase');
    expect(types).toContain('Round');
    expect(types).toContain('Packet');
    expect(document.objects.filter((object) => object.type === 'Team')).toHaveLength(2);
    expect(document.objects.filter((object) => object.type === 'Registration')).toHaveLength(2);

    const rules = document.objects.find((object) => object.type === 'ScoringRules');
    // Structural rules only. Nothing downstream may branch on the name of a rule set, so the fields
    // that decide scoring have to be present and explicit.
    expect(rules?.regulation_tossup_count).toBe(20);
    expect(rules?.maximum_players_per_team).toBe(4);
    expect(rules?.bonuses_bounce_back).toBe(false);
    expect(rules?.overtime_includes_bonuses).toBe(true);
    expect((rules?.answer_types as unknown[]).length).toBe(3);
  });

  it('carries the round and assignment revisions so a stale return is detectable', () => {
    const state = directorFixture({ roundRevision: 3 });
    state.scheduledGames[0].assignmentRevision = 7;
    const document = assignmentFor(state, 'game-5-1').document as {
      objects: Array<Record<string, unknown>>;
    };
    const match = document.objects.find((object) => object.type === 'Match');
    const extension = match?._qbtcp as Record<string, unknown>;
    expect(extension.version).toBe(1);
    expect(extension.round_revision).toBe(3);
    expect(extension.assignment_revision).toBe(7);
    expect(extension.room_id).toBe('room-101');
  });

  it('names only its own teams, its own round and its own match', () => {
    const state = directorFixture({ games: 4 });
    const assignment = assignmentFor(state, 'game-5-1');

    // Every other scheduled game in the tournament, including all of unreleased round 6.
    const otherGameIds = state.scheduledGames.filter((game) => game.id !== 'game-5-1').map((game) => game.id);
    otherGameIds.forEach((id) => expect(assignment.text).not.toContain(id));

    expect(assignment.text).not.toContain('round-6');
    expect(assignment.text).not.toContain('Round 6');

    // The four teams that are not playing this game must not appear either: a roster is as much a
    // pairing leak as a match id when a room can read who else is in the bracket.
    ['team-3', 'team-4', 'team-5', 'team-6', 'team-7', 'team-8'].forEach((id) =>
      expect(assignment.text).not.toContain(`"${id}"`),
    );
    expect(assignment.text).toContain('team-1');
    expect(assignment.text).toContain('team-2');
  });

  it('contains nothing credential-shaped, even when Director state does', () => {
    const state = directorFixture();
    // Something operational and secret sitting in Director state, of the kind that must never ride
    // out on a file: a live pairing code and a session token.
    state.qbtcpSessions.push({
      roomId: 'room-101',
      sessionId: 'session-secret-1',
      deviceId: 'device-abc',
      state: 'live',
      lastSeenAt: '2026-09-05T12:00:00.000Z',
      progress: null,
      helpRequestId: null,
    });
    const assignment = assignmentFor(state, 'game-5-1');

    expect(findSecretKeys(assignment.document)).toEqual([]);
    ['session-secret-1', 'device-abc', 'pairingCode', 'Authorization', 'accessToken'].forEach((needle) =>
      expect(assignment.text).not.toContain(needle),
    );
  });

  it('refuses a bye, a cancelled game and a game whose team has gone', () => {
    const state = directorFixture();
    state.scheduledGames.push({
      id: 'game-5-bye',
      roundId: 'round-5',
      roomId: null,
      packetId: null,
      leftTeamId: 'team-1',
      rightTeamId: null,
      bye: true,
      status: 'released',
      assignmentRevision: 1,
    });
    state.scheduledGames[1].status = 'cancelled';
    expect(buildAssignment(state, 'game-5-bye').ok).toBe(false);
    expect(buildAssignment(state, 'game-5-2').ok).toBe(false);
    expect(buildAssignment(state, 'nonexistent').ok).toBe(false);
  });

  it('reports a missing roster as a warning rather than refusing the file', () => {
    const state = directorFixture();
    state.players = state.players.filter((player) => player.teamId !== 'team-2');
    const built = buildAssignment(state, 'game-5-1');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.assignment.warnings.join(' ')).toContain('Greenwood A has no roster');
  });
});

describe('selecting which games to prepare', () => {
  it('includes rooms that are already connected over QBTCP', () => {
    const state = directorFixture({ games: 4 });
    state.qbtcpSessions.push({
      roomId: 'room-101',
      sessionId: 'session-1',
      deviceId: 'device-1',
      state: 'live',
      lastSeenAt: '2026-09-05T12:00:00.000Z',
      progress: null,
      helpRequestId: null,
    });
    // The backup case: every room could be connected and the director still wants every file.
    expect(selectScheduledGames(state, { kind: 'current-round' })).toHaveLength(4);
    // And the narrower selection is available when it is what the director asked for.
    expect(selectScheduledGames(state, { kind: 'unconnected-rooms' })).toHaveLength(3);
  });

  it('never includes a bye or a cancelled game', () => {
    const state = directorFixture();
    state.scheduledGames[0].status = 'cancelled';
    expect(selectScheduledGames(state, { kind: 'current-round' }).map((game) => game.id)).toEqual([
      'game-5-2',
    ]);
  });

  it('does not offer a closed current round as an outgoing assignment set', () => {
    const state = directorFixture();
    state.rounds = [state.rounds[0]!];
    state.rounds[0].status = 'closed';
    state.scheduledGames = state.scheduledGames.filter((game) => game.roundId === state.rounds[0].id);
    expect(currentOperationalRound(state)).toBeUndefined();
    expect(selectScheduledGames(state, { kind: 'current-round' })).toHaveLength(0);
  });
});

describe('filenames', () => {
  it('reads as a person would write it', () => {
    expect(
      assignmentFileName({
        roundName: 'Round 5',
        roomName: 'Room 104',
        leftTeam: 'Ninety Six A',
        rightTeam: 'Greenwood A',
      }),
    ).toBe('Round 5 - Room 104 - Ninety Six A vs Greenwood A.qbj');
  });

  it('survives the union of macOS, Windows and Linux rules', () => {
    // A separator must not become a directory, or a team name could write outside the destination.
    expect(sanitizeFileSegment('Ninety/Six: A?')).toBe('Ninety-Six- A-');
    expect(sanitizeFileSegment('trailing dot.')).toBe('trailing dot');
    expect(sanitizeFileSegment('   ')).toBe('file');
    // Windows reserves these with any extension, so a team called "CON" would produce an unopenable
    // file on a machine that is not the one that wrote it.
    expect(sanitizeFileSegment('CON')).toBe('_CON');
    expect(sanitizeFileSegment('com1.qbj')).toBe('_com1.qbj');
    expect(sanitizeFileSegment('a'.repeat(400)).length).toBeLessThanOrEqual(120);
  });

  it('suffixes a collision rather than overwriting the first file', () => {
    const taken = new Set(['round 5 - a vs b.qbj']);
    expect(uniqueFileName('Round 5 - A vs B.qbj', taken)).toBe('Round 5 - A vs B (2).qbj');
  });
});

describe('the transfer manifest', () => {
  it('round-trips, and carries identity rather than secrets', () => {
    const manifest = buildManifest({
      tournamentId: fixtureTournamentId,
      tournamentName: 'Saturday Invitational',
      preparedAt: '2026-09-05T16:14:00.000Z',
      directorBuild: 'QBSheet Director 1',
      assignments: [
        {
          matchId: 'game-5-1',
          roundId: 'round-5',
          roundName: 'Round 5',
          roundRevision: 3,
          assignmentRevision: 7,
          fileName: 'Round 5 - Room 101 - Ninety Six A vs Greenwood A.qbj',
          room: 'Room 101',
          teams: ['Ninety Six A', 'Greenwood A'],
        },
      ],
    });
    const parsed = parseManifest(JSON.parse(JSON.stringify(manifest)));
    expect(parsed?.assignments[0].assignmentRevision).toBe(7);
    expect(parsed?.tournamentId).toBe(fixtureTournamentId);
    expect(findSecretKeys(manifest)).toEqual([]);
  });

  it('is refused rather than half-believed when it is malformed or from another version', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest({ manifestVersion: 99, tournamentId: 'x' })).toBeNull();
    expect(parseManifest({ manifestVersion: 1 })).toBeNull();
    // A truncated entry is dropped; the rest of the manifest is still usable.
    const partial = parseManifest({
      manifestVersion: 1,
      tournamentId: 't',
      assignments: [{ matchId: 'm' }, { matchId: 'm2', fileName: 'f.qbj' }],
    });
    expect(partial?.assignments).toHaveLength(1);
  });
});

describe('the exchange layout', () => {
  it('nests under the chosen folder, and does not re-nest one it already made', () => {
    expect(exchangePaths('/Volumes/SANDISK').root).toBe('/Volumes/SANDISK/QBSheet');
    expect(exchangePaths('/Volumes/SANDISK/QBSheet').root).toBe('/Volumes/SANDISK/QBSheet');
    expect(exchangePaths('C:\\Users\\td\\Exchange').assignments).toBe(
      'C:\\Users\\td\\Exchange\\QBSheet\\Assignments',
    );
  });

  it('writes a README that states the rule a rename cannot break', () => {
    const text = readmeText('Saturday Invitational');
    expect(text).toContain('Assignments folder');
    expect(text).toContain('Do not rename files merely to change their assigned game.');
  });
});
