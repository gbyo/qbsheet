/**
 * Home: one team's day.
 *
 * The question this tab answers is "where does my team go next, and how are we doing" — so the
 * largest thing on the screen is the next actual event, and nothing on it is invented. When the
 * tournament has not stated a time, no time appears.
 */

import type { QbliveSnapshot } from '@qbsheet/qblive-protocol';
import {
  announcementsForTeam,
  liveGameForTeam,
  nextEventForTeam,
  opponentOf,
  placementForPlayer,
  placementForTeam,
  recentResultsForTeam,
  roomDirections,
  roomName,
  teamName,
} from '../state/derive';
import { formatDay, formatTime } from '../state/format';

export function Home({
  snapshot,
  followedTeamId,
  selectedPlayerId,
  now,
}: {
  snapshot: QbliveSnapshot;
  followedTeamId: string;
  selectedPlayerId: string | null;
  now: Date;
}) {
  const zone = snapshot.tournament.timeZone;
  const next = nextEventForTeam(snapshot, followedTeamId, now);
  const live = liveGameForTeam(snapshot, followedTeamId);
  const placement = placementForTeam(snapshot, followedTeamId);
  const playerPlacement = selectedPlayerId ? placementForPlayer(snapshot, selectedPlayerId) : null;
  const recent = recentResultsForTeam(snapshot, followedTeamId, 4);
  const announcements = announcementsForTeam(snapshot, followedTeamId, now);
  const topAnnouncement =
    announcements.find((entry) => entry.severity === 'urgent') ??
    announcements.find((entry) => entry.severity === 'important') ??
    null;

  return (
    <>
      <h2 className="skip-link">Home</h2>

      {topAnnouncement && (
        <section>
          <div className="card announcement" data-severity={topAnnouncement.severity}>
            <h3>{topAnnouncement.title}</h3>
            <p>{topAnnouncement.body}</p>
          </div>
        </section>
      )}

      <section aria-label="Next">
        <div className="card followed">
          {live ? (
            <>
              <div className="next-kicker">
                <span className="live-badge">Now playing</span>
              </div>
              <LiveScore snapshot={snapshot} teamId={followedTeamId} />
              <div className="next-detail">
                {roomName(snapshot, live.roomId) && <span>{roomName(snapshot, live.roomId)}</span>}
                {live.tossupsRead !== undefined && <span>TU {live.tossupsRead}</span>}
              </div>
            </>
          ) : next ? (
            <NextEvent snapshot={snapshot} teamId={followedTeamId} next={next} zone={zone} />
          ) : (
            <>
              <div className="next-kicker">Next</div>
              <p className="next-title">Nothing scheduled</p>
              <p className="muted">
                {snapshot.tournament.status === 'complete'
                  ? 'The tournament is over.'
                  : 'Nothing further has been released yet.'}
              </p>
            </>
          )}
        </div>
      </section>

      {(placement || playerPlacement) && (
        <section aria-label="Placement">
          <h2>Placement</h2>
          <div className="rows">
            {placement && (
              <div className="row">
                <div className="row-main">
                  <div className="row-title">{teamName(snapshot, followedTeamId)}</div>
                  <div className="row-sub">{placement.table.scopeLabel ?? 'Overall'}</div>
                </div>
                <div className="row-trailing">
                  <strong>
                    {placement.rank}
                    <span className="muted"> of {placement.of}</span>
                  </strong>
                </div>
              </div>
            )}
            {playerPlacement && selectedPlayerId && (
              <div className="row">
                <div className="row-main">
                  <div className="row-title">{playerNameOf(snapshot, selectedPlayerId)}</div>
                  <div className="row-sub">{playerPlacement.table.title}</div>
                </div>
                <div className="row-trailing">
                  <strong>
                    {playerPlacement.rank}
                    <span className="muted"> of {playerPlacement.of}</span>
                  </strong>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section aria-label="Recent results">
          <h2>Recent results</h2>
          <div className="rows">
            {recent.map((result) => {
              const game = snapshot.schedule.find((entry) => entry.id === result.gameId);
              const ours = result.scores.find((score) => score.teamId === followedTeamId);
              const theirs = result.scores.find((score) => score.teamId !== followedTeamId);
              const won = (ours?.score ?? 0) > (theirs?.score ?? 0);
              return (
                <div className="row" key={result.gameId}>
                  <div className="row-main">
                    <div className="row-title">{teamName(snapshot, theirs?.teamId)}</div>
                    <div className="row-sub">{game?.roundName ?? ''}</div>
                  </div>
                  <div className="row-trailing">
                    <strong>{won ? 'W' : 'L'}</strong>{' '}
                    <span className="muted">
                      {ours?.score ?? 0}–{theirs?.score ?? 0}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <p className="faint">
        {snapshot.tournament.name}
        {snapshot.tournament.venue ? ` · ${snapshot.tournament.venue}` : ''}
        {formatDay(snapshot.generatedAt, zone) ? ` · ${formatDay(snapshot.generatedAt, zone)}` : ''}
      </p>
    </>
  );
}

function NextEvent({
  snapshot,
  teamId,
  next,
  zone,
}: {
  snapshot: QbliveSnapshot;
  teamId: string;
  next: NonNullable<ReturnType<typeof nextEventForTeam>>;
  zone: string;
}) {
  const time = formatTime(next.scheduledStart, zone);
  if (next.kind === 'event' && next.event) {
    return (
      <>
        <div className="next-kicker">Next</div>
        <p className="next-title">{next.event.title}</p>
        <div className="next-detail">
          {time && <span>{time}</span>}
          {next.event.location && <span>{next.event.location}</span>}
          {roomName(snapshot, next.event.roomId) && <span>{roomName(snapshot, next.event.roomId)}</span>}
        </div>
        {next.event.description && <p className="directions">{next.event.description}</p>}
      </>
    );
  }
  const game = next.game!;
  const opponent = opponentOf(game, teamId);
  const directions = roomDirections(snapshot, game.roomId);
  return (
    <>
      <div className="next-kicker">Next</div>
      <p className="next-title">{game.state === 'bye' ? 'Bye' : `vs ${teamName(snapshot, opponent)}`}</p>
      <div className="next-detail">
        <span>{game.roundName}</span>
        {/* No time is rendered when the tournament has not stated one. Never an estimate. */}
        {time && <span>{time}</span>}
        {roomName(snapshot, game.roomId) && <span>{roomName(snapshot, game.roomId)}</span>}
      </div>
      {directions && <p className="directions">{directions}</p>}
    </>
  );
}

function LiveScore({ snapshot, teamId }: { snapshot: QbliveSnapshot; teamId: string }) {
  const live = liveGameForTeam(snapshot, teamId);
  if (!live) return null;
  const opponentId = live.teamIds.find((id) => id !== teamId) ?? null;
  if (!live.scores) {
    // The tournament publishes that a game is happening but not the score. Say exactly that.
    return (
      <>
        <p className="next-title">vs {teamName(snapshot, opponentId)}</p>
        <p className="muted">Game in progress</p>
      </>
    );
  }
  const ours = live.scores.find((score) => score.teamId === teamId)?.score ?? 0;
  const theirs = live.scores.find((score) => score.teamId === opponentId)?.score ?? 0;
  return (
    <div className="scoreline">
      <span className={`team ${ours >= theirs ? 'leading' : ''}`.trim()}>{teamName(snapshot, teamId)}</span>
      <span className="points">{ours}</span>
      <span className={`team ${theirs > ours ? 'leading' : ''}`.trim()}>
        {teamName(snapshot, opponentId)}
      </span>
      <span className="points">{theirs}</span>
    </div>
  );
}

function playerNameOf(snapshot: QbliveSnapshot, playerId: string): string {
  for (const team of snapshot.teams) {
    const player = team.players?.find((entry) => entry.id === playerId);
    if (player) return player.name;
  }
  return 'Player';
}
