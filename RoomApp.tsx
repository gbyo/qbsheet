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
import { useMemo } from 'react';
import { adoptRoomIdentity } from './api';
import AssignedRoomApp from './AssignedRoomApp';
import JoinRoomApp from './JoinRoomApp';
import ManualRoomApp from './ManualRoomApp';

export default function RoomApp() {
  const identity = useMemo(() => adoptRoomIdentity(window.location), []);

  if (window.location.pathname === '/join' || window.location.pathname === '/join/') return <JoinRoomApp />;
  if (window.location.pathname === '/room/manual' || window.location.pathname === '/room/manual/') {
    return <ManualRoomApp />;
  }

  if (identity) return <AssignedRoomApp identity={identity} />;
  if (/^\/room\/[^/]+\/?$/.test(window.location.pathname)) return <JoinRoomApp />;
  return <ManualRoomApp />;
}
