/**
 * Resource Center export preflight (issue #764, epic #760).
 *
 * "Ready for the Quizbowl Resource Center" must be a validated state, not merely a
 * successful file-generation state. This module validates a generated
 * {@link ResourceCenterReportArtifact} before Director presents it as ready, separating
 * diagnostics into blocking errors (upload must not proceed) and warnings (operator
 * judgment: partial detail, richer-than-legacy statistics, SQBS-companion limits).
 *
 * Two layers, matching workstreams C and D of #764:
 *
 * - Structural checks run on the artifact alone: every required report role present
 *   exactly once, one shared filename prefix, one valid HTML document per report with a
 *   declared encoding, tournament identity and scope present, internal links resolving
 *   to files in the set, and no scripts or remote/local asset dependencies the
 *   uploader cannot see.
 * - Cross-report invariants run when the canonical snapshot is supplied. They
 *   reconcile the rendered set against the snapshot's own rows — standings W/L/T,
 *   games played, and points for/against derived from the accepted games; tossup
 *   counts reconciled with known game lines (unknown stays unknown, never zero);
 *   every accepted game present in the scoreboard exactly once; rates withheld where
 *   denominators are unknown; the stat key describing exactly the emitted columns.
 *   These checks reuse the snapshot's canonical rows and the shared report helpers
 *   (`reportGameAnchor`, `reportPresentationOf`); they never re-derive ranks,
 *   percentages, or sorted orders, so there is no shadow standings engine here.
 *
 * Multi-phase note: no combined phase+overall exporter exists yet, so there is no
 * combined-scope invariant to check. The per-game scoreboard coverage check below
 * covers single-phase sets; a combined-report invariant lands with that exporter.
 */

import { reportEscape, reportGameAnchor } from './reportHtml.js';
import { reportPresentationOf } from './reportPresentation.js';
import {
  resourceCenterAllKinds,
  resourceCenterRequiredKinds,
  resourceCenterSuffixes,
  type ResourceCenterReportArtifact,
  type ResourceCenterReportFile,
  type ResourceCenterReportKind,
} from './resourceCenterReport.js';
import type { StatsSnapshot } from './stats.js';
import type { FormatError, FormatWarning } from './types.js';

/**
 * Structural preflight status for the Resource Center renderer. The live-upload
 * half of #764 is a manual operator step (see `docs/RESOURCE_CENTER_SMOKE_TEST.md`),
 * so this stays `false` until a real upload succeeds and this date advances.
 */
export const resourceCenterCompatibility = {
  /** `false` until the manual smoke test in docs/RESOURCE_CENTER_SMOKE_TEST.md succeeds. */
  liveUploadVerified: false,
  /** Date the structural contract below was last exercised (`YYYY-MM-DD`). */
  structuralPreflightDate: '2026-09-10',
  smokeTestDoc: 'docs/RESOURCE_CENTER_SMOKE_TEST.md',
} as const;

export interface ResourceCenterPreflight {
  /** True when no blocking diagnostic fired. Warnings never flip this. */
  ok: boolean;
  /** Upload/download must not proceed until every blocking diagnostic is resolved. */
  blocking: FormatError[];
  /** Operator judgment: partial detail, richer-than-legacy stats, companion limits. */
  warnings: FormatWarning[];
}

function blocking(code: string, path: string, message: string): FormatError {
  return { code, path, message };
}

function warn(code: string, path: string, message: string): FormatWarning {
  return { code, path, message };
}

function fileByKind(
  artifact: ResourceCenterReportArtifact,
): Map<ResourceCenterReportKind, ResourceCenterReportFile[]> {
  const grouped = new Map<ResourceCenterReportKind, ResourceCenterReportFile[]>();
  for (const file of artifact.files) {
    const list = grouped.get(file.kind) ?? [];
    list.push(file);
    grouped.set(file.kind, list);
  }
  return grouped;
}

/** Relative `.html` link targets inside one file (external URLs excluded). */
function localHtmlTargets(content: string): Array<{ target: string; anchor: string | null }> {
  const found: Array<{ target: string; anchor: string | null }> = [];
  const pattern = /(?:href|src)="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const raw = match[1];
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith('#') || raw.startsWith('data:')) continue;
    const [target, anchor] = raw.split('#');
    if (!target || !target.endsWith('.html')) {
      found.push({ target: raw, anchor: null });
      continue;
    }
    found.push({ target, anchor: anchor ?? null });
  }
  return found;
}

