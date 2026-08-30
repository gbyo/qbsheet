/**
 * Correcting who is playing, once the game has already recorded them playing.
 *
 * # Why a name is not just a label
 *
 * `ScoreEvents` refers to a player by name, deliberately: names are what a room is given for a
 * roster, and a scorekeeper reading a scoresheet needs to see the name rather than an id. The cost of
 * that choice is that a name is load-bearing. Rename "Sam" to "Samir" by editing the roster alone and
 * the game now has a player named Samir who has heard no tossups and a player named Sam who is on no
 * roster, with every buzz still pointing at the second one. Nothing throws. The result simply
 * contains two people where there was one, which is worse than a wrong spelling: a wrong spelling is
 * fixed in the stats package in ten seconds, and a split player is a statistic nobody notices is
 * wrong.
 *
 * So a rename is a rewrite of every reference in one operation — roster, opening lineup, every buzz,
 * every zero-point answer, every lineup event, every roster addition, and the QBJ id keyed by that
 * name — computed here, applied by the caller as a single write.
 *
 * # Merging is a different operation, and it is never inferred
 *
 * Renaming "Sam" to "Samir" when the roster already has a Samir does not mean the same thing as
 * renaming them to "Samir K." It might be a duplicate the room created by hand at tossup 4 and is
 * now reconciling — in which case one player's statistics have to absorb the other's — or it might
 * be somebody typing the wrong target. Guessing costs a real player their buzzes, so this refuses
 * and says a merge is available; the caller has to ask for it explicitly.
 *
 * # What identity is preserved
 *
 * The tournament's, wherever it exists. `IQbjIdentity.playerIds` is keyed by team and player name,
 * so a rename re-keys the entry rather than dropping it, and a merge keeps the surviving player's
 * id. A locally-added player has no id, gains none here, and is reported by
 * `validateScoresheet` as needing roster synchronization exactly as it was before.
 */
import { IGameSetup, ITeamSetup } from './deriveGame';
import { ScoreEvent } from './ScoreEvents';
import { correctionNote, ICorrectionChange } from './gameCorrection';
import { LeftOrRight } from './types';

/** How `IQbjIdentity.playerIds` is keyed. Restated rather than imported: `scoring` owns no game files. */
function playerKey(teamName: string, playerName: string): string {
  return `${teamName}\u001f${playerName}`;
}

/** Longest team name accepted. The tournament server's own limit. */
export const teamNameMaxLength = 200;

export interface IIdentityCorrectionInput {
  setup: IGameSetup;
  events: readonly ScoreEvent[];
  /** QBJ player ids from the assignment, when the source carried any. */
  playerIds?: Record<string, string>;
}

export type IdentityCorrection =
  | {
      ok: true;
      setup: IGameSetup;
      events: ScoreEvent[];
      playerIds?: Record<string, string>;
      changes: ICorrectionChange[];
      summary: string;
      /** True when two displayed names became one player. Only ever when it was asked for. */
      merged: boolean;
    }
  | {
      ok: false;
      problems: string[];
      /**
       * Set when the only thing standing in the way is that the target name is already on this
       * roster, and merging the two is a coherent thing to ask for.
       */
      mergeAvailable?: boolean;
    };

function sameName(first: string, second: string): boolean {
  return first.trim().toLocaleLowerCase() === second.trim().toLocaleLowerCase();
}

/** Re-key every player id that belonged to one team name onto another. */
function rekeyTeam(
  playerIds: Record<string, string> | undefined,
  fromTeam: string,
  toTeam: string,
): Record<string, string> | undefined {
  if (!playerIds) return undefined;
  const next: Record<string, string> = {};
  const prefix = `${fromTeam}\u001f`;
  for (const [key, value] of Object.entries(playerIds)) {
    next[key.startsWith(prefix) ? playerKey(toTeam, key.slice(prefix.length)) : key] = value;
  }
  return next;
}

