/**
 * The line between the file that leaves this device and the state that never does.
 *
 * # Two payloads that look alike and are not
 *
 * The scorer builds one QBJ object per render and hands the same object to three places: the live
 * snapshot going back to tournament control, the final submission, and the download. The first two
 * are transport between this browser and a server that is already holding the game; the third is a
 * file that goes onto a USB stick, into an email, into whatever folder a tournament chose, and into
 * an import on somebody else's laptop.
 *
 * Those are not the same object and must not be. The internal payload carries
 * `_yf_scorekeeper_recovery` — the complete `ScoreEvent` history and the frozen setup — because
 * that is what lets a wiped Chromebook be handed its half-scored game back intact. The portable
 * payload must not, because it is a scorer's private state model shipped inside a file that claims
 * to be an interchange format, it will confuse anything that walks unknown keys, and it makes a
 * three-kilobyte result into a much larger one for no benefit to the person receiving it.
 *
 * So `portableQbj` is the only way a payload leaves the device, and it is subtractive: it removes
 * the recovery layer and anything credential-shaped, and then adds back exactly the small block of
 * identity described below.
 *
 * # Why the download carries any metadata at all
 *
 * Because the alternative is matching on the filename, and the filename is the one thing about a
 * result that is guaranteed to have been changed by the time it arrives. A tournament that receives
 * sixteen QBJs from sixteen rooms has to attach each to the right scheduled game, and asking a human
 * to do that from `Round 7 — Ninety Six A vs Greenwood (1).qbj` is how a result ends up on the wrong
 * match.
 *
 * The block is small, non-secret, and ignorable: nothing here is a credential, nothing identifies a
 * device or a person, and a tool that has never heard of it reads the statistical result exactly as
 * it would have anyway.
 */
import { IGameDefinition, playerIdentityKey } from './GameDefinition';
import { IGamePackage, gamePackageProducer, gamePackageVersion } from './GamePackage';
import { scorerRecoveryKey } from '../scorer/ScorerRecovery';
import { qbtcpExtensionKey, readQbtcpExtension } from '../qbj/QbtcpExtension';

/**
 * The extension namespace the legacy Match-only download carries.
 *
 * Still written, and only there. A bare Match has no envelope, so there is nowhere standard for the
 * tournament's identity to live and a compatibility block is the only way a receiver can tell which
 * game the file is. The official serialized document has no such problem — its identity is in
 * `Tournament`, `Round` and `Match` — so it carries `_qbtcp` for operational extras and nothing
 * else. That is what "no longer the preferred source metadata" means in practice.
 */
export const sourceExtensionKey = '_qbsheet_source';
/** Read-only compatibility for results downloaded before QBSheet was named. */
const legacySourceExtensionKey = '_scoresheet_source';

export interface IQbjSourceMetadata {
  producer?: typeof gamePackageProducer;
  /** Which package schema produced this result. */
  gamePackageVersion: number;
  /** The tournament's stable identifier, when the package had one. */
  tournamentId?: string;
  tournamentName: string;
  /** The scheduled game this was scored from, when the package named one. */
  scheduledMatchId?: string;
  roundNumber: number;
  /**
   * Which issue of the round's pairings this was scored against.
   *
   * The field that makes a stale result detectable. A result carrying revision 1 for a round that
   * has since been redrawn is not wrong, but it is not current either, and tournament control has
   * to be able to tell the difference without asking the room.
   */
  roundRevision: number;
  /** Which issue of this room's assignment was delivered, when the package carried one. */
  assignmentRevision?: number;
  roomName?: string;
  /** Stable fingerprint of the portable statistical payload, used for backup reconciliation. */
  resultFingerprint?: string;
}

/** The non-secret identity fields a roster-add or recovery amendment may return. */
export interface ICanonicalRosterIdentity {
  playerId?: string;
  playerName?: string;
  teamId?: string;
  teamName?: string;
}

/**
 * Keys stripped from anything leaving the device, matched after removing separators and case.
 *
 * In practice this removes nothing: the scorer's payload is built by `toQbjMatch`, which has no
 * access to a credential and never puts one anywhere. It is here because "in practice nothing" is a
 * property of today's code rather than of the format, and the cost of being wrong is a room token
 * sitting in a file that gets emailed around.
 */