function checkArtifactShape(artifact: ResourceCenterReportArtifact, result: ResourceCenterPreflight): void {
  const grouped = fileByKind(artifact);
  for (const kind of resourceCenterRequiredKinds) {
    const files = grouped.get(kind) ?? [];
    if (files.length === 0) {
      result.blocking.push(
        blocking(
          'missing-required-report',
          kind,
          `Required Resource Center report "${kind}" is missing; the set cannot be uploaded without it.`,
        ),
      );
    } else if (files.length > 1) {
      result.blocking.push(
        blocking(
          'duplicate-report-role',
          kind,
          `Report role "${kind}" appears ${files.length} times; each role must map to exactly one file.`,
        ),
      );
    }
  }
  for (const kind of resourceCenterAllKinds) {
    const files = grouped.get(kind) ?? [];
    for (const file of files) {
      if (
        !file.fileName.startsWith(`${artifact.baseName}_`) ||
        !file.fileName.endsWith(resourceCenterSuffixes[kind])
      ) {
        result.blocking.push(
          blocking(
            'report-filename-mismatch',
            file.fileName,
            `"${file.fileName}" breaks the shared "<base>_<role>.html" convention ` +
              `(expected "${artifact.baseName}${resourceCenterSuffixes[kind]}" for role "${kind}").`,
          ),
        );
      }
    }
  }
  if (!artifact.scopeLabel || artifact.scopeLabel.trim() === '') {
    result.blocking.push(
      blocking(
        'missing-scope-label',
        'scopeLabel',
        'The report set has no scope label; phase/scope agreement cannot be checked.',
      ),
    );
  }
}

function checkDocumentContent(file: ResourceCenterReportFile, result: ResourceCenterPreflight): void {
  const { content } = file;
  if (!content.toLowerCase().startsWith('<!doctype html>') || !content.toLowerCase().includes('<html')) {
    result.blocking.push(
      blocking(
        'malformed-document',
        file.fileName,
        `"${file.fileName}" is not one valid HTML document; the uploader cannot reliably parse it.`,
      ),
    );
    return;
  }
  if (!content.toLowerCase().includes('<meta charset')) {
    result.blocking.push(
      blocking(
        'missing-charset',
        file.fileName,
        `"${file.fileName}" declares no character encoding; non-ASCII names would upload unreliably.`,
      ),
    );
  }
  if (!content.toLowerCase().includes('</html>')) {
    result.blocking.push(
      blocking(
        'malformed-document',
        file.fileName,
        `"${file.fileName}" is truncated (no closing </html>); the uploader cannot reliably parse it.`,
      ),
    );
  }
  if (/<script[\s>]/i.test(content)) {
    result.blocking.push(
      blocking(
        'active-content',
        file.fileName,
        `"${file.fileName}" contains a script element; uploaded stats must render without scripts.`,
      ),
    );
  }
  if (/(?:href|src)="https?:\/\//i.test(content)) {
    result.blocking.push(
      blocking(
        'remote-dependency',
        file.fileName,
        `"${file.fileName}" references a remote URL; uploaded stats must render from the uploaded files alone.`,
      ),
    );
  }
}

function checkInternalLinks(artifact: ResourceCenterReportArtifact, result: ResourceCenterPreflight): void {
  const byName = new Map(artifact.files.map((file) => [file.fileName, file.content]));
  for (const file of artifact.files) {
    for (const { target, anchor } of localHtmlTargets(file.content)) {
      if (!target.endsWith('.html')) {
        result.blocking.push(
          blocking(
            'external-local-asset',
            `${file.fileName}#${target}`,
            `"${file.fileName}" depends on local asset "${target}", which is not part of the upload set.`,
          ),
        );
        continue;
      }
      const targetContent = byName.get(target);
      if (targetContent === undefined) {
        result.blocking.push(
          blocking(
            'dangling-report-link',
            `${file.fileName}#${target}`,
            `"${file.fileName}" links to "${target}", which is not in the upload set.`,
          ),
        );
        continue;
      }
      if (anchor && !targetContent.includes(`id="${anchor}"`)) {
        result.blocking.push(
          blocking(
            'dangling-report-anchor',
            `${file.fileName}#${target}#${anchor}`,
            `"${file.fileName}" links to missing anchor "#${anchor}" in "${target}".`,
          ),
        );
      }
    }
  }
}