/**
 * Correct a team's display name.
 *
 * Events carry `left`/`right` rather than a team name, so nothing in the history has to move: this
 * is the one correction where the whole job is the definition. What does have to move is the QBJ
 * player-id map, which is keyed by team name and would otherwise stop resolving the moment the name
 * it was keyed under changed.
 *
 * The assignment's `teamIds` are untouched on purpose, and that is the point of preserving them: a
 * result with the same team id and a corrected name is the same team, spelled properly. A result
 * with a new id is a different team.
 */
export function correctTeamName(
  input: IIdentityCorrectionInput,
  side: LeftOrRight,
  proposed: string,
): IdentityCorrection {
  const name = proposed.trim();
  const current = input.setup[side].name;
  const opponent = input.setup[side === 'left' ? 'right' : 'left'].name;

  if (name === '') return { ok: false, problems: ['Enter a team name.'] };
  if (name.length > teamNameMaxLength) {
    return { ok: false, problems: [`Team names can be at most ${teamNameMaxLength} characters.`] };
  }
  if (sameName(name, opponent)) {
    // QBJ refers to a team by name inside a match. Two identically named teams in one match produce
    // a result whose own buzzes cannot be attributed, which no later correction can repair.
    return {
      ok: false,
      problems: ['Both teams would have the same name, and a result cannot tell them apart.'],
    };
  }
  if (name === current) {
    return {
      ok: true,
      setup: input.setup,
      events: input.events.slice(),
      ...(input.playerIds ? { playerIds: input.playerIds } : {}),
      changes: [],
      summary: '',
      merged: false,
    };
  }

  const setup: IGameSetup = { ...input.setup, [side]: { ...input.setup[side], name } };
  return {
    ok: true,
    setup,
    events: input.events.slice(),
    ...(input.playerIds ? { playerIds: rekeyTeam(input.playerIds, current, name) } : {}),
    changes: [{ subject: 'Team name', detail: `${current} → ${name}`, affectsRecordedScoring: false }],
    summary: correctionNote(`Team name: ${current} → ${name}`),
    merged: false,
  };
}

/** Rewrite one player's name everywhere the history refers to them. */
function renameInEvents(
  events: readonly ScoreEvent[],
  side: LeftOrRight,
  from: string,
  to: string,
  /**
   * On a merge, the duplicate's roster addition is dropped rather than renamed.
   *
   * A merge says the room wrote one person down twice. Renaming the second entry would leave the
   * result claiming that person was added to the roster mid-game — which is the very claim the merge
   * has just decided was a mistake, and which `validateScoresheet` would go on warning about.
   */
  dropRosterAdd = false,
): ScoreEvent[] {
  const kept = dropRosterAdd
    ? events.filter(
        (event) => !(event.type === 'roster-add' && event.team === side && event.playerName === from),
      )
    : events;
  return kept.map((event) => {
    if (event.type === 'tossup-buzz' && event.team === side && event.playerName === from) {
      return { ...event, playerName: to };
    }
    if (event.type === 'tossup-no-penalty' && event.team === side && event.playerName === from) {
      return { ...event, playerName: to };
    }
    if (event.type === 'roster-add' && event.team === side && event.playerName === from) {
      return { ...event, playerName: to };
    }
    if (event.type === 'procedure-exception' && event.team === side && event.playerName === from) {
      return { ...event, playerName: to };
    }
    if (event.type === 'substitution' && event.team === side && event.activePlayers.includes(from)) {
      /*
       * A merge can put the same person on the floor twice — the lineup named both "Sam" and
       * "Samir" — which is an impossible lineup rather than a lineup with a repeated name. The
       * duplicate is dropped and the position of the first mention kept, so the recorded order is
       * the one the room was looking at.
       */
      const renamed: string[] = [];
      for (const player of event.activePlayers) {
        const next = player === from ? to : player;
        if (!renamed.includes(next)) renamed.push(next);
      }
      return { ...event, activePlayers: renamed };
    }
    return event;
  });
}

/**
 * Everybody this team has, including whoever the room added during the game.
 *
 * `setup` is the roster the game started with and `roster-add` events are the rest; `deriveGame`
 * combines them for exactly this reason. Correcting a name has to work on the combined list, because
 * the name most likely to be wrong is one somebody typed into the room at tossup four.
 */
