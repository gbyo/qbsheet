/**
 * The APNs transport probe.
 *
 * A tiny Worker whose only job is to answer one question with evidence:
 *
 * > Can a Cloudflare Worker complete Apple's broadcast **channel-management** requests, which live
 * > on `api-manage-broadcast.push.apple.com:2196` — a non-standard port, over HTTP/2?
 *
 * The prompt for QBSheet Live is explicit that this be measured before the production push service
 * is built around it. Deploy this Worker, `POST /probe` with a `.p8`, and read the report.
 *
 * # Reading the result
 *
 * The distinction that matters is `transportError` versus `status`.
 *
 * - `transportError` set  → the request never reached Apple. Port, TLS, or protocol. This is the
 *   failure that would force the channel manager onto another platform.
 * - `status` set to anything, including `403 ExpiredProviderToken` or `400 BadRequest` → Cloudflare
 *   reached Apple, spoke HTTP/2 on port 2196, and got an APNs answer. The transport works; the
 *   remaining problem is credentials, which is not an architectural problem.
 *
 * # Safety
 *
 * The `.p8` is read from the request body and never stored, never logged, and never echoed. This
 * Worker is a development tool: deploy it, run the probe, delete it. The production gateway keeps
 * the key in Worker secrets and mints tokens inside a coordinator Durable Object.
 */

import {
  APNS_BROADCAST_PAYLOAD_LIMIT,
  apnsHosts,
  broadcastPayloadBytes,
  createBroadcastChannel,
  createProviderToken,
  deleteBroadcastChannel,
  listBroadcastChannels,
  readBroadcastChannel,
  sendBroadcast,
  type ApnsEnvironment,
} from './apns';

interface ProbeRequest {
  keyId: string;
  teamId: string;
  privateKeyPem: string;
  bundleId: string;
  environment?: ApnsEnvironment;
  /** Skip the send step, for a probe that only wants to know about channel lifecycle. */
  skipSend?: boolean;
}