function checkIdentity(
  artifact: ResourceCenterReportArtifact,
  snapshot: StatsSnapshot,
  result: ResourceCenterPreflight,
): void {
  const name = snapshot.tournament.name?.trim() ?? '';
  if (!name) {
    result.blocking.push(
      blocking(
        'missing-tournament-identity',
        'tournament.name',
        'The snapshot carries no tournament name; reports would upload anonymously.',
      ),
    );
    return;
  }
  const escaped = reportEscape(name);
  for (const file of artifact.files) {
    const hasTitle = file.content.includes('<title>') && file.content.includes(escaped);
    const hasHeading = file.content.includes('<h1>') && file.content.includes(escaped);
    if (!hasTitle || !hasHeading) {
      result.blocking.push(
        blocking(
          'missing-tournament-identity',
          file.fileName,
          `"${file.fileName}" carries no tournament identity for "${name}" (expected in <title> and <h1>).`,
        ),
      );
    }
  }
}

interface ReconciledTeam {
  games: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
}

/** Count W/L/T and points from the accepted game rows, mirroring the canonical rules. */
function reconcileTeams(games: StatsSnapshot['games']): {
  table: Map<string, ReconciledTeam>;
  inconsistentWinner: boolean;
} {
  const table = new Map<string, ReconciledTeam>();
  let inconsistentWinner = false;
  const entry = (id: string): ReconciledTeam => {
    let row = table.get(id);
    if (!row) {
      row = { games: 0, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 };
      table.set(id, row);
    }
    return row;
  };
  const awardWin = (winnerId: string, loserId: string): void => {
    entry(winnerId).wins += 1;
    entry(loserId).losses += 1;
  };
  for (const game of games) {
    const one = entry(game.teamOneId);
    const two = entry(game.teamTwoId);
    one.games += 1;
    two.games += 1;
    const onePoints = game.teamOnePoints ?? 0;
    const twoPoints = game.teamTwoPoints ?? 0;
    one.pointsFor += onePoints;
    one.pointsAgainst += twoPoints;
    two.pointsFor += twoPoints;
    two.pointsAgainst += onePoints;
    // Canonical order (stats.ts): a forfeiting side loses regardless of the printed
    // score; otherwise the higher score wins and equal scores tie. winnerId is set
    // exactly when the scores differ, so a missing winnerId with differing scores
    // (or a winnerId contradicting the forfeit/score) is itself an inconsistency.
    const forfeitWinner =
      game.forfeitedTeamId === game.teamOneId
        ? game.teamTwoId
        : game.forfeitedTeamId === game.teamTwoId
          ? game.teamOneId
          : undefined;
    // A declared winnerId must agree with both the forfeit and the score: the
    // canonical engine sets it exactly when the scores differ, and a forfeiting
    // side can never be the winner.
    const winnerContradicted =
      game.winnerId !== undefined &&
      (game.winnerId === game.forfeitedTeamId ||
        (onePoints !== twoPoints &&
          game.winnerId !== (onePoints > twoPoints ? game.teamOneId : game.teamTwoId)) ||
        (onePoints === twoPoints && forfeitWinner === undefined));
    if (winnerContradicted) {
      inconsistentWinner = true;
      continue;
    }
    const winner = game.winnerId ?? forfeitWinner;
    if (winner === game.teamOneId) {
      awardWin(game.teamOneId, game.teamTwoId);
    } else if (winner === game.teamTwoId) {
      awardWin(game.teamTwoId, game.teamOneId);
    } else if (onePoints === twoPoints) {
      one.ties += 1;
      two.ties += 1;
    } else {
      inconsistentWinner = true;
    }
  }
  return { table, inconsistentWinner };
}

