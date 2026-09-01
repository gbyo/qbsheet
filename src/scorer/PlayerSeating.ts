/**
 * What order the players are in on screen, and what number each of them is.
 *
 * # Why this is not part of the game
 *
 * A scorekeeper does not watch names, they watch a table. Somebody two seats to the left buzzes and
 * the hand goes to whichever row that person is in, and if the rows are in registration order and
 * the table is not, every buzz costs a read. So the order has to be adjustable — and it must be
 * adjustable without touching the scoresheet.
 *
 * That is the whole reason this is a separate store rather than a reordering of `activePlayers`
 * inside a substitution event. Substitutions are scoring history: they decide who heard which
 * tossup, they are validated, they are exported, and they are what a director sees when they ask
 * what happened. Rearranging the seating is none of those things, and writing a substitution that
 * changed nobody's lineup in order to record it would put a lie in the history of every game whose
 * scorekeeper happened to like a different order.
 *
 * So: local to the device, keyed by the game, and read by nothing except the view. Nothing here
 * reaches QBJ, the outbox, `deriveGame`, or tossups heard.
 *
 * # Seat numbers
 *
 * The number beside a name is its position among the players currently on the floor, which is what
 * a paper scoresheet's columns are. It is deliberately positional rather than an identity: a
 * substitute takes the seat of the player they came on for (see `takeSeat`), so the room's fourth
 * column stays the room's fourth column all game.
 */
import { LeftOrRight } from '../scoring/types';

/** Bumped when the stored shape changes. An unrecognized version is treated as no preference. */
export const playerSeatingVersion = 1;

/** A preferred order of roster names, per side. Names not listed keep their roster order, at the end. */
export type PlayerSeating = Record<LeftOrRight, string[]>;

/**
 * How stale a seating preference may be and still be applied.
 *
 * The same day-and-a-half window `GameSession` uses, and for the same reason: nothing calls a
 * cleanup, so the age check is what stops a Chromebook accumulating a row per game it has ever
 * scored. A preference this old belongs to a tournament that finished.
 */
export const playerSeatingMaxAgeMs = 36 * 60 * 60 * 1000;

interface ISeatingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): ISeatingStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function storageKey(gameKey: string): string {
  return `yellowfruit.room.seating.v${playerSeatingVersion}.${encodeURIComponent(gameKey)}`;
}

export function emptySeating(): PlayerSeating {
  return { left: [], right: [] };
}

function validNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value.filter((name): name is string => typeof name === 'string' && name.trim() !== '');
  // A duplicated name would give one player two seats, so the first mention wins.
  return Array.from(new Set(names));
}

export function loadSeating(
  gameKey: string,
  now: Date = new Date(),
  storage: ISeatingStorage | null = browserStorage(),
): PlayerSeating {
  if (!storage || gameKey === '') return emptySeating();
  try {
    const raw = storage.getItem(storageKey(gameKey));
    if (!raw) return emptySeating();
    const parsed = JSON.parse(raw) as {
      version?: number;
      updatedAt?: unknown;
      left?: unknown;
      right?: unknown;
    };
    if (parsed?.version !== playerSeatingVersion) return emptySeating();
    const updated = typeof parsed.updatedAt === 'string' ? new Date(parsed.updatedAt).getTime() : NaN;
    if (!Number.isFinite(updated)) return emptySeating();
    const age = now.getTime() - updated;
    if (age < 0 || age > playerSeatingMaxAgeMs) return emptySeating();
    return { left: validNames(parsed.left), right: validNames(parsed.right) };
  } catch {
    // A seating preference is the least important thing on this device. Losing it costs a
    // rearrangement; refusing to render the game because of it would cost the game.
    return emptySeating();
  }
}

