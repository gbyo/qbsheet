/**
 * The demo tournament's own tests.
 *
 * A demo backend that serves something the protocol rejects, or a tournament whose standings do not
 * follow from its results, costs more than it saves: the next person to see a wrong number in the
 * app goes looking for it in the app. These are the properties that make the demo trustworthy
 * enough to debug against.
 *
 * Run with the rest of the Node suite: `npx vitest --run scripts/qblive-demo`.
 */

import { describe, expect, it } from 'vitest';

import { projectLiveSnapshot, changedSections, pickSections } from '@qbsheet/qblive-projection';
import { applyEvent, parseSnapshot } from '@qbsheet/qblive-protocol';
import { acceptedGameRecords, deriveTeamStandings } from '@qbsheet/tournament-domain';

import { createDemoBackend } from './server.mjs';
import { createDemoTournament, demoSchedule, demoSettings } from './tournament.mjs';

const capabilities = { snapshot: true, events: true, stream: true, applePush: false };

/** A fixed day, so a test does not read differently on the two days a year the offset changes. */
function tournament(overrides = {}) {
  return createDemoTournament({ day: '2026-09-05', ...overrides });
}

function snapshotAt(demo, instant, settings = demoSettings()) {
  return projectLiveSnapshot({
    state: demo.documentAt(instant),
    settings,
    publicationId: demo.publicationId,
    revision: 1,
    generatedAt: instant,
    capabilities,
  });
}

/** Instants spread across the tournament day, including its edges. */
function acrossTheDay(demo) {
  const span = demo.closesAt.getTime() - demo.opensAt.getTime();
  return Array.from({ length: 24 }, (_, index) => new Date(demo.opensAt.getTime() + (span * index) / 23));
}

describe('the demo tournament', () => {
  it('starts its first round at nine in its own zone', () => {
    const demo = tournament();
    // 2026-09-05 is inside daylight time in New York, so nine local is 13:00Z.
    expect(demo.firstRound.toISOString()).toBe('2026-09-05T13:00:00.000Z');
  });

  it('plays a real round robin: everybody once, nobody twice', () => {
    const demo = tournament();
    const state = demo.documentAt(demo.closesAt);
    const prelims = state.scheduledGames.filter((game) => game.roundId !== 'round-final');
    expect(prelims).toHaveLength((demo.teamIds.length / 2) * demoSchedule.prelimRounds);

    const pairings = prelims.map((game) => [game.leftTeamId, game.rightTeamId].sort().join(' v '));
    expect(new Set(pairings).size).toBe(pairings.length);
    for (const teamId of demo.teamIds) {
      const played = prelims.filter((game) => game.leftTeamId === teamId || game.rightTeamId === teamId);
      expect(played).toHaveLength(demoSchedule.prelimRounds);
    }
  });

  it('is a pure function of the clock', () => {
    const demo = tournament();
    const instant = new Date(demo.firstRound.getTime() + 100 * 60_000);
    expect(JSON.stringify(demo.documentAt(instant))).toBe(JSON.stringify(demo.documentAt(instant)));

    // And a rebuilt tournament with the same seed is the same tournament.
    expect(JSON.stringify(tournament().documentAt(instant))).toBe(JSON.stringify(demo.documentAt(instant)));
  });

  it('plays differently under a different seed', () => {
    const instant = new Date(tournament().firstRound.getTime() + 100 * 60_000);
    const one = snapshotAt(tournament({ seed: 1 }), instant);
    const other = snapshotAt(tournament({ seed: 2 }), instant);
    expect(JSON.stringify(one.results)).not.toBe(JSON.stringify(other.results));
  });

  it('publishes a snapshot the protocol accepts, at every point in the day', () => {
    const demo = tournament();
    for (const instant of acrossTheDay(demo)) {
      expect(() => parseSnapshot(snapshotAt(demo, instant))).not.toThrow();
    }
  });

  it('never publishes a round before it is released', () => {
    const demo = tournament();
    for (const instant of acrossTheDay(demo)) {
      const state = demo.documentAt(instant);
      const snapshot = snapshotAt(demo, instant);
      const published = new Set(snapshot.schedule.map((game) => game.id));
      for (const game of state.scheduledGames) {
        const round = state.rounds.find((candidate) => candidate.id === game.roundId);
        if (round.status === 'planned') expect(published.has(game.id)).toBe(false);
      }
    }
  });

  it('scores a live game consistently with the result it becomes', () => {
    const demo = tournament();
    const firstGame = demo.rounds[0].games[0];
    const end = new Date(
      firstGame.start.getTime() + demoSchedule.tossupsPerGame * demoSchedule.tossupSeconds * 1000,
    );
    // The last tossup lands exactly at `end`, and the game stays live through the submit window,
    // so this is the state a spectator sees while a scorekeeper is submitting.
    const lastTick = snapshotAt(demo, new Date(end.getTime() + 1000));
    const afterAccept = snapshotAt(
      demo,
      new Date(end.getTime() + demoSchedule.acceptMinutes * 60_000 + 1000),
    );

    const live = lastTick.liveGames.find((game) => game.gameId === firstGame.id);
    const result = afterAccept.results.find((game) => game.gameId === firstGame.id);
    expect(live.tossupsRead).toBe(demoSchedule.tossupsPerGame);
    // The last live tick is the final score: the same tossups tallied the same way.
    for (const score of live.scores) {
      expect(result.scores.find((entry) => entry.teamId === score.teamId).score).toBe(score.score);
    }
  });

  it('sends the two teams that earned it to the final', () => {
    const demo = tournament();
    const beforeFinal = new Date(demo.finalStart.getTime() - 60_000);
    const state = demo.documentAt(beforeFinal);
    const standings = deriveTeamStandings(state, acceptedGameRecords(state), { phaseId: 'phase-prelim' });
    const final = state.scheduledGames.find((game) => game.id === 'game-final');
    expect([final.leftTeamId, final.rightTeamId]).toEqual([standings[0].teamId, standings[1].teamId]);
  });

  it('honours the publication settings it is given', () => {
    const demo = tournament();
    const instant = new Date(demo.firstRound.getTime() + 100 * 60_000);
    const everything = snapshotAt(demo, instant, demoSettings('maximal'));
    const directorDefaults = snapshotAt(demo, instant, demoSettings('default'));

    expect(everything.teams.every((team) => (team.players ?? []).length > 0)).toBe(true);
    expect(everything.liveGames.every((game) => game.scores !== undefined)).toBe(true);
    // Player names, player statistics and live scores are off in Director's defaults.
    expect(directorDefaults.teams.every((team) => team.players === undefined)).toBe(true);
    expect(directorDefaults.liveGames.every((game) => game.scores === undefined)).toBe(true);
  });
});

