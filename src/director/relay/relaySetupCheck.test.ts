import { describe, expect, it, vi } from 'vitest';
import {
  probeRelayScorerOrigin,
  probeRelayStream,
  readRelayDiscoveryView,
  runRelaySetupValidation,
  type RelaySetupValidationInput,
} from './relaySetupCheck';

const baseUrl = 'https://qbtcp-relay-abc.xyz123.workers.dev';
const tournamentId = 'bcdfghjkmnpqrstvwxyz1234';
const managementToken = 'management-credential';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const discoveryBody = {
  protocol: 'QBTCP',
  version: 1,
  capabilities: ['pairing', 'assignment', 'progress', 'result', 'recovery', 'help', 'presence', 'stream'],
  qbj_version: '1',
  stream: {
    endpoint: `/qbtcp/v1/tournaments/${tournamentId}/stream`,
    frames: 1,
    retains_finals: true,
    mirrors_assignment: true,
    replay: ['sequence', 'resync'],
    max_frame_bytes: 1_048_576,
    ticket: false,
  },
};

const healthBody = {
  tournamentId,
  protocolVersion: 1,
  relayRevision: 4,
  lifecycle: 'live',
  capabilities: { stream: true, retainsFinals: true, mirrorsAssignment: true },
  mirror: { director_epoch: 1, revision: 1 },
  replay: { window: 512 },
  storage: { results_unacked: 0 },
  counters: {},
  budget: {},
  time: '2026-09-10T12:00:00.000Z',
};

/** A healthy relay behind every setup step. Overrides replace individual routes. */
function healthyFetch(overrides: Record<string, Response> = {}) {
  const routes: Record<string, Response> = {
    [`${baseUrl}/health`]: jsonResponse(200, { service: 'qbtcp-relay', protocolVersion: 1 }),
    [`${baseUrl}/qbtcp/v1/tournaments/${tournamentId}/discovery`]: jsonResponse(200, discoveryBody),
    [`${baseUrl}/qbtcp/v1/manage/tournaments/${tournamentId}/health`]: jsonResponse(200, healthBody),
    [`${baseUrl}/qbtcp/v1/manage/tournaments/${tournamentId}/mirror`]: jsonResponse(200, { revision: 1 }),
    [`${baseUrl}/qbtcp/v1/tournaments/${tournamentId}/stream`]: jsonResponse(400, {
      error: 'invalid_request',
      message: 'The stream endpoint requires a WebSocket upgrade.',
    }),
    ...overrides,
  };
  const fetchImpl = vi.fn(async (url: string) => {
    const hit = routes[url];
    if (!hit) throw new Error(`unexpected request ${url}`);
    return hit.clone();
  });
  return fetchImpl as unknown as typeof fetch;
}

function input(fetchImpl: typeof fetch): RelaySetupValidationInput {
  return {
    baseUrl,
    tournamentId,
    managementToken,
    mirrorDocument: { director_epoch: 1, revision: 1, rooms: [], sessions: [] },
    fetchImpl,
  };
}

describe('setup validation', () => {
  it('reports ready only after reachability, discovery, management, publication, and stream all pass', async () => {
    const report = await runRelaySetupValidation(input(healthyFetch()));
    expect(report.ready).toBe(true);
    expect(report.steps.map((step) => step.key)).toEqual([
      'reachable',
      'discovery',
      'management',
      'origin',
      'publication',
      'stream',
    ]);
    expect(report.steps.every((step) => step.ok)).toBe(true);
  });

  it('never says ready from a bare HTTP 200: publication must land', async () => {
    const fetchImpl = healthyFetch({
      [`${baseUrl}/qbtcp/v1/manage/tournaments/${tournamentId}/mirror`]: jsonResponse(500, {
        error: 'server_error',
      }),
    });
    const report = await runRelaySetupValidation(input(fetchImpl));
    expect(report.ready).toBe(false);
    expect(report.steps.map((step) => step.key)).toEqual([
      'reachable',
      'discovery',
      'management',
      'origin',
      'publication',
    ]);
    expect(report.steps.at(-1)).toMatchObject({ key: 'publication', ok: false });
  });

  it('never says ready when the realtime probe fails', async () => {
    const fetchImpl = healthyFetch({
      [`${baseUrl}/qbtcp/v1/tournaments/${tournamentId}/stream`]: jsonResponse(404, { error: 'not_found' }),
    });
    const report = await runRelaySetupValidation(input(fetchImpl));
    expect(report.ready).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({ key: 'stream', ok: false });
  });

  it('blocks an incompatible backend version clearly', async () => {
    const fetchImpl = healthyFetch({
      [`${baseUrl}/qbtcp/v1/tournaments/${tournamentId}/discovery`]: jsonResponse(200, {
        ...discoveryBody,
        version: 2,
      }),
    });
    const report = await runRelaySetupValidation(input(fetchImpl));
    expect(report.ready).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({ key: 'discovery', ok: false });
    expect(report.steps.at(-1)?.message).toMatch(/version 2/);
  });

  it('blocks a relay without the stream capability or durability contract', async () => {
    const thin = {
      ...discoveryBody,
      capabilities: ['pairing', 'assignment'],
      stream: { endpoint: 'x', frames: 1, retains_finals: false, mirrors_assignment: false },
    };
    const report = await runRelaySetupValidation(
      input(
        healthyFetch({
          [`${baseUrl}/qbtcp/v1/tournaments/${tournamentId}/discovery`]: jsonResponse(200, thin),
        }),
      ),
    );
    expect(report.ready).toBe(false);
  });

  it('surfaces a refused management credential distinctly', async () => {
    const fetchImpl = healthyFetch({
      [`${baseUrl}/qbtcp/v1/manage/tournaments/${tournamentId}/health`]: jsonResponse(401, {
        error: 'invalid_credential',
      }),
    });
    const report = await runRelaySetupValidation(input(fetchImpl));
    expect(report.ready).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({ key: 'management', ok: false });
    expect(report.steps.at(-1)?.message).toMatch(/credential/i);
  });

  it('short-circuits: an unreachable relay makes exactly one request', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const report = await runRelaySetupValidation(input(fetchImpl));
    expect(report.ready).toBe(false);
    expect(report.steps).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats a conflicted publication as state to reconcile, not success', async () => {
    const fetchImpl = healthyFetch({
      [`${baseUrl}/qbtcp/v1/manage/tournaments/${tournamentId}/mirror`]: jsonResponse(409, {
        error: 'conflict',
        currentRevision: 9,
      }),
    });
    const report = await runRelaySetupValidation(input(fetchImpl));
    expect(report.ready).toBe(false);
    expect(report.steps.at(-1)?.message).toMatch(/newer state/i);
  });
});

