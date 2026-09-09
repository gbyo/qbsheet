from pathlib import Path
from textwrap import dedent


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text()
    if old not in text:
        raise SystemExit(f"{label} did not match current source")
    path.write_text(text.replace(old, new, 1))


# @qbsheet/tournament-formats: recognize the current MODAQ answer-count alias without
# rewriting the source object. rawSubmission/source continue to hold the exact input.
qbj = Path('packages/tournament-formats/src/qbj.ts')
replace_once(
    qbj,
    """    const answerType =
      resolveRef(entry.answer_type, byId) ?? (isJsonObject(entry.answer_type) ? entry.answer_type : null);
""",
    """    // Current MODAQ writes `answer`, while canonical QBJ uses `answer_type`.
    // Treat them as semantic aliases for derived aggregates only. The surrounding
    // record is never rewritten, so raw/source preservation remains byte-shape faithful.
    const answerValue = entry.answer_type ?? entry.answer;
    const answerType = resolveRef(answerValue, byId) ?? (isJsonObject(answerValue) ? answerValue : null);
""",
    'QBJ answer-count alias',
)

# Transfer parsing: expose MODAQ's numeric _round as identity metadata. It is deliberately
# not filename-derived and is weaker than a stable Match id.
parse = Path('src/director/transfers/parse.ts')
replace_once(
    parse,
    """export interface QbjIdentity {
  tournamentId?: string;
  matchId?: string;
  roundRevision?: number;
""",
    """export interface QbjIdentity {
  tournamentId?: string;
  matchId?: string;
  /** MODAQ's numeric one-game-at-a-time round hint. */
  roundNumber?: number;
  roundRevision?: number;
""",
    'QBJ identity type',
)
replace_once(
    parse,
    """    ...(text(match?.id) ? { matchId: text(match?.id) } : {}),
    ...(finite(extension?.round_revision) ? { roundRevision: finite(extension?.round_revision) } : {}),
""",
    """    ...(text(match?.id) ? { matchId: text(match?.id) } : {}),
    ...(finite(match?._round) ? { roundNumber: finite(match?._round) } : {}),
    ...(finite(extension?.round_revision) ? { roundRevision: finite(extension?.round_revision) } : {}),
""",
    'MODAQ round identity',
)

# Ingest: add explicit diagnostic vocabulary.
ingest = Path('src/director/transfers/ingest.ts')
replace_once(
    ingest,
    """  matchedByTeams: 'matched-by-teams',
  staleRoundRevision: 'stale-round-revision',
""",
    """  matchedByTeams: 'matched-by-teams',
  matchedByRoundAndTeams: 'matched-by-round-and-teams',
  ambiguousGameAssociation: 'ambiguous-game-association',
  staleRoundRevision: 'stale-round-revision',
""",
    'matching warning codes',
)
replace_once(
    ingest,
    """  unrecognizedAnswerValue: 'unrecognized-answer-value',
  lateAfterAbandon: 'late-after-abandon',
""",
    """  unrecognizedAnswerValue: 'unrecognized-answer-value',
  unsupportedAnswerCountShape: 'unsupported-answer-count-shape',
  lateAfterAbandon: 'late-after-abandon',
""",
    'answer-shape warning code',
)
replace_once(
    ingest,
    """    case ingestWarnings.matchedByTeams:
      return 'Matched by the two teams rather than by match ID.';
    case ingestWarnings.staleRoundRevision:
""",
    """    case ingestWarnings.matchedByTeams:
      return 'Matched by the unique unresolved game for these two teams rather than by match ID.';
    case ingestWarnings.matchedByRoundAndTeams:
      return 'Matched by MODAQ round number and the exact two teams rather than by match ID.';
    case ingestWarnings.ambiguousGameAssociation:
      return 'More than one scheduled game fits this result; choose the intended game before accepting it.';
    case ingestWarnings.staleRoundRevision:
""",
    'matching warning descriptions',
)
replace_once(
    ingest,
    """    case ingestWarnings.unrecognizedAnswerValue:
      return 'The file scores a point value these tournament rules do not name; points kept, detail unclassified.';
    case ingestWarnings.lateAfterAbandon:
""",
    """    case ingestWarnings.unrecognizedAnswerValue:
      return 'The file scores a point value these tournament rules do not name; points kept, detail unclassified.';
    case ingestWarnings.unsupportedAnswerCountShape:
      return 'Answer counts were present in an unsupported shape; source detail was kept but those buckets remain unclassified.';
    case ingestWarnings.lateAfterAbandon:
""",
    'answer-shape warning description',
)