const forbiddenKeys = new Set([
  'accesstoken',
  'token',
  'sessiontoken',
  'sessionid',
  'sessioncredentials',
  'roomtoken',
  'pairingcode',
  'deviceid',
  'authorization',
  'credentials',
  'secret',
]);

function isForbiddenKey(key: string): boolean {
  const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
  return forbiddenKeys.has(normalized) || key === scorerRecoveryKey;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A deep copy with the recovery layer and anything credential-shaped removed.
 *
 * Deliberately a copy. The caller keeps the exact bytes it will send to the server, and preparing a
 * download must not be able to change what tournament control eventually receives.
 */
export function stripInternalState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripInternalState(entry));
  if (typeof value !== 'object' || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenKey(key)) continue;
    output[key] = stripInternalState(entry);
  }
  return output;
}

export function sourceMetadata(packageValue: IGamePackage): IQbjSourceMetadata {
  return {
    producer: gamePackageProducer,
    gamePackageVersion,
    ...(packageValue.tournament.key ? { tournamentId: packageValue.tournament.key } : {}),
    tournamentName: packageValue.tournament.name,
    ...(packageValue.scheduledMatchId ? { scheduledMatchId: packageValue.scheduledMatchId } : {}),
    roundNumber: packageValue.round.number,
    roundRevision: packageValue.round.revision,
    ...(packageValue.round.assignmentRevision !== undefined
      ? { assignmentRevision: packageValue.round.assignmentRevision }
      : {}),
    ...(packageValue.room?.name ? { roomName: packageValue.room.name } : {}),
  };
}

function identityText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 500 ? value : undefined;
}

function sideForName(packageValue: IGamePackage, name: string): 'left' | 'right' | undefined {
  const exact = (['left', 'right'] as const).filter((side) => packageValue[side].name === name);
  if (exact.length === 1) return exact[0];
  const folded = name.toLocaleLowerCase();
  const insensitive = (['left', 'right'] as const).filter(
    (side) => packageValue[side].name.toLocaleLowerCase() === folded,
  );
  return insensitive.length === 1 ? insensitive[0] : undefined;
}

/**
 * Add a canonical player id to the durable package identity map.
 *
 * The package's display names remain the scorer's local vocabulary. Matching an amendment therefore
 * uses a known team id first and a uniquely resolved team name second; an ambiguous amendment is left
 * untouched rather than assigning an id to the wrong side. Both the requested and canonical player
 * names are keyed when they differ, because the next QBJ may contain either spelling.
 */
export function applyCanonicalRosterIdentity(
  packageValue: IGamePackage,
  requestedTeamName: string,
  requestedPlayerName: string,
  canonical: ICanonicalRosterIdentity,
): IGamePackage {
  const definition = packageValue as IGameDefinition;
  const identity = definition.qbjIdentity;
  const playerId = identityText(canonical.playerId);
  const requestedTeam = identityText(requestedTeamName);
  const requestedPlayer = identityText(requestedPlayerName);
  if (!identity || !playerId || !requestedTeam || !requestedPlayer) return packageValue;

  const sides = ['left', 'right'] as const;
  const idMatches = canonical.teamId
    ? sides.filter((side) => identity.teamIds?.[side] === canonical.teamId)
    : [];
  if (idMatches.length > 1) return packageValue;
  const idSide = idMatches[0];
  const namedSides = [requestedTeam, identityText(canonical.teamName)]
    .filter((name): name is string => name !== undefined)
    .map((name) => sideForName(packageValue, name))
    .filter((side): side is (typeof sides)[number] => side !== undefined);
  const distinctNamedSides = [...new Set(namedSides)];
  if (idSide && distinctNamedSides.some((side) => side !== idSide)) return packageValue;
  const side = idSide ?? (distinctNamedSides.length === 1 ? distinctNamedSides[0] : undefined);
  if (!side) return packageValue;

  const playerNames = [
    ...new Set([requestedPlayer, identityText(canonical.playerName)].filter(Boolean)),
  ] as string[];
  const playerIds = { ...(identity.playerIds ?? {}) };
  let changed = false;
  for (const playerName of playerNames) {
    const key = playerIdentityKey(packageValue[side].name, playerName);
    if (playerIds[key] === playerId) continue;
    playerIds[key] = playerId;
    changed = true;
  }
  if (!changed) return packageValue;
  return {
    ...packageValue,
    qbjIdentity: {
      ...identity,
      playerIds,
    },
  } as IGamePackage;
}

