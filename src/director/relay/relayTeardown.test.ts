import { describe, expect, it, vi } from 'vitest';
import {
  destroyRelayTournament,
  fetchRelayRetention,
  planRelayDestroy,
  relayDisablePromise,
  RelayTeardownError,
} from './relayTeardown';

const baseUrl = 'https://qbtcp-relay-abc.xyz123.workers.dev';
const tournamentId = 'bcdfghjkmnpqrstvwxyz1234';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('teardown planner', () => {
  it('refuses an unsafe destroy while the relay holds finals Director has not ingested', () => {
    const plan = planRelayDestroy({ resultsUnacked: 3, helpOpen: 0, resultsTruncated: false });
    expect(plan.kind).toBe('destroy-blocked');
    if (plan.kind === 'destroy-blocked') {
      expect(plan.reason).toMatch(/3 finals/);
      expect(plan.required.join('\n')).toMatch(/Export the unacknowledged finals/);
    }
  });

  it('reports a lower bound honestly when the retention page fills up', () => {
    const plan = planRelayDestroy({ resultsUnacked: 128, helpOpen: 0, resultsTruncated: true });
    if (plan.kind === 'destroy-blocked') {
      expect(plan.reason).toMatch(/128 or more finals/);
    } else {
      expect.unreachable('a full retention page must block');
    }
  });

  it('allows destroy after a reviewed export-plus-override, and after a clean sync', () => {
    const overridden = planRelayDestroy(
      { resultsUnacked: 2, helpOpen: 1, resultsTruncated: false },
      { exported: true, confirmed: true },
    );
    expect(overridden.kind).toBe('destroy-allowed');

    const clean = planRelayDestroy({ resultsUnacked: 0, helpOpen: 0, resultsTruncated: false });
    expect(clean).toEqual({ kind: 'destroy-allowed', advisories: [] });
  });

  it('advises on open help without blocking on it', () => {
    const plan = planRelayDestroy({ resultsUnacked: 0, helpOpen: 2, resultsTruncated: false });
    expect(plan.kind).toBe('destroy-allowed');
    if (plan.kind === 'destroy-allowed') {
      expect(plan.advisories.join('\n')).toMatch(/2 help requests/);
    }
  });

  it('disabling promises LAN continuity and leaves remote state alone', () => {
    expect(relayDisablePromise).toMatch(/LAN QBTCP keep serving/i);
    expect(relayDisablePromise).toMatch(/untouched|keeps whatever it retains/i);
  });
});

describe('retention reads and destroy execution', () => {
  it('counts retained finals and open help without pulling payloads', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/results')) {
        return jsonResponse(200, { results: [{ result_id: 'a' }, { result_id: 'b' }] });
      }
      return jsonResponse(200, { requests: [] });
    }) as unknown as typeof fetch;
    const retention = await fetchRelayRetention(baseUrl, tournamentId, 'credential', fetchImpl);
    expect(retention).toEqual({ resultsUnacked: 2, helpOpen: 0, resultsTruncated: false });
    // Counted from list shapes — the QBJ bodies were transferred but never stored or asserted.
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toContain('state=unacked');
  });

  it('refuses to execute a blocked plan even when called directly', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { deleted: true })) as unknown as typeof fetch;
    const plan = planRelayDestroy({ resultsUnacked: 1, helpOpen: 0, resultsTruncated: false });
    await expect(
      destroyRelayTournament(baseUrl, tournamentId, 'credential', plan, fetchImpl),
    ).rejects.toBeInstanceOf(RelayTeardownError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('executes an allowed plan with the management credential', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { deleted: true })) as unknown as typeof fetch;
    const plan = planRelayDestroy({ resultsUnacked: 0, helpOpen: 0, resultsTruncated: false });
    await destroyRelayTournament(baseUrl, tournamentId, 'credential', plan, fetchImpl);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${baseUrl}/qbtcp/v1/manage/tournaments/${tournamentId}`);
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer credential');
  });

  it('surfaces a refused credential and an unreachable relay distinctly', async () => {
    const refused = vi.fn(async () => jsonResponse(401, {})) as unknown as typeof fetch;
    await expect(fetchRelayRetention(baseUrl, tournamentId, 'dead', refused)).rejects.toThrow(/refused/);
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(fetchRelayRetention(baseUrl, tournamentId, 'credential', down)).rejects.toThrow(
      /could not be reached/,
    );
  });
});