# Replace answerAggregate so canonical answer_type and current MODAQ answer are peers,
# configured Director rules own bucketing, unknown values still reconcile points, and
# malformed count shapes are visible rather than silently dropped.
text = ingest.read_text()
start = text.index('function answerAggregate(')
end = text.index('\nfunction teamAggregate(', start)
answer_aggregate = dedent('''
function answerAggregate(
  counts: unknown,
  state: DirectorState,
  warnings: string[] = [],
): { superpowers: number; powers: number; gets: number; negs: number; tossupPoints: number } {
  let superpowers = 0;
  let powers = 0;
  let gets = 0;
  let negs = 0;
  let tossupPoints = 0;
  if (!Array.isArray(counts)) return { superpowers, powers, gets, negs, tossupPoints };
  const rules = state.tournament?.rules;
  for (const count of counts) {
    if (!isRecord(count)) {
      warnings.push(ingestWarnings.unsupportedAnswerCountShape);
      continue;
    }
    const number = finiteNumber(count.number) ?? 0;
    if (number === 0) continue;
    const answer = isRecord(count.answer_type)
      ? count.answer_type
      : isRecord(count.answer)
        ? count.answer
        : undefined;
    const value = answer ? finiteNumber(answer.value) : undefined;
    if (value === undefined) {
      warnings.push(ingestWarnings.unsupportedAnswerCountShape);
      continue;
    }

    // The source value always contributes to score reconciliation. Classification is
    // owned by the tournament's configured rules, not by a MODAQ-specific 15/10/-5 table.
    tossupPoints += value * number;
    if (rules?.superpowerValue !== null && value === rules?.superpowerValue) superpowers += number;
    else if (rules && value === rules.powerValue) powers += number;
    else if (rules && value === rules.tossupValue) gets += number;
    else if (rules && value === rules.negValue) negs += number;
    else warnings.push(ingestWarnings.unrecognizedAnswerValue);
  }
  return { superpowers, powers, gets, negs, tossupPoints };
}
''').lstrip()
ingest.write_text(text[:start] + answer_aggregate + text[end:])

# Missing tossups-heard is unknown, not "number of buzzes".
replace_once(
    ingest,
    """          tossupsHeard:
            finiteNumber(candidate.tossups_heard) ??
            aggregate.superpowers + aggregate.powers + aggregate.gets + aggregate.negs,
""",
    """          tossupsHeard: finiteNumber(candidate.tossups_heard) ?? null,
""",
    'safe tossups-heard fallback',
)

