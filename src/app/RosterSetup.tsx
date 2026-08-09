/**
 * Typing in the players a QBJ named a team but not a roster for.
 *
 * # Only what is missing
 *
 * A document that lists one side's players and not the other's asks one question. Re-presenting a
 * roster the file already got right is how a scorekeeper ends up retyping correct names under time
 * pressure, and every retyped name is a chance to spell it differently from the one tournament
 * control has.
 *
 * # One name per line
 *
 * A textarea, not a row of inputs with an "add player" button. A scorekeeper with a paper roster in
 * front of them types six names and presses Tab; anything that makes them click between each one is
 * slower for no gain. It also means rosters of different sizes need no interface at all — the number
 * of players is however many lines there are.
 *
 * # This form decides nothing
 *
 * The names go through `defineGame`'s `overrides.rosters`, and the trimming, the blank-line
 * dropping and the duplicate refusal all happen there, next to the rules a roster read from a file
 * gets. What is here is the same judgement shown early, so a scorekeeper sees the problem while
 * looking at the box rather than after submitting. If the two ever disagree, the parser is right.
 */
import { useMemo, useState } from 'react';
import { IRosterPlayer, playerNameMaxLength } from '../game/Roster';

/** Split a textarea into candidate names. Not the authority; see the note above. */
export function readRosterLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** What is wrong with what has been typed so far, in words a scorekeeper can act on. */
export function rosterLineProblems(names: string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (name.length > playerNameMaxLength) {
      problems.push(`"${name.slice(0, 20)}…" is too long to be a name.`);
      continue;
    }
    if (seen.has(name)) problems.push(`"${name}" is listed more than once.`);
    seen.add(name);
  }
  return problems;
}

export default function RosterSetup(props: {
  /** The teams that need a roster, by the name the document gave them. */
  teams: string[];
  /** Why the scoresheet is asking, in the parser's own words. */
  reason: string[];
  onUse: (rosters: Record<string, IRosterPlayer[]>) => void;
  onCancel: () => void;
}) {
  const { teams, reason, onUse, onCancel } = props;
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const parsed = useMemo(
    () => teams.map((team) => ({ team, names: readRosterLines(entries[team] ?? '') })),
    [teams, entries],
  );

  const problems = useMemo(() => {
    const found: string[] = [];
    for (const { team, names } of parsed) {
      if (names.length === 0) found.push(`${team} needs at least one player.`);
      found.push(...rosterLineProblems(names).map((problem) => `${team}: ${problem}`));
    }
    return found;
  }, [parsed]);

  const submit = () => {
    setSubmitted(true);
    if (problems.length > 0) return;
    const rosters: Record<string, IRosterPlayer[]> = {};
    for (const { team, names } of parsed) rosters[team] = names.map((name) => ({ name }));
    onUse(rosters);
  };

  return (
    <section className="roster-setup">
      <h2 className="roster-setup-title">{teams.length === 1 ? 'Players needed' : 'Rosters needed'}</h2>
      {reason.map((line) => (
        <p key={line} className="roster-setup-reason">
          {line}
        </p>
      ))}
      <p className="roster-setup-reason">One player per line. Substitutes can be added during the game.</p>

      <div className="roster-setup-teams">
        {teams.map((team) => (
          <label key={team} className="roster-setup-team" htmlFor={`roster-${team}`}>
            <span className="roster-setup-team-name">{team}</span>
            <textarea
              id={`roster-${team}`}
              // The visible label also carries a live player count, so the accessible name is set
              // explicitly to the team on its own.
              aria-label={team}
              rows={6}
              spellCheck={false}
              value={entries[team] ?? ''}
              onChange={(event) => setEntries((current) => ({ ...current, [team]: event.target.value }))}
            />
            <span className="roster-setup-count">
              {parsed.find((entry) => entry.team === team)?.names.length ?? 0} players
            </span>
          </label>
        ))}
      </div>

      {submitted && problems.length > 0 && (
        <div className="shell-errors" role="alert">
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="roster-setup-actions">
        <button type="button" className="shell-button is-primary" onClick={submit}>
          Use these players
        </button>
        <button type="button" className="shell-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