function checkCrossReportInvariants(
  artifact: ResourceCenterReportArtifact,
  snapshot: StatsSnapshot,
  result: ResourceCenterPreflight,
): void {
  if (snapshot.games.length === 0) {
    result.blocking.push(
      blocking(
        'no-accepted-games',
        'games',
        'The snapshot contains no accepted games; there is nothing coherent to upload.',
      ),
    );
    return;
  }
  const reconciled = reconcileTeams(snapshot.games);
  if (reconciled.inconsistentWinner) {
    result.blocking.push(
      blocking(
        'unresolved-game-winner',
        'games',
        'A game has scores but no consistent winner (winnerId contradicts the forfeit/score); standings cannot reconcile with it.',
      ),
    );
  }
  for (const row of snapshot.teams) {
    const expected = reconciled.table.get(row.teamId);
    if (!expected) {
      result.blocking.push(
        blocking(
          'team-missing-from-games',
          `teams.${row.teamId}`,
          `"${row.teamName}" has a standings row but plays in no accepted game.`,
        ),
      );
      continue;
    }
    const mismatches: string[] = [];
    if (row.gamesPlayed !== expected.games) mismatches.push(`GP ${row.gamesPlayed} vs ${expected.games}`);
    if (row.wins !== expected.wins || row.losses !== expected.losses || row.ties !== expected.ties) {
      mismatches.push(
        `record ${row.wins}-${row.losses}-${row.ties} vs ${expected.wins}-${expected.losses}-${expected.ties}`,
      );
    }
    if (row.pointsFor !== expected.pointsFor || row.pointsAgainst !== expected.pointsAgainst) {
      mismatches.push(
        `PF/PA ${row.pointsFor}/${row.pointsAgainst} vs ${expected.pointsFor}/${expected.pointsAgainst}`,
      );
    }
    if (mismatches.length > 0) {
      result.blocking.push(
        blocking(
          'standings-game-mismatch',
          `teams.${row.teamId}`,
          `"${row.teamName}" disagrees with its accepted games (${mismatches.join('; ')}).`,
        ),
      );
    }
    if (!row.tossupsHeardKnown && row.pptuh !== null) {
      result.blocking.push(
        blocking(
          'impossible-rate',
          `teams.${row.teamId}`,
          `"${row.teamName}" has unknown tossups-heard but a numeric PPTUH; the rate must be withheld, not estimated.`,
        ),
      );
    }
    if (row.bonusesHeard === 0 && row.ppb !== null) {
      result.blocking.push(
        blocking(
          'impossible-rate',
          `teams.${row.teamId}`,
          `"${row.teamName}" heard no bonuses but shows a numeric PPB; the rate must be withheld, not estimated.`,
        ),
      );
    }
  }
  // Tossup counts reconcile with known game lines. Unknown line values aggregate as
  // zero canonically (valueOrZero in stats.ts), so the check mirrors that: sums must
  // match exactly, and any contributing unknown additionally warns below.
  const teamTossups = new Map<
    string,
    { superpowers: number; powers: number; gets: number; negs: number; unknown: boolean }
  >();
  for (const game of snapshot.games) {
    for (const line of game.teamStats ?? []) {
      let entry = teamTossups.get(line.teamId);
      if (!entry) {
        entry = { superpowers: 0, powers: 0, gets: 0, negs: 0, unknown: false };
        teamTossups.set(line.teamId, entry);
      }
      entry.superpowers += line.superpowers ?? 0;
      entry.powers += line.powers ?? 0;
      entry.gets += line.gets ?? 0;
      entry.negs += line.negs ?? 0;
      if (line.superpowers == null || line.powers == null || line.gets == null || line.negs == null) {
        entry.unknown = true;
      }
    }
  }
  for (const [teamId, sums] of teamTossups) {
    const row = snapshot.teams.find((team) => team.teamId === teamId);
    if (!row) continue;
    if (
      row.superpowers !== sums.superpowers ||
      row.powers !== sums.powers ||
      row.gets !== sums.gets ||
      row.negs !== sums.negs
    ) {
      result.blocking.push(
        blocking(
          'team-total-mismatch',
          `teams.${teamId}`,
          `"${row.teamName}" tossup totals disagree with its known game lines.`,
        ),
      );
    }
  }
  const playerPoints = new Map<string, { points: number; powers: number; gets: number; negs: number }>();
  for (const game of snapshot.games) {
    for (const line of game.playerStats ?? []) {
      let entry = playerPoints.get(line.playerId);
      if (!entry) {
        entry = { points: 0, powers: 0, gets: 0, negs: 0 };
        playerPoints.set(line.playerId, entry);
      }
      entry.points += line.points ?? 0;
      entry.powers += line.powers ?? 0;
      entry.gets += line.gets ?? 0;
      entry.negs += line.negs ?? 0;
    }
  }
  for (const [playerId, sums] of playerPoints) {
    const row = snapshot.players.find((player) => player.playerId === playerId);
    if (!row) {
      result.blocking.push(
        blocking(
          'player-missing-from-individuals',
          `players.${playerId}`,
          `A game line exists for an unknown player ("${playerId}").`,
        ),
      );
      continue;
    }
    if (
      row.points !== sums.points ||
      row.powers !== sums.powers ||
      row.gets !== sums.gets ||
      row.negs !== sums.negs
    ) {
      result.blocking.push(
        blocking(
          'player-total-mismatch',
          `players.${playerId}`,
          `"${row.playerName}" totals disagree with known game lines.`,
        ),
      );
    }
    if (row.tossupsHeard == null && row.pptuh !== null) {
      result.blocking.push(
        blocking(
          'impossible-rate',
          `players.${playerId}`,
          `"${row.playerName}" has unknown tossups-heard but a numeric PPTUH.`,
        ),
      );
    }
  }
  // Every accepted game appears in the scoreboard exactly once (ID-anchored so
  // rematches cannot collide). The combined-report variant of this check lands with
  // the multi-phase exporter; single-phase sets are covered here.
  const scoreboard = artifact.files.find((file) => file.kind === 'scoreboard');
  if (scoreboard) {
    for (const game of snapshot.games) {
      const anchor = `id="${reportGameAnchor(game)}"`;
      const occurrences = scoreboard.content.split(anchor).length - 1;
      if (occurrences === 0) {
        result.blocking.push(
          blocking(
            'game-missing-from-scoreboard',
            `games.${game.gameId}`,
            `Accepted game "${game.gameId}" never appears in the scoreboard.`,
          ),
        );
      } else if (occurrences > 1) {
        result.blocking.push(
          blocking(
            'game-duplicated-in-scoreboard',
            `games.${game.gameId}`,
            `Accepted game "${game.gameId}" appears ${occurrences} times in the scoreboard.`,
          ),
        );
      }
    }
  }
}