/**
 * Preserve canonical QBJ ids in the snapshots built by the scorer.
 *
 * The scoring engine intentionally works in display names. A roster add can nevertheless return a
 * durable tournament player id, so the client grafts that id onto the existing name-shaped match at
 * the transport/file boundary. Unknown ids and unknown match fields remain untouched.
 */
export function withQbjIdentity(qbj: object, packageValue: IGamePackage): object {
  const identity = (packageValue as IGameDefinition).qbjIdentity;
  if (!identity) return qbj;
  const teams = (qbj as Record<string, unknown>).match_teams;
  if (!Array.isArray(teams)) return qbj;

  const sides = ['left', 'right'] as const;
  const matchTeams = teams.map((value, position) => {
    if (!isRecord(value)) return value;
    const side = sides[position];
    if (!side) return value;
    const team = packageValue[side];
    const teamId = identity.teamIds?.[side];
    const teamValue = isRecord(value.team) ? (teamId ? { $ref: teamId } : value.team) : value.team;
    const players = Array.isArray(value.match_players)
      ? value.match_players.map((matchPlayer) => {
          if (!isRecord(matchPlayer) || !isRecord(matchPlayer.player)) return matchPlayer;
          const name = matchPlayer.player.name;
          if (typeof name !== 'string') return matchPlayer;
          const playerId = identity.playerIds?.[playerIdentityKey(team.name, name)];
          return playerId ? { ...matchPlayer, player: { $ref: playerId } } : matchPlayer;
        })
      : value.match_players;
    return {
      ...value,
      ...(teamValue !== undefined ? { team: teamValue } : {}),
      ...(Array.isArray(value.match_players) ? { match_players: players } : {}),
    };
  });

  return { ...qbj, match_teams: matchTeams };
}

/**
 * Extension blocks that describe how a result travelled rather than what happened in the game.
 *
 * All three are excluded from the fingerprint, because the same game scored once must produce one
 * fingerprint whether it arrived automatically over QBTCP or as a file a scorekeeper carried. A
 * fingerprint that moved when the transport metadata moved would report every backup as a conflict,
 * which is the exact failure the fingerprint exists to prevent.
 */
const ignoredForFingerprint = new Set<string>([
  qbtcpExtensionKey,
  sourceExtensionKey,
  legacySourceExtensionKey,
]);

/** Canonical JSON for a portable result, with object-key order made irrelevant. */
function canonicalPortableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalPortableJson(entry)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !ignoredForFingerprint.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalPortableJson(entry)}`)
    .join(',')}}`;
}

/**
 * A small browser-safe fingerprint for matching an automatic server result to its later QBJ backup.
 *
 * This is an equality aid, not an authenticity claim: the server still authenticates the room and
 * the director still reviews results. BigInt keeps the value deterministic across browsers without
 * pulling a Node crypto polyfill into the static site.
 */