export function saveSeating(
  gameKey: string,
  seating: PlayerSeating,
  now: Date = new Date(),
  storage: ISeatingStorage | null = browserStorage(),
): boolean {
  if (!storage || gameKey === '') return false;
  try {
    storage.setItem(
      storageKey(gameKey),
      JSON.stringify({ version: playerSeatingVersion, updatedAt: now.toISOString(), ...seating }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearSeating(gameKey: string, storage: ISeatingStorage | null = browserStorage()): void {
  try {
    storage?.removeItem(storageKey(gameKey));
  } catch {
    // Nothing depends on this being gone.
  }
}

/**
 * Put a list of players into the order the room asked for.
 *
 * Anything the preference does not mention keeps its original order and goes after everything it
 * does — so a player added mid-game appears at the end rather than somewhere arbitrary, and a
 * preference left over from a roster that has since changed degrades to "no preference" one name at
 * a time instead of all at once.
 */
export function orderBySeating<T>(
  items: readonly T[],
  preferred: readonly string[],
  nameOf: (item: T) => string,
): T[] {
  const rank = new Map(preferred.map((name, index) => [name, index]));
  return items
    .map((item, index) => ({ item, index, rank: rank.get(nameOf(item)) ?? Infinity }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.item);
}

/**
 * Move one name one place earlier or later, among the names given.
 *
 * The move is expressed against the *visible* list rather than against the stored preference,
 * because the preference may not mention every player and "one place later" has to mean one place
 * later on screen. The result is a complete order for that list, which is what gets stored.
 */
export function moveWithin(visibleNames: readonly string[], name: string, direction: -1 | 1): string[] {
  const order = visibleNames.slice();
  const from = order.indexOf(name);
  if (from < 0) return order;
  const to = from + direction;
  if (to < 0 || to >= order.length) return order;
  [order[from], order[to]] = [order[to], order[from]];
  return order;
}

/**
 * Merge a reordering of some players back into the full preference for that side.
 *
 * Only the names in `reordered` are repositioned; everybody else keeps their place relative to the
 * roster. This is what lets the playing rows be rearranged without disturbing the bench.
 */
export function applyOrder(
  preferred: readonly string[],
  rosterNames: readonly string[],
  reordered: readonly string[],
): string[] {
  const moved = new Set(reordered);
  // Start from the order the room currently sees, so unmentioned names keep their relative places.
  const base = orderBySeating(rosterNames, preferred, (name) => name);
  const remaining = reordered.slice();
  return base.map((name) => (moved.has(name) ? (remaining.shift() as string) : name));
}

/**
 * Give the incoming player the seat the outgoing player was in.
 *
 * The expected behaviour when a coach says "eleven for four": the new player sits down where the
 * old one stood up, and the room's columns do not shuffle in the middle of a game.
 */
export function takeSeat(
  preferred: readonly string[],
  rosterNames: readonly string[],
  outgoing: string,
  incoming: string,
): string[] {
  const base = orderBySeating(rosterNames, preferred, (name) => name).filter((name) => name !== incoming);
  const seat = base.indexOf(outgoing);
  if (seat < 0) return base.concat(incoming);
  base.splice(seat, 0, incoming);
  return base;
}

/**
 * Correct a name without moving the person it belongs to.
 *
 * The preference is keyed by name, which is what makes a name correction dangerous to it: rewriting
 * the roster and leaving this alone would make the corrected player somebody the preference has never
 * heard of, and `orderBySeating` puts those at the end. A scorekeeper who fixed a spelling would
 * watch the third seat move to the fourth.
 *
 * A merge is the case where the corrected name is already seated — two rows the room created by hand
 * being reconciled into one person. The earlier of the two seats survives, because that is the seat
 * that has been in that position for longer, and because a preference must never list one name twice.
 */
export function renameSeatPlayer(preferred: readonly string[], from: string, to: string): string[] {
  const seat = preferred.indexOf(from);
  // Nobody has arranged this side, or this player was never mentioned. Nothing to preserve.
  if (seat < 0) return preferred.slice();
  const renamed = preferred.slice();
  renamed[seat] = to;
  // The Set keeps the first mention, which is the earlier seat of the two in a merge.
  return Array.from(new Set(renamed));
}

/** What a lineup change did to the seats, and the seat order it leaves behind. */
export interface IReseatResult {
  /** The players on the floor afterwards, in the order the room should now see them. */
  seats: string[];
  /** How many seats were emptied by the change. Two or more is a bulk change, not a substitution. */
  vacated: number;
}

/**
 * Keep as much of the table as the lineup change left standing.
 *
 * A one-for-one substitution already has an answer — `takeSeat`, called at the moment the room says
 * who came on for whom. A bulk change does not: the event stores the complete lineup and deliberately
 * says nothing about which incoming player sat down in which chair, because a physical seat is not
 * scoring history and putting one in a substitution event would be inventing a fact.
 *
 * So the seats are worked out from what is left. Everybody still playing keeps the seat they were in;
 * the seats their departing team-mates left are filled, in order, by the arrivals in the order the
 * lineup event lists them. That is deterministic, it preserves the arrangement the room built, and it
 * is a guess about two names rather than about four — which is why the caller says so out loud rather
 * than presenting it as fact.
 */
export function reseatLineup(
  preferred: readonly string[],
  previousActive: readonly string[],
  nextActive: readonly string[],
): IReseatResult {
  const before = orderBySeating(previousActive, preferred, (name) => name);
  const staying = new Set(nextActive);
  const arriving = nextActive.filter((name) => !previousActive.includes(name));
  const seats: string[] = [];
  let vacated = 0;
  let next = 0;
  for (const occupant of before) {
    if (staying.has(occupant)) {
      seats.push(occupant);
      continue;
    }
    vacated += 1;
    // An emptied seat takes the next arrival, or closes up when there is nobody left to take it.
    if (next < arriving.length) seats.push(arriving[next++]);
  }
  // More arrivals than departures: a team that grew rather than swapped. They go on the end, which is
  // where a player who has never been seated goes anyway.
  seats.push(...arriving.slice(next));
  return { seats, vacated };
}