interface Step {
  step: string;
  ok: boolean;
  status: number;
  reason: string | null;
  transportError: string | null;
  elapsedMs: number;
  note?: string;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({
        service: 'qblive-push-prototype',
        purpose:
          'Measure whether Cloudflare Workers can reach the APNs broadcast channel-management endpoint.',
        endpoints: { probe: 'POST /probe', reachability: 'GET /reachability' },
        hosts: apnsHosts,
      });
    }

    /**
     * Transport-only reachability, with no credentials at all.
     *
     * Answers the architectural question on its own: an unauthenticated request to the management
     * host is expected to fail *with an APNs status*, and an APNs status proves that Cloudflare
     * opened an HTTP/2 TLS connection to port 2196 and got a reply. A `transportError` instead
     * means the port is blocked.
     */
    if (url.pathname === '/reachability') {
      const environment = (url.searchParams.get('environment') as ApnsEnvironment) ?? 'production';
      const hosts = apnsHosts[environment] ?? apnsHosts.production;
      const results: Step[] = [];
      for (const [name, host, path] of [
        ['send-host', hosts.send, '/4/broadcasts/apps/com.example.probe'],
        ['manage-host', hosts.manage, '/1/apps/com.example.probe/channels'],
      ] as const) {
        const started = Date.now();
        try {
          const response = await fetch(`${host}${path}`, {
            method: 'GET',
            headers: { 'apns-request-id': crypto.randomUUID() },
          });
          const text = await response.text();
          results.push({
            step: name,
            ok: true,
            status: response.status,
            reason: text.slice(0, 256) || null,
            transportError: null,
            elapsedMs: Date.now() - started,
            note: 'Reached Apple. Any HTTP status here proves the port and protocol work.',
          });
        } catch (error) {
          results.push({
            step: name,
            ok: false,
            status: 0,
            reason: null,
            transportError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            elapsedMs: Date.now() - started,
            note: 'Did NOT reach Apple. This is the failure that would move the channel manager off Cloudflare.',
          });
        }
      }
      return json({
        environment,
        hosts,
        results,
        verdict: results.every((result) => result.transportError === null)
          ? 'Cloudflare reached both APNs hosts, including the non-standard management port.'
          : 'At least one APNs host was unreachable from this Worker.',
      });
    }

    if (url.pathname === '/probe' && request.method === 'POST') {
      let body: ProbeRequest;
      try {
        body = (await request.json()) as ProbeRequest;
      } catch {
        return json({ error: 'bad-request', message: 'Send a JSON body.' }, 400);
      }
      if (!body.keyId || !body.teamId || !body.privateKeyPem || !body.bundleId) {
        return json(
          { error: 'bad-request', message: 'keyId, teamId, privateKeyPem and bundleId are required.' },
          400,
        );
      }
      const environment: ApnsEnvironment = body.environment ?? 'sandbox';
      const steps: Step[] = [];

      let providerToken: string;
      const tokenStarted = Date.now();
      try {
        providerToken = await createProviderToken({
          keyId: body.keyId,
          teamId: body.teamId,
          privateKeyPem: body.privateKeyPem,
        });
        steps.push({
          step: 'mint-provider-token',
          ok: true,
          status: 200,
          reason: null,
          transportError: null,
          elapsedMs: Date.now() - tokenStarted,
          note: 'ES256 signed with WebCrypto inside workerd. No Node crypto, no third-party JWT library.',
        });
      } catch (error) {
        return json({
          environment,
          steps: [
            {
              step: 'mint-provider-token',
              ok: false,
              status: 0,
              reason: null,
              transportError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
              elapsedMs: Date.now() - tokenStarted,
              note: 'The .p8 could not be imported. Send the PEM exactly as the file contains it.',
            },
          ],
        });
      }

      const created = await createBroadcastChannel({
        environment,
        bundleId: body.bundleId,
        providerToken,
      });
      steps.push({
        step: 'create-channel',
        ok: created.ok,
        status: created.status,
        reason: created.reason,
        transportError: created.transportError,
        elapsedMs: created.elapsedMs,
        note: `POST ${apnsHosts[environment].manage}/1/apps/${body.bundleId}/channels`,
      });

      const channelId = created.channelId;
      if (channelId) {
        const read = await readBroadcastChannel({
          environment,
          bundleId: body.bundleId,
          providerToken,
          channelId,
        });
        steps.push({
          step: 'read-channel',
          ok: read.ok,
          status: read.status,
          reason: read.reason,
          transportError: read.transportError,
          elapsedMs: read.elapsedMs,
        });

        const listed = await listBroadcastChannels({ environment, bundleId: body.bundleId, providerToken });
        steps.push({
          step: 'list-channels',
          ok: listed.ok,
          status: listed.status,
          reason: listed.reason,
          transportError: listed.transportError,
          elapsedMs: listed.elapsedMs,
          note: 'Used by the channel-budget reconciler to find channels the gateway lost track of.',
        });

        if (!body.skipSend) {
          const contentState = sampleShardState();
          const sent = await sendBroadcast({
            environment,
            bundleId: body.bundleId,
            providerToken,
            channelId,
            event: 'update',
            contentState,
            expiration: Math.floor(Date.now() / 1000) + 3600,
            priority: 5,
          });
          steps.push({
            step: 'send-broadcast',
            ok: sent.ok,
            status: sent.status,
            reason: sent.reason,
            transportError: sent.transportError,
            elapsedMs: sent.elapsedMs,
            note: `Payload ${broadcastPayloadBytes(contentState)} of ${APNS_BROADCAST_PAYLOAD_LIMIT} bytes. Standard port 443.`,
          });
        }

        const deleted = await deleteBroadcastChannel({
          environment,
          bundleId: body.bundleId,
          providerToken,
          channelId,
        });
        steps.push({
          step: 'delete-channel',
          ok: deleted.ok,
          status: deleted.status,
          reason: deleted.reason,
          transportError: deleted.transportError,
          elapsedMs: deleted.elapsedMs,
          note: 'Channels count against a 10,000 global limit whether or not anybody is subscribed.',
        });
      }

      const reachedApple = steps
        .filter((step) => step.step !== 'mint-provider-token')
        .every((step) => step.transportError === null);
      return json({
        environment,
        // The channel id is not secret, but there is no reason to return it either.
        steps,
        verdict: reachedApple
          ? 'Cloudflare Workers can speak to both APNs surfaces, including channel management on the non-standard port.'
          : 'A request did not reach Apple. Move channel management to another serverless platform; leave everything else on Cloudflare.',
      });
    }

    return json({ error: 'not-found', message: 'No such route.' }, 404);
  },
} satisfies ExportedHandler;

/** A realistic eight-team shard, so the reported payload size means something. */
function sampleShardState() {
  return {
    r: 41,
    t: [
      { i: 0, m: 1, o: 1, s: 180, x: 135, u: 13, rm: '104', rd: 2 },
      { i: 1, m: 1, o: 0, s: 135, x: 180, u: 13, rm: '104', rd: 2 },
      { i: 2, m: 0, o: 3, rm: '212', rd: 2, st: 1757088000 },
      { i: 3, m: 0, o: 2, rm: '212', rd: 2, st: 1757088000 },
      { i: 4, m: 2, o: 5, s: 240, x: 205, rd: 1 },
      { i: 5, m: 2, o: 4, s: 205, x: 240, rd: 1 },
      { i: 6, m: 3 },
      { i: 7, m: 3 },
    ],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