export function portableResultFingerprint(qbj: object): string {
  const canonical = canonicalPortableJson(stripInternalState(qbj));
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= BigInt(canonical.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

/** Attach source identity to the internal payload sent to control without removing recovery data. */
export function qbjWithSourceMetadata(qbj: object, packageValue: IGamePackage): object {
  const identified = withQbjIdentity(qbj, packageValue);
  return {
    ...identified,
    [sourceExtensionKey]: {
      ...sourceMetadata(packageValue),
      resultFingerprint: portableResultFingerprint(identified),
    },
  };
}

/**
 * The result as a file: an ordinary QBJ Match, plus one block saying which game it came from.
 *
 * The only function that produces something for a human to carry away. Everything that downloads,
 * re-downloads or shows a result goes through it, so there is exactly one place where the question
 * "could this file contain something it shouldn't" has to be answered.
 */
export function portableQbj(qbj: object, packageValue: IGamePackage): object {
  const stripped = withQbjIdentity(stripInternalState(qbj) as object, packageValue) as Record<
    string,
    unknown
  >;
  return {
    ...stripped,
    [sourceExtensionKey]: {
      ...sourceMetadata(packageValue),
      resultFingerprint: portableResultFingerprint(stripped),
    },
  };
}

/**
 * A whole serialized document as a file.
 *
 * The official path's half of the sanitization boundary. The document is built by `QbjResult` from
 * `toQbjMatch`, which has never had access to a credential — but the boundary is a property of the
 * download, not of today's builder, and there is exactly one place where "could this file contain
 * something it shouldn't" is answered for anything that leaves the device.
 *
 * No source block is added: a serialized document already carries its identity in `Tournament`,
 * `Round` and `Match`, and restating it would be the duplication the profile forbids.
 */
export function portableQbjDocument(document: object): object {
  return stripInternalState(document) as object;
}

/**
 * Where a result says it came from, whichever generation wrote it.
 *
 * `_qbtcp` is read first because it is what new results carry; the two older blocks are read after
 * it so a result downloaded before this migration still reconciles. Nothing writes the older blocks
 * except the legacy Match-only export.
 */
export function readResultOrigin(
  qbj: unknown,
): { roundRevision?: number; assignmentRevision?: number; roomId?: string } | null {
  const extension = readQbtcpExtension(qbj);
  if (extension) {
    return {
      ...(extension.roundRevision !== undefined ? { roundRevision: extension.roundRevision } : {}),
      ...(extension.assignmentRevision !== undefined
        ? { assignmentRevision: extension.assignmentRevision }
        : {}),
      ...(extension.roomId !== undefined ? { roomId: extension.roomId } : {}),
    };
  }
  const legacy = readSourceMetadata(qbj);
  if (!legacy) return null;
  return {
    roundRevision: legacy.roundRevision,
    ...(legacy.assignmentRevision !== undefined ? { assignmentRevision: legacy.assignmentRevision } : {}),
  };
}

/** Read the source block back, for a tool that wants to know where a result came from. */
export function readSourceMetadata(qbj: unknown): IQbjSourceMetadata | null {
  if (typeof qbj !== 'object' || qbj === null) return null;
  const record = qbj as Record<string, unknown>;
  const block = record[sourceExtensionKey] ?? record[legacySourceExtensionKey];
  if (typeof block !== 'object' || block === null) return null;
  const candidate = block as Partial<IQbjSourceMetadata>;
  if (candidate.producer !== undefined && candidate.producer !== gamePackageProducer) return null;
  if (typeof candidate.gamePackageVersion !== 'number' || !Number.isInteger(candidate.gamePackageVersion))
    return null;
  if (typeof candidate.tournamentName !== 'string' || candidate.tournamentName.trim() === '') return null;
  if (
    typeof candidate.roundNumber !== 'number' ||
    !Number.isInteger(candidate.roundNumber) ||
    candidate.roundNumber < 1
  )
    return null;
  if (
    typeof candidate.roundRevision !== 'number' ||
    !Number.isInteger(candidate.roundRevision) ||
    candidate.roundRevision < 1
  )
    return null;
  if (
    candidate.assignmentRevision !== undefined &&
    (typeof candidate.assignmentRevision !== 'number' ||
      !Number.isInteger(candidate.assignmentRevision) ||
      candidate.assignmentRevision < 1)
  )
    return null;
  if (candidate.tournamentId !== undefined && typeof candidate.tournamentId !== 'string') return null;
  if (candidate.scheduledMatchId !== undefined && typeof candidate.scheduledMatchId !== 'string') return null;
  if (candidate.roomName !== undefined && typeof candidate.roomName !== 'string') return null;
  if (candidate.resultFingerprint !== undefined && typeof candidate.resultFingerprint !== 'string')
    return null;
  return candidate as IQbjSourceMetadata;
}
