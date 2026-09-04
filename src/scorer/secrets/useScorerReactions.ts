import { useCallback, useEffect, useRef, useState } from 'react';
import { IDerivedGame, IDerivedTeam } from '../../scoring/deriveGame';
import { ScoreEvent } from '../../scoring/ScoreEvents';
import { IScorekeeperFormat } from '../../scoring/ScorekeeperFormat';
import { ScoreReaction } from './ScoreReaction';
import { powerCorrect } from '../tossupRulings';

export function isPowerResult(event: ScoreEvent, format: IScorekeeperFormat): boolean {
  if (event.type !== 'tossup-buzz') return false;
  const answer = format.answerTypes[event.answerTypeIndex];
  return answer?.value === 15 && powerCorrect(format)?.index === event.answerTypeIndex;
}

/** Presentation receives accepted events; it has no engine mutators or persistent score counters. */
export default function useScorerReactions(
  game: IDerivedGame,
  journal: readonly ScoreEvent[],
  format: IScorekeeperFormat,
) {
  const [commit, setCommit] = useState<{
    added: ScoreEvent[];
    before: { left: number; right: number };
  } | null>(null);
  const lastAction = useRef(0);
  const undoCount = useRef(0);
  const history = useRef<{ kind: 'undo' | 'redo'; at: number }[]>([]);
  const lastJoke = useRef(-Infinity);
  const accepted = useCallback(
    (added: ScoreEvent[]) => {
      lastAction.current = Date.now();
      setCommit({ added, before: { left: game.left.points, right: game.right.points } });
    },
    [game.left.points, game.right.points],
  );
  useEffect(() => {
    if (!commit) return;
    const timer = setTimeout(() => setCommit(null), 650);
    return () => clearTimeout(timer);
  }, [commit]);
  const historyMessage = useCallback((kind: 'undo' | 'redo') => {
    setCommit(null);
    const now = Date.now();
    const prior = history.current.filter((entry) => now - entry.at <= 8000);
    const alternating = prior.length > 0 && prior[prior.length - 1].kind !== kind;
    history.current = [...(alternating ? prior : []), { kind, at: now }];
    if (now - lastJoke.current < 120000) return '';
    if (history.current.length >= 6) {
      lastJoke.current = now;
      history.current = [];
      return 'Are we sure this time?';
    }
    if (kind === 'undo' && now - lastAction.current < 1600 && ++undoCount.current % 4 === 0) {
      lastJoke.current = now;
      return 'Nothing happened.';
    }
    return '';
  }, []);
  const reactions = new Map<IDerivedTeam, ScoreReaction>();
  // Removal, replacement, another action, and restore invalidate the decoration immediately.
  const live =
    commit &&
    commit.added.every((event) => journal.includes(event)) &&
    journal.at(-1) === commit.added.at(-1);
  if (live) {
    const token = commit.added.map((event) => event.id).join(':');
    const tie = game.left.points === game.right.points && commit.before.left !== commit.before.right;
    for (const side of ['left', 'right'] as const) {
      const team = game[side];
      const power = commit.added.some(
        (event) => event.type === 'tossup-buzz' && event.team === side && isPowerResult(event, format),
      );
      const milestone = team.points > 0 && team.points % 100 === 0 && team.points !== commit.before[side];
      if (power || milestone || tie) reactions.set(team, { token, power, milestone, tie });
    }
  }
  return { accepted, historyMessage, reactions };
}
