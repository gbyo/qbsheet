/**
 * First launch.
 *
 * Scan → pick a team → optionally pick a player → done. No account, no email, no password, no
 * profile, no role picker, no tutorial. Following a team is personalization stored on this device;
 * it grants nothing and proves nothing about who is holding the phone.
 */

import { useMemo, useState } from 'react';
import type { QbliveSnapshot } from '@qbsheet/qblive-protocol';
import { playersOf, publishesPlayers } from '../state/derive';

export function FollowTeam({
  snapshot,
  onFollow,
}: {
  snapshot: QbliveSnapshot;
  onFollow: (teamId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const teams = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const sorted = [...snapshot.teams].sort((left, right) => left.name.localeCompare(right.name));
    return needle ? sorted.filter((team) => team.name.toLowerCase().includes(needle)) : sorted;
  }, [snapshot.teams, query]);

  return (
    <div className="gate">
      <h1>{snapshot.tournament.name}</h1>
      <p className="lede">Follow a team to see its schedule, results, and updates.</p>
      {snapshot.teams.length > 12 && (
        <p>
          <label className="skip-link" htmlFor="team-search">
            Search teams
          </label>
          <input
            id="team-search"
            type="search"
            placeholder="Search teams"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            style={{
              width: '100%',
              minHeight: 'var(--tap)',
              padding: '0 12px',
              font: 'inherit',
              borderRadius: 8,
              border: '1px solid var(--line-strong)',
              background: 'var(--surface-raised)',
              color: 'var(--ink)',
            }}
          />
        </p>
      )}
      <div className="rows choice-list">
        {teams.map((team) => (
          <button key={team.id} type="button" onClick={() => onFollow(team.id)}>
            <span className="row-title">{team.name}</span>
            {team.seed !== null && <span className="row-sub">Seed {team.seed}</span>}
          </button>
        ))}
        {teams.length === 0 && <p className="empty">No teams match “{query}”.</p>}
      </div>
    </div>
  );
}

/**
 * Optional player selection.
 *
 * Only offered when the tournament publishes rosters. Choosing a player highlights their rows and
 * shows their placement; it verifies nothing, unlocks nothing, and reveals nothing that was not
 * already public.
 */
export function SelectPlayer({
  snapshot,
  teamId,
  onSelect,
  onSkip,
}: {
  snapshot: QbliveSnapshot;
  teamId: string;
  onSelect: (playerId: string) => void;
  onSkip: () => void;
}) {
  const players = playersOf(snapshot, teamId);
  if (!publishesPlayers(snapshot) || players.length === 0) {
    onSkip();
    return null;
  }
  return (
    <div className="gate">
      <h1>Show my player stats</h1>
      <p className="lede">Optional. Pick a player to highlight their statistics.</p>
      <div className="rows choice-list">
        {players.map((player) => (
          <button key={player.id} type="button" onClick={() => onSelect(player.id)}>
            <span className="row-title">{player.name}</span>
          </button>
        ))}
      </div>
      <p style={{ marginTop: 16 }}>
        <button type="button" onClick={onSkip} style={{ width: '100%' }}>
          Not now
        </button>
      </p>
    </div>
  );
}

/** Shown when the link is malformed, the tournament is gone, or the backend cannot be reached. */
export function Problem({ title, detail, onRetry }: { title: string; detail: string; onRetry?: () => void }) {
  return (
    <div className="gate">
      <h1>{title}</h1>
      <p className="lede">{detail}</p>
      {onRetry && (
        <button type="button" className="primary" onClick={onRetry} style={{ width: '100%' }}>
          Try again
        </button>
      )}
    </div>
  );
}