# Deterministic matching hierarchy: stable ID, MODAQ _round + exact teams, exact teams
# in the currently selected round, then a globally unique unresolved pair. Any ambiguous
# rematch stays unassociated for the existing Director association/review UI.
text = ingest.read_text()
start = text.index('function findScheduledGame(')
end = text.index('\n/**\n * Which revisions', start)
find_scheduled = dedent('''
type ScheduledGameMatch = {
  scheduled?: DirectorState['scheduledGames'][number];
  matchedByTeams: boolean;
  matchedByRoundAndTeams: boolean;
  ambiguousAssociation: boolean;
};

function findScheduledGame(
  state: DirectorState,
  identity: QbjIdentity,
  qbj: unknown,
): ScheduledGameMatch {
  const noMatch = (): ScheduledGameMatch => ({
    matchedByTeams: false,
    matchedByRoundAndTeams: false,
    ambiguousAssociation: false,
  });
  if (identity.matchId) {
    const direct = state.scheduledGames.find((game) => game.id === identity.matchId);
    if (direct)
      return {
        scheduled: direct,
        matchedByTeams: false,
        matchedByRoundAndTeams: false,
        ambiguousAssociation: false,
      };
    const recorded = state.games.find(
      (game) => game.rawQbj && readQbjIdentity(game.rawQbj).matchId === identity.matchId,
    );
    const scheduled = recorded
      ? state.scheduledGames.find((game) => game.id === recorded.scheduledGameId)
      : undefined;
    if (scheduled)
      return {
        scheduled,
        matchedByTeams: false,
        matchedByRoundAndTeams: false,
        ambiguousAssociation: false,
      };
  }

  const match = matchObject(qbj);
  const teamIdentities = (Array.isArray(match?.match_teams) ? match.match_teams : [])
    .map((entry) => (isRecord(entry) ? namedIdentity(entry.team) : undefined))
    .filter((entry): entry is string => Boolean(entry));
  if (teamIdentities.length !== 2) return noMatch();

  const teamIds = teamIdentities.map((candidate) => {
    const matches = state.teams.filter(
      (team) => team.id === candidate || team.displayName.toLocaleLowerCase() === candidate.toLocaleLowerCase(),
    );
    return matches.length === 1 ? matches[0]?.id : undefined;
  });
  if (teamIds.some((entry) => !entry)) return noMatch();
  const [first, second] = teamIds as [string, string];
  const pairCandidates = state.scheduledGames.filter(
    (game) =>
      game.status !== 'cancelled' &&
      ((game.leftTeamId === first && game.rightTeamId === second) ||
        (game.leftTeamId === second && game.rightTeamId === first)),
  );

  const chooseUnique = (candidates: typeof pairCandidates) => {
    const unresolved = candidates.filter((game) => game.status !== 'accepted');
    return unresolved.length === 1 ? unresolved[0] : candidates.length === 1 ? candidates[0] : undefined;
  };

  if (identity.roundNumber !== undefined) {
    const roundIds = new Set(
      state.rounds.filter((round) => round.number === identity.roundNumber).map((round) => round.id),
    );
    const roundCandidates = pairCandidates.filter((game) => roundIds.has(game.roundId));
    const scheduled = chooseUnique(roundCandidates);
    if (scheduled)
      return {
        scheduled,
        matchedByTeams: false,
        matchedByRoundAndTeams: true,
        ambiguousAssociation: false,
      };
    if (roundCandidates.length > 1)
      return {
        matchedByTeams: false,
        matchedByRoundAndTeams: false,
        ambiguousAssociation: true,
      };
  }

  const currentRoundId = state.tournament?.currentRoundId;
  if (currentRoundId) {
    const currentRoundCandidates = pairCandidates.filter((game) => game.roundId === currentRoundId);
    const scheduled = chooseUnique(currentRoundCandidates);
    if (scheduled)
      return {
        scheduled,
        matchedByTeams: false,
        matchedByRoundAndTeams: true,
        ambiguousAssociation: false,
      };
    if (currentRoundCandidates.length > 1)
      return {
        matchedByTeams: false,
        matchedByRoundAndTeams: false,
        ambiguousAssociation: true,
      };
  }

  const scheduled = chooseUnique(pairCandidates);
  if (scheduled)
    return {
      scheduled,
      matchedByTeams: true,
      matchedByRoundAndTeams: false,
      ambiguousAssociation: false,
    };
  return {
    matchedByTeams: false,
    matchedByRoundAndTeams: false,
    ambiguousAssociation: pairCandidates.length > 1,
  };
}
''').lstrip()
ingest.write_text(text[:start] + find_scheduled + text[end:])

replace_once(
    ingest,
    """  const { scheduled, matchedByTeams } = explicitScheduledGameId
    ? {
        scheduled: state.scheduledGames.find((game) => game.id === explicitScheduledGameId),
        matchedByTeams: false,
      }
    : findScheduledGame(state, identity, document.qbj);
""",
    """  const { scheduled, matchedByTeams, matchedByRoundAndTeams, ambiguousAssociation } =
    explicitScheduledGameId
      ? {
          scheduled: state.scheduledGames.find((game) => game.id === explicitScheduledGameId),
          matchedByTeams: false,
          matchedByRoundAndTeams: false,
          ambiguousAssociation: false,
        }
      : findScheduledGame(state, identity, document.qbj);
""",
    'association result destructuring',
)
replace_once(
    ingest,
    """  if (!identity.matchId) warnings.add(ingestWarnings.missingMatchIdentity);
  if (matchedByTeams) warnings.add(ingestWarnings.matchedByTeams);
  if (!scheduled) warnings.add(ingestWarnings.unknownMatch);
""",
    """  if (!identity.matchId) warnings.add(ingestWarnings.missingMatchIdentity);
  if (matchedByRoundAndTeams) warnings.add(ingestWarnings.matchedByRoundAndTeams);
  else if (matchedByTeams) warnings.add(ingestWarnings.matchedByTeams);
  if (ambiguousAssociation) warnings.add(ingestWarnings.ambiguousGameAssociation);
  if (!scheduled) warnings.add(ingestWarnings.unknownMatch);
""",
    'association warnings',
)

# Format-level regression coverage against the generated current-MODAQ fixture.
formats_test = Path('packages/tournament-formats/tests/formats.test.ts')
text = formats_test.read_text()
anchor = """  test('uses stable string player references even when display names collide', () => {
"""
if anchor not in text:
    raise SystemExit('formats test insertion point did not match current source')
