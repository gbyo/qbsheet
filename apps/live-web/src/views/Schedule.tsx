/**
 * Schedule.
 *
 * Defaults to the followed team, because that is what somebody standing in a hallway wants. The
 * whole public schedule is one tap away.
 *
 * Only released rounds reach the client at all — that filtering happens in Director's projection,
 * not here — so there is nothing on this screen to hide.
 */

import { useMemo, useState } from 'react';
import type { QbliveScheduledGame, QbliveSnapshot } from '@qbsheet/qblive-protocol';
import { gamesForTeam, opponentOf, resultFor, roomName, teamName } from '../state/derive';
import { formatTime } from '../state/format';

export function Schedule({
  snapshot,
  followedTeamId,
  now,
}: {
  snapshot: QbliveSnapshot;
  followedTeamId: string | null;
  now: Date;
}) {
  const [scope, setScope] = useState<'team' | 'all'>(followedTeamId ? 'team' : 'all');
  const zone = snapshot.tournament.timeZone;

  const games = useMemo(
    () => (scope === 'team' && followedTeamId ? gamesForTeam(snapshot, followedTeamId) : snapshot.schedule),
    [scope, followedTeamId, snapshot],
  );

  const grouped = useMemo(() => {
    // Group by round+pool so simultaneous pools do not collapse under one label.
    const bySection = new Map<string, QbliveScheduledGame[]>();
    for (const game of games) {
      const key = `${game.roundId}::${game.poolId ?? ''}`;
      const list = bySection.get(key) ?? [];
      list.push(game);
      bySection.set(key, list);
    }
    return [...bySection.entries()].sort((left, right) => {
      const leftGame = left[1][0];
      const rightGame = right[1][0];
      const leftNumber = leftGame.roundNumber ?? Number.MAX_SAFE_INTEGER;
      const rightNumber = rightGame.roundNumber ?? Number.MAX_SAFE_INTEGER;
      if (leftNumber !== rightNumber) return leftNumber - rightNumber;
      return (leftGame.poolName ?? '').localeCompare(rightGame.poolName ?? '');
    });
  }, [games]);

  function calendarDateInZone(date: Date, timeZone: string): string {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(date);
      const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
      const m = parts.find((p) => p.type === 'month')?.value ?? '00';
      const d = parts.find((p) => p.type === 'day')?.value ?? '00';
      return `${y}-${m}-${d}`;
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }

  const todayKey = calendarDateInZone(now, zone);
  const upcomingEvents = snapshot.timeline.filter((event) => {
    if (!event.scheduledStart) return false;
    const instant = new Date(event.scheduledStart);
    if (Number.isNaN(instant.getTime())) return false;
    return calendarDateInZone(instant, zone) === todayKey;
  });

  return (
    <>
      <h2 className="skip-link">Schedule</h2>
      {followedTeamId && (
        <div className="scopes" role="group" aria-label="Schedule scope">
          <button type="button" aria-pressed={scope === 'team'} onClick={() => setScope('team')}>
            {teamName(snapshot, followedTeamId)}
          </button>
          <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            All games
          </button>
        </div>
      )}

      {upcomingEvents.length > 0 && scope === 'team' && (
        <section aria-label="Tournament events">
          <h2>Today</h2>
          <div className="rows">
            {upcomingEvents.map((event) => (
              <div className="row" key={event.id}>
                <div className="row-main">
                  <div className="row-title">{event.title}</div>
                  {(event.location || event.description) && (
                    <div className="row-sub">{event.location ?? event.description}</div>
                  )}
                </div>
                <div className="row-trailing muted">{formatTime(event.scheduledStart, zone) ?? ''}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {grouped.length === 0 ? (
        <p className="empty">No games have been released yet.</p>
      ) : (
        grouped.map(([sectionKey, roundGames]) => (
          <section key={sectionKey} aria-label={roundGames[0].roundName}>
            <h2>
              {roundGames[0].roundName}
              {roundGames[0].poolName && scope === 'all' ? ` · ${roundGames[0].poolName}` : ''}
            </h2>
            <div className="rows">
              {roundGames.map((game) => (
                <ScheduleRow
                  key={game.id}
                  snapshot={snapshot}
                  game={game}
                  followedTeamId={scope === 'team' ? followedTeamId : null}
                  zone={zone}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </>
  );
}

function ScheduleRow({
  snapshot,
  game,
  followedTeamId,
  zone,
}: {
  snapshot: QbliveSnapshot;
  game: QbliveScheduledGame;
  followedTeamId: string | null;
  zone: string;
}) {
  const result = resultFor(snapshot, game.id);
  const time = formatTime(game.scheduledStart, zone);
  const room = roomName(snapshot, game.roomId);

  if (game.state === 'bye') {
    return (
      <div className="row">
        <div className="row-main">
          <div className="row-title">Bye</div>
          <div className="row-sub">{game.roundName}</div>
        </div>
      </div>
    );
  }

  const title = followedTeamId
    ? `vs ${teamName(snapshot, opponentOf(game, followedTeamId))}`
    : `${teamName(snapshot, game.teamIds[0])} · ${teamName(snapshot, game.teamIds[1])}`;

  let trailing: React.ReactNode;
  if (game.state === 'cancelled') {
    trailing = <span className="muted">Cancelled</span>;
  } else if (result) {
    const scores = followedTeamId
      ? [
          result.scores.find((score) => score.teamId === followedTeamId)?.score ?? 0,
          result.scores.find((score) => score.teamId !== followedTeamId)?.score ?? 0,
        ]
      : result.scores.map((score) => score.score);
    trailing = (
      <>
        {followedTeamId && <strong>{scores[0] > scores[1] ? 'W ' : 'L '}</strong>}
        <span className="muted">
          {scores[0]}–{scores[1]}
        </span>
      </>
    );
  } else if (game.state === 'live') {
    const live = snapshot.liveGames.find((entry) => entry.gameId === game.id);
    trailing = live?.scores ? (
      <span className="live-badge">
        {live.scores[0]?.score ?? 0}–{live.scores[1]?.score ?? 0}
      </span>
    ) : (
      <span className="live-badge">Live</span>
    );
  } else {
    // Upcoming. A time only if the tournament stated one.
    trailing = <span className="muted">{time ?? ''}</span>;
  }

  return (
    <div className="row">
      <div className="row-main">
        <div className="row-title">{title}</div>
        <div className="row-sub">{[game.roundName, room].filter(Boolean).join(' · ')}</div>
      </div>
      <div className="row-trailing">{trailing}</div>
    </div>
  );
}
