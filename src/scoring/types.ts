/**
 * The two sides of a scoresheet.
 *
 * A game has a left column and a right column and nothing else, on paper and here. Everything in the
 * engine that has to say "which team" says it with this, which is why a team's identity in an event
 * is a side rather than a name: names are data the scorekeeper can correct mid-game, and an event
 * history that referred to teams by name would change meaning when somebody fixed a spelling.
 *
 * Extracted from YellowFruit's `renderer/Utils/UtilTypes`, which is not otherwise browser-safe.
 */
export type LeftOrRight = 'left' | 'right';