function checkStatKeyCoverage(
  artifact: ResourceCenterReportArtifact,
  snapshot: StatsSnapshot,
  result: ResourceCenterPreflight,
): void {
  const statKey = artifact.files.find((file) => file.kind === 'statKey');
  if (!statKey) return;
  const presentation = reportPresentationOf(snapshot);
  for (const column of presentation.answerColumns) {
    if (!statKey.content.includes(reportEscape(column.shortLabel))) {
      result.blocking.push(
        blocking(
          'statkey-missing-column',
          statKey.fileName,
          `The stat key never describes the emitted "${column.shortLabel}" column.`,
        ),
      );
    }
  }
  if (!presentation.applicability.bonuses && />PPB</.test(statKey.content)) {
    result.blocking.push(
      blocking(
        'statkey-describes-absent-column',
        statKey.fileName,
        'The stat key describes PPB, but this tournament awards no bonuses.',
      ),
    );
  }
  if (!presentation.applicability.bouncebacks && statKey.content.includes('Bounceback')) {
    result.blocking.push(
      blocking(
        'statkey-describes-absent-column',
        statKey.fileName,
        'The stat key describes bouncebacks, but none were recorded.',
      ),
    );
  }
  if (!presentation.applicability.lightning && statKey.content.includes('Lightning')) {
    result.blocking.push(
      blocking(
        'statkey-describes-absent-column',
        statKey.fileName,
        'The stat key describes lightning rounds, but none were recorded.',
      ),
    );
  }
  if (!presentation.applicability.overtime && statKey.content.includes('Overtime')) {
    result.blocking.push(
      blocking(
        'statkey-describes-absent-column',
        statKey.fileName,
        'The stat key describes overtime, but none was recorded.',
      ),
    );
  }
}

