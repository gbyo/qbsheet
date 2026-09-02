/**
 * QBLive backend — Cloudflare Worker entry point.
 *
 * This Worker is deployed **into the tournament director's own Cloudflare account**. QBSheet does
 * not operate it, does not have credentials for it, and does not pay for its traffic. That is the
 * point of the whole architecture: spectator load belongs to the tournament that created it.
 *
 * The Worker itself is a router. All state lives in one `QblivePublication` Durable Object per
 * tournament, keyed by publication id, which is where the SQLite and the WebSockets are.
 */

import { QblivePublication, HttpError, json, type Env } from './publication';

export { QblivePublication };

/**
 * A publication id, validated before it becomes a Durable Object name.
 *
 * Narrow on purpose: the id arrives from a URL a stranger can construct, and
 * `idFromName(<arbitrary string>)` would let anybody create an unbounded number of Durable Objects
 * in the director's account. A fixed alphabet and a fixed length is the cheapest possible bound.
 */
const publicationIdPattern = /^[0-9bcdfghjkmnpqrstvwxyz]{20}$/;

const corsHeaders: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      // Deliberately says nothing about which tournaments exist on this backend.
      return json({ service: 'qblive', protocolVersion: 1 });
    }

    const publicMatch = /^\/qblive\/v1\/tournaments\/([^/]+)\/(manifest|snapshot|events|stream)$/.exec(
      url.pathname,
    );
    if (publicMatch) {
      const [, publicationId, action] = publicMatch;
      if (!publicationIdPattern.test(publicationId)) {
        return new HttpError(404, 'not-found', 'No such tournament.').toResponse();
      }
      // The public surface is read-only. Forwarding a PUT here as a GET would answer 200 to a write
      // attempt, which reads to a caller — and to a security reviewer — as though the write landed.
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new HttpError(405, 'not-found', 'QBLive public routes are read-only.').toResponse();
      }
      const search = url.search;
      return stub(env, publicationId).fetch(
        new Request(`https://publication/${action}${search}`, {
          method: 'GET',
          headers: request.headers,
        }),
      );
    }

    if (url.pathname === '/qblive/v1/manage/claim' && request.method === 'POST') {
      // The claim body names the publication, because a freshly deployed backend does not yet know
      // which tournament it is for. Read it here and route on it; the object re-validates.
      const body = await request.clone().text();
      let publicationId: string | undefined;
      try {
        publicationId = (JSON.parse(body) as { publicationId?: string }).publicationId;
      } catch {
        return new HttpError(400, 'bad-request', 'That request body is not valid JSON.').toResponse();
      }
      if (!publicationId || !publicationIdPattern.test(publicationId)) {
        return new HttpError(400, 'bad-request', 'A valid publication id is required.').toResponse();
      }
      return stub(env, publicationId).fetch(
        new Request('https://publication/manage/claim', {
          method: 'POST',
          headers: request.headers,
          body,
        }),
      );
    }

    const manageMatch =
      /^\/qblive\/v1\/manage\/tournaments\/([^/]+)(?:\/(snapshot|sections|announcements|finalize|unpublish))?$/.exec(
        url.pathname,
      );
    if (manageMatch) {
      const [, publicationId, action] = manageMatch;
      if (!publicationIdPattern.test(publicationId)) {
        return new HttpError(404, 'not-found', 'No such tournament.').toResponse();
      }
      const target = action ? `manage/${action}` : 'manage';
      return stub(env, publicationId).fetch(
        new Request(`https://publication/${target}`, {
          method: request.method,
          headers: request.headers,
          body: request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.text(),
        }),
      );
    }

    return new HttpError(404, 'not-found', 'No such QBLive route.').toResponse();
  },
} satisfies ExportedHandler<Env>;

function stub(env: Env, publicationId: string): DurableObjectStub<QblivePublication> {
  return env.QBLIVE_PUBLICATION.get(env.QBLIVE_PUBLICATION.idFromName(publicationId));
}
