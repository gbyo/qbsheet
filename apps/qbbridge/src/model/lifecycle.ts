/**
 * Tournament lifecycle: setup → live → finished (#1016).
 *
 * Setup is the planning phase, where configuration is cheap and reversible. Going live
 * freezes nothing mechanically — rooms keep scoring — but every high-impact action moves
 * behind an explicit override that names its consequences and is audited. Finished is
 * terminal until an explicit reopen returns the tournament to setup, audited as well.
 *
 * The phase persists in localStorage, separate from the versioned BridgeState blob, so
 * introducing the lifecycle migrates nothing.
 */

export type TournamentPhase = 'setup' | 'live' | 'finished';

export type GuardedActionId =
  | 'change-relay'
  | 'forget-credential'
  | 'remove-room'
  | 'regenerate-code'
  | 'publish-late-rooms'
  | 'switch-tournament'
  | 'finish-dirty'
  | 'reopen-tournament';

export interface GuardedAction {
  id: GuardedActionId;
  label: string;
  /** Why this is dangerous right now; the override dialog shows it verbatim. */
  consequences: string;
}

const lifecycleStorageKey = 'qbbridge.lifecycle.v1';

function guardLabels(id: GuardedActionId, subject: string | null): { label: string; base: string } {
  const what = subject ? ` for ${subject}` : '';
  switch (id) {
    case 'change-relay':
      return {
        label: `Change relay${what}`,
        base: 'Rooms hold pairing codes and assignments for the current relay. Changing it mid-tournament strands every paired Scorer until the new relay is published.',
      };
    case 'forget-credential':
      return {
        label: `Forget relay credential${what}`,
        base: 'The setup token is already consumed, so the same relay cannot be claimed again. Forgetting locks this machine out of publishing and result collection.',
      };
    case 'remove-room':
      return {
        label: `Remove room${what}`,
        base: 'A room removed while live keeps its relay identity as a tombstone until the next publish. Scorers holding its assignment keep scoring into a game nobody planned.',
      };
    case 'regenerate-code':
      return {
        label: `Regenerate pairing code${what}`,
        base: 'The current code stops working as soon as the room is published. Scorers paired with the old code are stranded until they re-pair.',
      };
    case 'publish-late-rooms':
      return {
        label: `Publish never-published rooms${what}`,
        base: 'These rooms joined after go-live, so their assignments and pairing codes were never reviewed. Publishing hands their Scorers the official record of play mid-tournament.',
      };
    case 'switch-tournament':
      return {
        label: `Switch tournament file${what}`,
        base: 'Switching files starts a new tournament setup. Live control state — relay position, plans, collected results — does not carry over.',
      };
    case 'finish-dirty':
      return {
        label: 'Finish with unresolved items',
        base: 'Finishing declares the tournament closed. Unresolved items stay unresolved; they are not fixed by closing.',
      };
    case 'reopen-tournament':
      return {
        label: 'Reopen finished tournament',
        base: 'Reopening returns a closed tournament to setup. Only do this to correct a premature finish.',
      };
  }
}

/** Describe a guarded action for the override dialog. Pure; the hook decides when to ask. */
export function describeGuard(action: GuardedActionId, subject: string | null = null): GuardedAction {
  const { label, base } = guardLabels(action, subject);
  return { id: action, label, consequences: base };
}

/** Setup is the only phase where high-impact actions run without an explicit override. */
export function requiresOverride(phase: TournamentPhase, _action: GuardedActionId): boolean {
  return phase !== 'setup';
}

export function canGoLive(phase: TournamentPhase): boolean {
  return phase === 'setup';
}

export function canFinish(phase: TournamentPhase): boolean {
  return phase === 'live';
}

export function canReopen(phase: TournamentPhase): boolean {
  return phase === 'finished';
}

/** Read the persisted phase. Anything unrecognized reads as setup, never a crash. */
export function loadTournamentPhase(): TournamentPhase {
  try {
    const raw = localStorage.getItem(lifecycleStorageKey);
    if (raw === 'live' || raw === 'finished') return raw;
    return 'setup';
  } catch {
    return 'setup';
  }
}

export function saveTournamentPhase(phase: TournamentPhase): void {
  try {
    localStorage.setItem(lifecycleStorageKey, phase);
  } catch {
    // Diagnostics persistence must never break the run it records.
  }
}