describe('stream probe', () => {
  it('accepts the relay upgrade-required answer and rejects a silent 200', async () => {
    const upgradeRequired = healthyFetch();
    expect(
      (
        await probeRelayStream(
          baseUrl,
          tournamentId,
          `/qbtcp/v1/tournaments/${tournamentId}/stream`,
          upgradeRequired,
        )
      ).ok,
    ).toBe(true);

    const silent200 = healthyFetch({
      [`${baseUrl}/qbtcp/v1/tournaments/${tournamentId}/stream`]: jsonResponse(200, { ok: true }),
    });
    const failed = await probeRelayStream(baseUrl, tournamentId, null, silent200);
    expect(failed.ok).toBe(false);
  });

  it('never lets a hostile descriptor redirect the probe', async () => {
    const fetchImpl = healthyFetch();
    const report = await probeRelayStream(baseUrl, tournamentId, 'https://evil.example/stream', fetchImpl);
    expect(report.ok).toBe(true);
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(
      `${baseUrl}/qbtcp/v1/tournaments/${tournamentId}/stream`,
    );
  });
});

describe('scorer-origin probe', () => {
  const originUrl = `${baseUrl}/qbtcp/v1/manage/tournaments/${tournamentId}/health`;

  function originRefusingFetch(): typeof fetch {
    const base = healthyFetch();
    return (async (url: string, init?: RequestInit) => {
      if (url === originUrl) {
        const headers = new Headers(init?.headers);
        if (headers.get('origin') === 'https://qbsheet.com' && !headers.get('authorization')) {
          return jsonResponse(403, {
            error: 'origin_not_allowed',
            message: 'This browser origin is not approved.',
          });
        }
      }
      return (base as (url: string, init?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
  }

  it('fails closed when the relay refuses the scorer browser origin', async () => {
    const report = await runRelaySetupValidation(input(originRefusingFetch()));
    expect(report.ready).toBe(false);
    expect(report.steps.map((step) => step.key)).toEqual([
      'reachable',
      'discovery',
      'management',
      'origin',
    ]);
    expect(report.steps.at(-1)).toMatchObject({ key: 'origin', ok: false });
    expect(report.steps.at(-1)?.message).toMatch(/RELAY_ALLOWED_ORIGINS/);
  });

  it('passes when the origin falls through to the expected credential refusal', async () => {
    const fetchImpl = vi.fn(async (_url: string) => jsonResponse(401, { error: 'invalid_credential' }));
    const step = await probeRelayScorerOrigin(
      baseUrl,
      tournamentId,
      fetchImpl as unknown as typeof fetch,
    );
    expect(step).toMatchObject({ key: 'origin', ok: true });
  });
});

describe('discovery view', () => {
  it('ignores unknown fields and rejects non-QBTCP documents', () => {
    expect(readRelayDiscoveryView({ ...discoveryBody, future: true })?.retainsFinals).toBe(true);
    expect(readRelayDiscoveryView({ protocol: 'HTTP', version: 1 })).toBeNull();
    expect(readRelayDiscoveryView(null)).toBeNull();
  });
});