modaq_format_test = dedent('''
  test('imports a current MODAQ bare Match and preserves its detailed source fields', () => {
    const raw = JSON.parse(fixture('current-modaq-match.qbj')) as JsonObject;
    const imported = importQbj(raw);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    expect(imported.value.matchOnly).toBe(true);
    const game = imported.value.tournament.games[0];
    expect(game.result?.players?.some((player) => (player.powers ?? 0) > 0)).toBe(true);
    expect(game.result?.players?.some((player) => (player.negs ?? 0) > 0)).toBe(true);
    expect(game.result?.overtimeTossupsRead).toBe(1);
    const source = game.result?.rawSubmission as Record<string, unknown>;
    expect(source._round).toBe(5);
    expect(source.packets).toBe('Packet 5');
    expect(Array.isArray(source.match_questions)).toBe(true);
    const teams = source.match_teams as Array<Record<string, unknown>>;
    expect(teams.some((team) => team.YfData !== undefined)).toBe(true);
    const firstPlayers = teams[0]?.match_players as Array<Record<string, unknown>>;
    const answerCounts = firstPlayers?.[0]?.answer_counts as Array<Record<string, unknown>>;
    expect(answerCounts.some((count) => count.answer !== undefined)).toBe(true);

    // The same current MODAQ Match remains supported when another tool wraps it in
    // the normal QBJ serialization envelope.
    const serialized = importQbj({ version: qbjSerializationVersion, objects: [raw] });
    expect(serialized.ok).toBe(true);
  });

''')
formats_test.write_text(text.replace(anchor, modaq_format_test + anchor, 1))

# Director ingest regression coverage: round-aware matching, configured score values,
# unknown TUH, detailed-source retention, malformed answer diagnostics, and batch behavior.
ingest_test = Path('src/director/transfers/ingest.test.ts')
text = ingest_test.read_text()
text = text.replace(
    "import { describe, expect, it } from 'vitest';",
    "import { readFileSync } from 'node:fs';\nimport { describe, expect, it } from 'vitest';",
    1,
)
helper_anchor = """function documentFor(qbj: unknown, overrides: Partial<IncomingDocument> = {}): IncomingDocument {
"""
if helper_anchor not in text:
    raise SystemExit('ingest helper insertion point did not match current source')
helper = dedent('''
function currentModaqFixture(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL('../../../packages/tournament-formats/tests/fixtures/current-modaq-match.qbj', import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
}

''')
text = text.replace(helper_anchor, helper + helper_anchor, 1)
insert_anchor = "\ndescribe('a batch', () => {"
if insert_anchor not in text:
    raise SystemExit('ingest MODAQ insertion point did not match current source')