describe('the demo backend', () => {
  it('emits events whose sections rebuild the snapshot they came from', () => {
    const demo = tournament();
    // Every four minutes of tournament time, which catches score ticks, accepted results and
    // released rounds — the three kinds of change a client has to be able to apply.
    let previous = null;
    let rebuilt = null;
    let revision = 0;
    for (let minutes = 0; minutes <= 600; minutes += 4) {
      const at = new Date(demo.opensAt.getTime() + minutes * 60_000);
      const next = snapshotAt(demo, at);
      const changed = changedSections(previous, next);
      if (previous !== null && changed.length === 0) continue;
      revision += 1;
      next.revision = revision;
      if (rebuilt === null) {
        rebuilt = next;
      } else {
        rebuilt = applyEvent(rebuilt, {
          revision,
          generatedAt: at.toISOString(),
          sections: pickSections(next, changed),
        });
      }
      previous = next;
      expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(next));
    }
    expect(revision).toBeGreaterThan(20);
  });

  it('serves the QBLive routes over HTTP', async () => {
    const backend = createDemoBackend({ port: 0, host: '127.0.0.1', day: '2026-09-05', speed: 0 });
    const address = await backend.listen();
    const origin = `http://127.0.0.1:${address.port}`;
    const base = `${origin}/qblive/v1/tournaments/${backend.snapshot.publicationId}`;
    try {
      const manifest = await (await fetch(`${base}/manifest`)).json();
      expect(manifest.capabilities.stream).toBe(true);
      expect(manifest.endpoints.snapshot).toBe(
        `/qblive/v1/tournaments/${backend.snapshot.publicationId}/snapshot`,
      );

      const snapshot = await (await fetch(`${base}/snapshot`)).json();
      expect(() => parseSnapshot(snapshot)).not.toThrow();
      expect(snapshot.revision).toBe(manifest.revision);

      const page = await (await fetch(`${base}/events?after=0&limit=8`)).json();
      expect(page.resyncRequired).toBe(false);
      expect(page.currentRevision).toBe(snapshot.revision);

      // A client too far behind to catch up incrementally is told to reload instead.
      const stale = await (await fetch(`${base}/events?after=999`)).json();
      expect(stale.events).toEqual([]);

      const wrongTournament = await fetch(`${origin}/qblive/v1/tournaments/00000000000000000000/snapshot`);
      expect(wrongTournament.status).toBe(404);

      const notReadOnly = await fetch(`${base}/snapshot`, { method: 'POST' });
      expect(notReadOnly.status).toBe(405);
    } finally {
      await backend.close();
    }
  });
});
