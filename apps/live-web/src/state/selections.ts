/**
 * Personalization invariants for Live Web, mirroring iOS `TournamentStore.restoreSelections`.
 *
 * The followed team and selected player are this device's choices, but the snapshot owns the
 * rosters — so every new snapshot (and the cached one on boot) re-validates the choices rather
 * than trusting them. A stale selection must never describe a team or player that is gone, and a
 * selected player must always belong to the followed team.
 */
import type { QbliveSnapshot } from '@qbsheet/qblive-protocol';

export interface TeamSelection {
  followedTeamId: string | null;
  selectedPlayerId: string | null;
}

export function restoreSelections(selection: TeamSelection, snapshot: QbliveSnapshot | null): TeamSelection {
  if (!snapshot) return selection;
  // A followed team that is no longer in the tournament is dropped along with its player:
  // teams do withdraw, and a page about a missing team is worse than choosing again.
  if (selection.followedTeamId && !snapshot.teams.some((team) => team.id === selection.followedTeamId)) {
    return { followedTeamId: null, selectedPlayerId: null };
  }
  // The selected player must belong to the followed team. A player that vanished from the
  // roster — or a previous team's player carried across a team switch — is cleared. When the
  // roster is unpublished there is nothing to belong to, so the selection clears too.
  if (selection.selectedPlayerId) {
    const team = snapshot.teams.find((candidate) => candidate.id === selection.followedTeamId);
    const belongs = team?.players?.some((player) => player.id === selection.selectedPlayerId);
    if (!belongs) return { ...selection, selectedPlayerId: null };
  }
  return selection;
}