modaq_ingest_tests = dedent('''

describe('current MODAQ compatibility', () => {
  it('uses _round plus exact teams and reads MODAQ answer-count aliases', () => {
    const state = directorFixture();
    const qbj = currentModaqFixture();
    const { assessment, outcome } = stage(state, qbj, { fileName: 'modaq-result.qbj' });

    expect(assessment.scheduledGameId).toBe('game-5-1');
    expect(assessment.warnings).toContain(ingestWarnings.matchedByRoundAndTeams);
    const left = assessment.playerStats.find((player) => player.playerId === 'team-1-player-1');
    expect(left?.powers).toBe(1);
    expect(left?.gets).toBe(1);
    expect(typeof left?.tossupsHeard).toBe('number');

    const submission = state.submissions.find((entry) => entry.id === outcome.submissionId);
    expect(submission?.rawSubmission).toEqual(qbj);
    const game = state.games.find((entry) => entry.id === outcome.gameId);
    expect(game?.rawQbj).toEqual(qbj);
  });

  it('classifies MODAQ answer values using Director scoring rules rather than fixed values', () => {
    const state = directorFixture();
    if (!state.tournament) throw new Error('fixture tournament missing');
    state.tournament.rules.powerValue = 20;
    const qbj = currentModaqFixture();
    const teams = qbj.match_teams as Array<Record<string, unknown>>;
    const players = teams[0]?.match_players as Array<Record<string, unknown>>;
    const counts = players[0]?.answer_counts as Array<Record<string, unknown>>;
    const power = counts.find(
      (count) => (count.answer as Record<string, unknown> | undefined)?.value === 15,
    );
    if (!power) throw new Error('generated MODAQ fixture has no power answer count');
    (power.answer as Record<string, unknown>).value = 20;

    const assessment = assessIncomingDocument(state, documentFor(qbj));
    const left = assessment.playerStats.find((player) => player.playerId === 'team-1-player-1');
    expect(left?.powers).toBe(1);
    expect(assessment.warnings).not.toContain(ingestWarnings.unrecognizedAnswerValue);
  });

  it('leaves tossups heard unknown instead of treating answer counts as questions heard', () => {
    const state = directorFixture();
    const qbj = currentModaqFixture();
    const teams = qbj.match_teams as Array<Record<string, unknown>>;
    const players = teams[0]?.match_players as Array<Record<string, unknown>>;
    delete players[0]?.tossups_heard;

    const assessment = assessIncomingDocument(state, documentFor(qbj));
    const left = assessment.playerStats.find((player) => player.playerId === 'team-1-player-1');
    expect(left?.tossupsHeard).toBeNull();
  });

  it('uses MODAQ round identity to disambiguate rematches and refuses an unscoped rematch guess', () => {
    const state = directorFixture();
    const rematch = state.scheduledGames.find((game) => game.id === 'game-6-1');
    if (!rematch || !state.tournament) throw new Error('fixture rematch missing');
    rematch.leftTeamId = 'team-1';
    rematch.rightTeamId = 'team-2';

    const qbj = currentModaqFixture();
    const roundScoped = assessIncomingDocument(state, documentFor(qbj));
    expect(roundScoped.scheduledGameId).toBe('game-5-1');

    delete qbj._round;
    state.tournament.currentRoundId = 'no-current-round';
    const ambiguous = assessIncomingDocument(
      state,
      documentFor(qbj, { digest: 'modaq-rematch-without-round' }),
    );
    expect(ambiguous.scheduledGameId).toBeUndefined();
    expect(ambiguous.warnings).toContain(ingestWarnings.ambiguousGameAssociation);
    expect(ambiguous.classification).toBe('needs-review');
  });

  it('retains team scores while diagnosing an unsupported answer-count shape', () => {
    const state = directorFixture();
    const qbj = currentModaqFixture();
    const teams = qbj.match_teams as Array<Record<string, unknown>>;
    const players = teams[0]?.match_players as Array<Record<string, unknown>>;
    players[0]!.answer_counts = [{ number: 1, result: { value: 15 } }];

    const assessment = assessIncomingDocument(state, documentFor(qbj));
    expect(assessment.scores).toHaveLength(2);
    expect(assessment.warnings).toContain(ingestWarnings.unsupportedAnswerCountShape);
  });

  it('handles current MODAQ files in the existing mixed batch summary without a source-specific queue', () => {
    const state = directorFixture();
    const first = currentModaqFixture();
    const second = structuredClone(first);
    const inputs: ImportInput[] = [
      { ok: true, document: documentFor(first, { originalPath: '/first.qbj', digest: 'first-bytes' }) },
      { ok: true, document: documentFor(second, { originalPath: '/second.qbj', digest: 'second-bytes' }) },
      {
        ok: false,
        sourceKind: 'file-picker',
        sourceLabel: 'Chosen files',
        fileName: 'bad-modaq.json',
        byteLength: 4,
        digest: 'bad-modaq',
        reason: 'The file is not valid JSON.',
      },
    ];

    const summary = importTransferDocuments(state, inputs);
    expect(summary.needsReview).toBe(1);
    expect(summary.duplicates).toBe(1);
    expect(summary.invalid).toBe(1);
    expect(state.submissions).toHaveLength(1);
  });
});
''')
ingest_test.write_text(text.replace(insert_anchor, modaq_ingest_tests + insert_anchor, 1))

# Record exactly where the sanitized fixture came from. The fixture itself is generated by
# the temporary workflow from this pinned upstream commit before these source changes are tested.
Path('packages/tournament-formats/tests/fixtures/current-modaq-match.README.md').write_text(dedent('''
# Current MODAQ QBJ fixture

`current-modaq-match.qbj` is generated by MODAQ's own `QBJ.toQBJ` implementation from a sanitized,
in-memory three-tossup game. It contains no real tournament or participant data.

Source used for this fixture:

- repository: `alopezlago/MODAQ`
- version: `1.42.1`
- commit: `78d582e1a1f0b719ea47226ae3bce2a757acd705`
- generated fields include the current `answer: { value }` answer-count shape, `_round`, packet name,
  `match_questions`, lineups, `overtime_tossups_read`, and `YfData.overTimeBuzzes`.

The fixture is intentionally checked in so QBSheet's MODAQ compatibility does not depend on the
upstream repository or network access at test time.
''').lstrip())

# Temporary patch/generation machinery must not appear in the final branch tree.
Path('scripts/patch-issue-505.py').unlink(missing_ok=True)
Path('scripts/generate-issue-505-modaq-fixture.ts').unlink(missing_ok=True)
Path('.github/workflows/patch-issue-505.yml').unlink(missing_ok=True)
