/**
 * The QBTCP v1 route surface, and the legacy surface it replaces.
 *
 * # Why the routes are data
 *
 * A scoresheet has to work against two kinds of server for as long as the migration lasts: one that
 * speaks `/qbtcp/v1` and one that only speaks the older `/api/v1`. The wrong way to handle that is a
 * conditional at every call site, which is nine places to forget one. So the surface is a value: the
 * client discovers which one it is talking to, holds the matching route table, and every request is
 * written once.
 *
 * # `:roomId` is not in the canonical paths
 *
 * A room token already scopes to exactly one room, so the segment was redundant, and a path that
 * contains a room id invites the belief that a different room can be reached by editing it. The
 * canonical routes resolve the room from the credential. The legacy table keeps the segment because
 * that is what those servers route on.
 *
 * # This file names no product
 *
 * QBTCP is a protocol, not one application's API. Nothing here refers to a particular tournament
 * manager, and another implementation of either side should be able to use this table as written.
 */

/** The canonical protocol prefix. */
export const qbtcpPrefix = '/qbtcp/v1';

/** The pre-QBTCP prefix, retained by servers as deprecated aliases onto the same handlers. */
export const legacyApiPrefix = '/api/v1';

export type QbtcpProtocol = 'qbtcp/v1' | 'api/v1' | 'qbtcp/unsupported';

/** What the discovery endpoint says about a server, once it has been asked. */
export interface IQbtcpDiscovery {
  protocol: string;
  version: number;
  capabilities: string[];
  /** The QBJ serialization version this server produces and accepts, when it says. */
  qbjVersion?: string;
  name?: string;
}

export interface IQbtcpRoutes {
  protocol: QbtcpProtocol;
  /**
   * Whether the assignment endpoint returns a QBJ document.
   *
   * False on the legacy surface, which answers with its own JSON shape. The one place the two
   * protocols differ in more than spelling, and the reason the client keeps both readers.
   */
  assignmentIsQbj: boolean;
  discovery: string;
  status: string;
  tournament: string;
  rooms: string;
  pair: string;
  assignment(roomId: string): string;
  /** Operational state that is deliberately not in the QBJ body. Null on the legacy surface. */
  assignmentStatus(roomId: string): string | null;
  openSession(roomId: string): string;
  presence(roomId: string): string;
  help(roomId: string): string;
  helpItem(roomId: string, helpId: string): string;
  addPlayer(roomId: string): string;
  session(sessionId: string): string;
  progress(sessionId: string): string;
  result(sessionId: string): string;
  recovery(sessionId: string): string;
}

const id = (value: string) => encodeURIComponent(value);

/** The canonical surface. Rooms come from the token, so room ids do not appear in paths. */
export const qbtcpRoutes: IQbtcpRoutes = {
  protocol: 'qbtcp/v1',
  assignmentIsQbj: true,
  discovery: qbtcpPrefix,
  status: qbtcpPrefix,
  tournament: `${qbtcpPrefix}/tournament`,
  rooms: `${qbtcpPrefix}/rooms`,
  pair: `${qbtcpPrefix}/pair`,
  assignment: () => `${qbtcpPrefix}/assignment`,
  assignmentStatus: () => `${qbtcpPrefix}/assignment/status`,
  openSession: () => `${qbtcpPrefix}/sessions`,
  presence: () => `${qbtcpPrefix}/presence`,
  help: () => `${qbtcpPrefix}/help`,
  helpItem: (_roomId, helpId) => `${qbtcpPrefix}/help/${id(helpId)}`,
  addPlayer: () => `${qbtcpPrefix}/roster/players`,
  session: (sessionId) => `${qbtcpPrefix}/sessions/${id(sessionId)}`,
  progress: (sessionId) => `${qbtcpPrefix}/sessions/${id(sessionId)}/progress`,
  result: (sessionId) => `${qbtcpPrefix}/sessions/${id(sessionId)}/result`,
  recovery: (sessionId) => `${qbtcpPrefix}/sessions/${id(sessionId)}/recovery`,
};

/** The surface deployed before QBTCP was named. Kept so existing servers keep working. */
export const legacyRoutes: IQbtcpRoutes = {
  protocol: 'api/v1',
  assignmentIsQbj: false,
  discovery: `${legacyApiPrefix}/status`,
  status: `${legacyApiPrefix}/status`,
  tournament: `${legacyApiPrefix}/tournament`,
  rooms: `${legacyApiPrefix}/join/rooms`,
  pair: `${legacyApiPrefix}/join`,
  assignment: (roomId) => `${legacyApiPrefix}/rooms/${id(roomId)}/assignment`,
  assignmentStatus: () => null,
  openSession: (roomId) => `${legacyApiPrefix}/rooms/${id(roomId)}/sessions`,
  presence: (roomId) => `${legacyApiPrefix}/rooms/${id(roomId)}/presence`,
  help: (roomId) => `${legacyApiPrefix}/rooms/${id(roomId)}/help`,
  helpItem: (roomId, helpId) => `${legacyApiPrefix}/rooms/${id(roomId)}/help/${id(helpId)}`,
  addPlayer: (roomId) => `${legacyApiPrefix}/rooms/${id(roomId)}/players`,
  session: (sessionId) => `${legacyApiPrefix}/sessions/${id(sessionId)}`,
  progress: (sessionId) => `${legacyApiPrefix}/sessions/${id(sessionId)}/snapshot`,
  result: (sessionId) => `${legacyApiPrefix}/sessions/${id(sessionId)}/final`,
  recovery: (sessionId) => `${legacyApiPrefix}/sessions/${id(sessionId)}/recovery`,
};

/**
 * A route-shaped marker for an announced QBTCP version this build cannot speak.
 *
 * It deliberately retains the canonical paths for diagnostics and type completeness, but the
 * adapter selected for this table refuses every operation without calling one. In particular, it
 * is not `legacyRoutes`: an explicit future announcement is not evidence that the deprecated API
 * has the same semantics.
 */
export const unsupportedQbtcpRoutes: IQbtcpRoutes = {
  ...qbtcpRoutes,
  protocol: 'qbtcp/unsupported',
};

/**
 * Read a discovery response.
 *
 * Strict about the two fields a client acts on and forgiving about everything else, because a
 * server is allowed to add capabilities and a client that refused an unfamiliar one would break on
 * every upgrade. An unreadable response is not an error — it means this server does not speak
 * QBTCP, and the legacy table is used.
 */
export function readDiscovery(value: unknown): IQbtcpDiscovery | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.protocol !== 'QBTCP') return null;
  if (typeof record.version !== 'number' || !Number.isInteger(record.version)) return null;
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    protocol: 'QBTCP',
    version: record.version,
    capabilities,
    ...(typeof record.qbj_version === 'string' ? { qbjVersion: record.qbj_version } : {}),
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
  };
}

/**
 * Which routes to use against a server that answered discovery this way.
 *
 * Only version 1 is understood. A server announcing a future version is not assumed to be
 * backward-compatible on either surface, so it gets an explicit unsupported marker. Only an absent
 * or non-QBTCP response selects the legacy table.
 */
export function routesFor(discovery: IQbtcpDiscovery | null): IQbtcpRoutes {
  if (!discovery) return legacyRoutes;
  if (discovery.version === 1) return qbtcpRoutes;
  return unsupportedQbtcpRoutes;
}

/** Whether a server said it supports a named capability. */
export function supports(discovery: IQbtcpDiscovery | null, capability: string): boolean {
  return discovery?.capabilities.includes(capability) ?? false;
}