function effectiveRoster(setup: IGameSetup, side: LeftOrRight, events: readonly ScoreEvent[]): string[] {
  const names = setup[side].players.slice();
  for (const event of events) {
    if (event.type !== 'roster-add' || event.team !== side) continue;
    if (!names.includes(event.playerName)) names.push(event.playerName);
  }
  return names;
}

function renameInTeam(team: ITeamSetup, from: string, to: string, merge: boolean): ITeamSetup {
  const players: string[] = [];
  for (const player of team.players) {
    const next = player === from ? to : player;
    if (!merge || !players.includes(next)) players.push(next);
  }
  if (team.startingLineup === undefined) return { ...team, players };
  const startingLineup: string[] = [];
  for (const player of team.startingLineup) {
    const next = player === from ? to : player;
    if (!startingLineup.includes(next)) startingLineup.push(next);
  }
  return { ...team, players, startingLineup };
}

/**
 * Correct a player's name, or deliberately merge two of them into one.
 *
 * @param merge when true, a target name already on the roster is treated as the same person and the
 * two are combined. Without it, that case is refused with `mergeAvailable` set, because a merge
 * moves one player's buzzes onto another and is never something to infer from a typo.
 */
export function correctPlayerName(
  input: IIdentityCorrectionInput,
  side: LeftOrRight,
  from: string,
  proposed: string,
  options: { merge?: boolean } = {},
): IdentityCorrection {
  const to = proposed.trim();
  const team = input.setup[side];
  const roster = effectiveRoster(input.setup, side, input.events);

  if (!roster.includes(from)) {
    return { ok: false, problems: [`${from} is not on this roster.`] };
  }
  if (to === '') return { ok: false, problems: ['Enter a player name.'] };
  if (to.length > 200) return { ok: false, problems: ['Player names can be at most 200 characters.'] };
  if (to === from) {
    return {
      ok: true,
      setup: input.setup,
      events: input.events.slice(),
      ...(input.playerIds ? { playerIds: input.playerIds } : {}),
      changes: [],
      summary: '',
      merged: false,
    };
  }

  const collision = roster.find((player) => player !== from && sameName(player, to));
  const merge = options.merge === true && collision !== undefined;
  if (collision !== undefined && !merge) {
    return {
      ok: false,
      problems: [`${collision} is already on this roster.`],
      mergeAvailable: true,
    };
  }

  const targetAlreadyRostered =
    team.players.includes(to) ||
    input.events.some(
      (event) => event.type === 'roster-add' && event.team === side && event.playerName === to,
    );
  const setup: IGameSetup = { ...input.setup, [side]: renameInTeam(team, from, to, merge) };
  const events = renameInEvents(input.events, side, from, to, merge && targetAlreadyRostered);

  let playerIds = input.playerIds;
  if (playerIds) {
    const next: Record<string, string> = { ...playerIds };
    const oldKey = playerKey(team.name, from);
    const newKey = playerKey(team.name, to);
    const movedId = next[oldKey];
    delete next[oldKey];
    /*
     * On a merge the surviving player keeps their own tournament identity. The renamed one's id is
     * dropped rather than overwriting it, because the surviving name is the one the tournament's own
     * roster has and the whole point of the merge is to stop referring to the other.
     */
    if (movedId !== undefined && next[newKey] === undefined) next[newKey] = movedId;
    playerIds = next;
  }

  const changes: ICorrectionChange[] = [
    {
      subject: merge ? 'Players merged' : 'Player name',
      detail: `${from} → ${to}`,
      // A rename moves no points; a merge moves one player's buzzes onto another, and every
      // statistic derived from them changes.
      affectsRecordedScoring: merge,
    },
  ];
  if (merge) {
    changes.push({
      subject: 'Statistics',
      detail: `everything recorded for ${from} now belongs to ${to}`,
      affectsRecordedScoring: true,
    });
  }

  return {
    ok: true,
    setup,
    events,
    ...(playerIds ? { playerIds } : {}),
    changes,
    summary: merge
      ? correctionNote(`Players merged: ${from} and ${to} are one player`)
      : correctionNote(`Player name: ${from} → ${to}`),
    merged: merge,
  };
}
