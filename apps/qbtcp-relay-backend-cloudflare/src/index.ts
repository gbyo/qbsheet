/**
 * QBTCP relay — Cloudflare Worker entry point.
 *
 * This Worker is deployed **into the tournament operator's own Cloudflare account**. QBSheet does
 * not operate it, does not have credentials for it, and does not pay for its traffic. That is the
 * point of the whole architecture: Internet relay load belongs to the tournament that created it.
 *
 * The Worker itself is a router. All state lives in one `QbtcpRelay` Durable Object per
 * tournament, keyed by tournament id, which is where the SQLite and the WebSockets are. One
 * tournament is coordinated by one strongly consistent object; an operator deployment may serve
 * several tournaments, each resolving to its own object.
 */

import { isTournamentId, QbtcpRelay, RelayError, json } from './relay';

export { QbtcpRelay };

/**
 * A tournament id, validated before it becomes a Durable Object name.
 *
 * Narrow on purpose: the id arrives from a URL a stranger can construct, and
 * `idFromName(<arbitrary string>)` would let anybody create an unbounded number of Durable Objects
 * in the operator's account. A fixed alphabet and a fixed length is the cheapest possible bound.
 */
function tournamentIdFromPath(value: string | undefined): string | null {
  if (!value || !isTournamentId(value)) return null;
  return value;
}

const publicCors: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: publicCors });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      // Deliberately says nothing about which tournaments exist on this relay.
      return json({ service: 'qbtcp-relay', protocolVersion: 1 }, 200, publicCors);
    }

    const tournamentMatch =
      /^\/qbtcp\/v1\/tournaments\/([^/]+)\/(discovery|assignment(?:\/status)?|pair|sessions(?:\/.*)?|presence|help(?:\/.*)?|stream)$/.exec(
        url.pathname,
      );
    if (tournamentMatch) {
      const [, rawId, action] = tournamentMatch;
      const tournamentId = tournamentIdFromPath(rawId);
      if (!tournamentId) {
        return new RelayError(404, 'not-found', 'No such tournament.').toResponse({});
      }
      const stub = env.QBTCP_RELAY.get(env.QBTCP_RELAY.idFromName(tournamentId));
      const inner = new Request(`https://relay/${action}${url.search}`, {
        method: request.method,
        headers: withStreamPath(request.headers, url.pathname),
        body: request.method === 'GET' || request.method === 'DELETE' ? undefined : request.body,
        // @ts-expect-error Duplex is required for streamed request bodies in workers.
        duplex: request.method === 'GET' || request.method === 'DELETE' ? undefined : 'half',
      });
      return stub.fetch(inner);
    }

    if (url.pathname === '/qbtcp/v1/manage/claim' && request.method === 'POST') {
      // The claim body names the tournament, because a freshly deployed relay does not yet know
      // which tournament it is for. Read it here and route on it; the object re-validates.
      const body = await request.clone().text();
      let tournamentId: string | undefined;
      try {
        tournamentId = (JSON.parse(body) as { tournamentId?: string }).tournamentId;
      } catch {
        return new RelayError(400, 'invalid-request', 'That request body is not valid JSON.').toResponse({});
      }
      if (!tournamentId || !isTournamentId(tournamentId)) {
        return new RelayError(400, 'invalid-request', 'A valid tournament id is required.').toResponse({});
      }
      const stub = env.QBTCP_RELAY.get(env.QBTCP_RELAY.idFromName(tournamentId));
      return stub.fetch(
        new Request('https://relay/manage/claim', {
          method: 'POST',
          headers: request.headers,
          body,
        }),
      );
    }

    const manageMatch =
      /^\/qbtcp\/v1\/manage\/tournaments\/([^/]+)(?:\/(mirror|events|sessions|results|help|acks|revoke|rotate|close|chaos|health|help\/[^/]+\/resolve))?$/.exec(
        url.pathname,
      );
    if (manageMatch) {
      const [, rawId, action] = manageMatch;
      const tournamentId = tournamentIdFromPath(rawId);
      if (!tournamentId) {
        return new RelayError(404, 'not-found', 'No such tournament.').toResponse({});
      }
      // DELETE without an action destroys the tournament; anything else without an action is
      // not a route. Forwarding a scorer-shaped request here must never gain management power,
      // and answering it 200 would read as though it did.
      if (!action && request.method !== 'DELETE') {
        return new RelayError(404, 'not-found', 'No such relay route.').toResponse({});
      }
      const target = !action
        ? 'manage'
        : action.startsWith('help/')
          ? `manage/${action}`
          : `manage/${action}`;
      const stub = env.QBTCP_RELAY.get(env.QBTCP_RELAY.idFromName(tournamentId));
      return stub.fetch(
        new Request(`https://relay/${target}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body: request.method === 'GET' || request.method === 'DELETE' ? undefined : request.body,
          // @ts-expect-error Duplex is required for streamed request bodies in workers.
          duplex: request.method === 'GET' || request.method === 'DELETE' ? undefined : 'half',
        }),
      );
    }

    return new RelayError(404, 'not-found', 'No such relay route.').toResponse({});
  },
} satisfies ExportedHandler<Env>;

function withStreamPath(headers: Headers, pathname: string): Headers {
  // The discovery descriptor carries the stream endpoint as a relative path. The object derives
  // it from the tournament id, but the Worker states the path it actually routes, so a mount
  // under a different prefix could never advertise a stale endpoint.
  const copy = new Headers(headers);
  const streamPath = pathname.replace(
    /\/(discovery|assignment(?:\/status)?|pair|sessions(?:\/.*)?|presence|help(?:\/.*)?|stream)$/,
    '/stream',
  );
  copy.set('x-relay-stream-path', streamPath);
  return copy;
}
