/**
 * Decides which room workflow this page is.
 *
 * A page opened from a permanent room URL (`/room/<id>?token=...`, which is what the QR code encodes)
 * is told what to play by YellowFruit and never asks the scorekeeper to pick teams.
 *
 * Anything else falls back to the original workflow where the scorekeeper chooses a round and two
 * teams by hand. That is still the right answer for a tournament that hasn't configured rooms and a
 * schedule, and for a spare laptop pressed into service mid-morning, so it stays supported rather
 * than being replaced.
 */
import { useEffect, useMemo, useState } from 'react';
import { adoptRoomIdentity, getJoinRooms } from './api';
import { shouldOfferPairing } from './RoomLifecycle';
import AssignedRoomApp from './AssignedRoomApp';
import JoinRoomApp from './JoinRoomApp';
import ManualRoomApp from './ManualRoomApp';

/** What the bare server address should open, once we know which tournament this is. */
type LandingChoice = 'loading' | 'join' | 'manual';

/**
 * What someone typing the server's address into a browser gets.
 *
 * Both workflows are always reachable — `/join` and `/room/manual` are permanent — so this only
 * chooses which one appears first, and it chooses by asking what the tournament is actually doing
 * rather than by making the scorekeeper know. A tournament running browser room scoring with rooms
 * configured wants pairing; everything else, including a server that can't answer, wants manual
 * scoring, which needs no room and no code.
 */
function RoomLanding() {
  const [choice, setChoice] = useState<LandingChoice>('loading');

  useEffect(() => {
    let cancelled = false;
    getJoinRooms()
      .then((result) => {
        if (!cancelled) setChoice(shouldOfferPairing(result) ? 'join' : 'manual');
        return result;
      })
      .catch(() => {
        // Nothing to recover here: manual scoring is the workflow that works without the server
        // having told us anything, so it is the safe landing rather than an error screen.
        if (!cancelled) setChoice('manual');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (choice === 'loading') {
    return (
      <div className="room-shell">
        <p className="room-muted">Connecting to YellowFruit&hellip;</p>
      </div>
    );
  }
  return choice === 'join' ? <JoinRoomApp /> : <ManualRoomApp />;
}

export default function RoomApp() {
  const identity = useMemo(() => adoptRoomIdentity(window.location), []);

  if (window.location.pathname === '/join' || window.location.pathname === '/join/') return <JoinRoomApp />;
  if (window.location.pathname === '/room/manual' || window.location.pathname === '/room/manual/') {
    return <ManualRoomApp />;
  }

  if (identity) return <AssignedRoomApp identity={identity} />;
  if (/^\/room\/[^/]+\/?$/.test(window.location.pathname)) return <JoinRoomApp />;
  return <RoomLanding />;
}