function checkWarnings(
  artifact: ResourceCenterReportArtifact,
  snapshot: StatsSnapshot,
  result: ResourceCenterPreflight,
): void {
  const byKind = new Map(artifact.files.map((file) => [file.kind, file] as const));
  for (const game of snapshot.games) {
    if (game.detail === 'partial') {
      result.warnings.push(
        warn(
          'partial-player-detail',
          `games.${game.gameId}`,
          `Game "${game.gameId}" has partial detail; individuals for it are incomplete. ` +
            (byKind.get('scoreboard') ? 'The scoreboard marks it; ' : '') +
            'confirm the Resource Center shows the same limitation.',
        ),
      );
    }
    if (game.forfeitedTeamId) {
      result.warnings.push(
        warn(
          'forfeit-representation',
          `games.${game.gameId}`,
          `Game "${game.gameId}" is a forfeit. The HTML set annotates it explicitly, but the ` +
            'Resource Center parser has not been proven against forfeit annotations — verify the uploaded report.',
        ),
      );
    }
  }
  const presentation = reportPresentationOf(snapshot);
  if (presentation.answerColumns.length === 0 && snapshot.games.length > 0) {
    result.blocking.push(
      blocking(
        'unrepresentable-scoring-layout',
        'presentation.answerColumns',
        'No answer tiers can be described for these games; the individuals table cannot represent this scoring layout.',
      ),
    );
  }
  if (presentation.mixedDefinitionNote) {
    result.warnings.push(
      warn(
        'mixed-scoring-definitions',
        'presentation.definitions',
        'Combined scoring definitions are disclosed in the stat key, but per-game point values vary within this report.',
      ),
    );
  }
  if (presentation.applicability.bouncebacks || presentation.applicability.lightning) {
    result.warnings.push(
      warn(
        'rich-stat-legacy-field',
        'presentation.applicability',
        'Bounceback/lightning statistics have no legacy SQBS/YellowFruit column; they render in QBSheet tables only.',
      ),
    );
  }
  if (presentation.applicability.overtime) {
    result.warnings.push(
      warn(
        'overtime-scope',
        'presentation.applicability',
        'Overtime tossups are listed on the scoreboard page; confirm they survive the Resource Center upload.',
      ),
    );
  }
  for (const row of snapshot.teams) {
    if (!row.tossupsHeardKnown) {
      result.warnings.push(
        warn(
          'unknown-tossups-heard',
          `teams.${row.teamId}`,
          `"${row.teamName}" is missing tossups-heard for some games; its rates are withheld (shown as —).`,
        ),
      );
    }
  }
  const unknownPlayerLines = snapshot.players.filter((player) => player.tossupsHeard == null).length;
  if (unknownPlayerLines > 0) {
    result.warnings.push(
      warn(
        'unknown-player-tossups-heard',
        byKind.get('individuals')?.fileName ?? 'individuals',
        `${unknownPlayerLines} player${unknownPlayerLines === 1 ? '' : 's'} ${unknownPlayerLines === 1 ? 'is' : 'are'} missing tossups-heard; affected rates are withheld (shown as —).`,
      ),
    );
  }
}

/**
 * Run the Resource Center export preflight. Artifact-shape checks always run;
 * identity, cross-report invariants, stat-key coverage, and warnings additionally
 * run when the canonical snapshot is supplied (Director always supplies it).
 */
export function preflightResourceCenterReport(
  artifact: ResourceCenterReportArtifact,
  snapshot?: StatsSnapshot,
): ResourceCenterPreflight {
  const result: ResourceCenterPreflight = { ok: true, blocking: [], warnings: [] };
  checkArtifactShape(artifact, result);
  for (const file of artifact.files) checkDocumentContent(file, result);
  checkInternalLinks(artifact, result);
  if (snapshot) {
    checkIdentity(artifact, snapshot, result);
    checkCrossReportInvariants(artifact, snapshot, result);
    checkStatKeyCoverage(artifact, snapshot, result);
    checkWarnings(artifact, snapshot, result);
  }
  result.ok = result.blocking.length === 0;
  return result;
}
