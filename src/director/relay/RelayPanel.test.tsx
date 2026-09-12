import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfirmProvider } from '../components/Dialog';
import { RelayPanel, type RelayPanelLan, type RelayPanelStore } from './RelayPanel';
import type { RelayConfig } from './relayConfig';

const baseUrl = 'https://qbtcp-relay-abc.xyz123.workers.dev';
const tournamentId = 'bcdfghjkmnpqrstvwxyz1234';

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
  stream: { endpoint: 'x', frames: 1, retains_finals: true, mirrors_assignment: true },
};

const healthBody = {
  tournamentId,
  protocolVersion: 1,
  relayRevision: 9,
  lifecycle: 'live',
  mirror: { director_epoch: 1, revision: 1 },
  storage: { results_unacked: 0, help_open: 0 },
  counters: {},
  budget: {
    measured: { metered_requests_estimate: 10, rows_written_estimate: 20, rows_per_accepted_progress: 1 },
    headroom: { metered_requests_share: 0.01, rows_written_share: 0.02 },
  },
  time: '2026-09-10T12:00:00.000Z',
};

function installKeychain() {
  const secrets = new Map<string, string>();
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case 'director_probe_relay_credential_store':
        return null;
      case 'director_store_relay_credential':
        secrets.set(args?.tournamentId as string, args?.token as string);
        return null;
      case 'director_read_relay_credential':
        return secrets.get(args?.tournamentId as string) ?? null;
      case 'director_forget_relay_credential':
        secrets.delete(args?.tournamentId as string);
        return null;
      case 'director_probe_relay_scorer_origin':
        return {
          status: 204,
          allowOrigin: 'https://qbsheet.com',
          allowMethods: 'GET, POST, OPTIONS',
          allowHeaders: 'content-type, x-yf-room-token, x-yf-device-id',
        };
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
  window.__TAURI_INTERNALS__ = { invoke };
  return { secrets, invoke };
}

function memoryStore(initial: RelayConfig | null = null): RelayPanelStore & { saved: RelayConfig[] } {
  let current = initial;
  const saved: RelayConfig[] = [];
  return {
    saved,
    load: () => current,
    save: (config) => {
      current = config;
      saved.push(config);
    },
    clear: () => {
      current = null;
    },
  };
}

/** Every relay route behind setup + status, unless a test overrides one. */
function relayFetch(overrides: Record<string, Response> = {}) {
  const routes: Record<string, () => Response> = {
    [`${baseUrl}/health`]: () => jsonResponse(200, { service: 'qbtcp-relay', protocolVersion: 1 }),
    [`${baseUrl}/qbtcp/v1/manage/claim`]: () =>
      jsonResponse(200, { managementToken: 'fresh-management-credential', tournamentId }),
    [`${baseUrl}/qbtcp/v1/tournaments/${tournamentId}/discovery`]: () => jsonResponse(200, discoveryBody),
    [`${baseUrl}/qbtcp/v1/manage/tournaments/${tournamentId}/health`]: () => jsonResponse(200, healthBody),
    [`${baseUrl}/qbtcp/v1/manage/tournaments/${tournamentId}/mirror`]: () =>
      jsonResponse(200, { revision: 1 }),
    [`${baseUrl}/qbtcp/v1/tournaments/${tournamentId}/stream`]: () =>
      jsonResponse(400, {
        error: 'invalid_request',
        message: 'The stream endpoint requires a WebSocket upgrade.',
      }),
    [`${baseUrl}/qbtcp/v1/manage/tournaments/${tournamentId}/results?state=unacked&limit=128`]: () =>
      jsonResponse(200, { results: [] }),
    [`${baseUrl}/qbtcp/v1/manage/tournaments/${tournamentId}/help?state=open`]: () =>
      jsonResponse(200, { requests: [] }),
    ...Object.fromEntries(Object.entries(overrides).map(([url, response]) => [url, () => response.clone()])),
  };
  return vi.fn(async (url: string) => {
    const hit = routes[url];
    if (!hit) throw new Error(`unexpected request ${url}`);
    return hit();
  }) as unknown as typeof fetch;
}

const lan: RelayPanelLan = { available: true, address: '192.168.1.24:3000', permissionIssue: null };

afterEach(() => {
  cleanup();
  delete window.__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
});

function renderPanel(options: {
  store?: RelayPanelStore;
  lan?: typeof lan;
  qbliveOrigin?: string | null;
  directorTournamentId?: string;
}) {
  const onAnnounce = vi.fn();
  const store = options.store ?? memoryStore();
  render(
    <ConfirmProvider>
      <RelayPanel
        lan={options.lan ?? lan}
        qbliveOrigin={options.qbliveOrigin ?? null}
        store={store}
        directorTournamentId={options.directorTournamentId}
        onAnnounce={onAnnounce}
      />
    </ConfirmProvider>,
  );
  return { onAnnounce, store };
}

describe('Internet QBTCP setup', () => {
  it('claims, validates every step, and reports ready with the relay as primary address', async () => {
    installKeychain();
    vi.stubGlobal('fetch', relayFetch());
    // The mount-check effect must not chase the config object it refreshes: every
    // refresh persists a new `lastContactAt`, so an effect depending on the live
    // config re-renders forever (React's "Maximum update depth exceeded").
    const renderLoop: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      renderLoop.push(args);
    };
    try {
      const { onAnnounce, store } = renderPanel({ directorTournamentId: 'local-tournament-1' });

      fireEvent.change(screen.getByLabelText('Relay address'), { target: { value: baseUrl } });
      fireEvent.change(screen.getByLabelText('Tournament id'), { target: { value: tournamentId } });
      fireEvent.change(screen.getByLabelText('One-time setup secret'), {
        target: { value: 'one-time-secret' },
      });
      fireEvent.click(screen.getByRole('button', { name: /claim and validate/i }));

      await waitFor(() => {
        expect(screen.getByTestId('relay-panel-status')).toBeInTheDocument();
      });
      expect(screen.getByText(/Primary scoring address/)).toBeInTheDocument();
      expect(screen.getByTestId('relay-panel-status').textContent).toContain(baseUrl);
      // The healthy summary sits inside the collapsed diagnostics; the warning test below
      // covers LAN fallback where it is expanded by default.
      expect(onAnnounce).toHaveBeenCalledWith(expect.stringMatching(/ready/i));
      expect((store as unknown as { saved: RelayConfig[] }).saved.at(-1)).toMatchObject({
        enabled: true,
        baseUrl,
        tournamentId,
        directorTournamentId: 'local-tournament-1',
      });
      // The setup secret field unmounted with the wizard; nothing renders it.
      expect(screen.queryByLabelText('One-time setup secret')).toBeNull();
    } finally {
      console.error = originalError;
    }
    expect(renderLoop.flat().join('\n')).not.toMatch(/Maximum update depth exceeded/);
  });

  it('shows validation failures instead of reporting ready', async () => {
    installKeychain();
    vi.stubGlobal(
      'fetch',
      relayFetch({
        [`${baseUrl}/qbtcp/v1/tournaments/${tournamentId}/stream`]: jsonResponse(404, { error: 'not_found' }),
      }),
    );
    renderPanel({});

    fireEvent.change(screen.getByLabelText('Relay address'), { target: { value: baseUrl } });
    fireEvent.change(screen.getByLabelText('Tournament id'), { target: { value: tournamentId } });
    fireEvent.change(screen.getByLabelText('One-time setup secret'), {
      target: { value: 'one-time-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: /claim and validate/i }));

    await waitFor(() => {
      expect(screen.getByText(/validation did not pass/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('relay-panel-status')).toBeNull();
  });

  it('requires the desktop app in the browser preview and spends no setup secret', async () => {
    const fetchImpl = relayFetch();
    vi.stubGlobal('fetch', fetchImpl);
    renderPanel({});
    expect(screen.getByText(/desktop app required/i)).toBeInTheDocument();
    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
  });

  it('explains tournament ownership and the failure budget during setup', () => {
    installKeychain();
    vi.stubGlobal('fetch', relayFetch());
    renderPanel({});
    expect(screen.getByText(/controlled by the tournament/i)).toBeInTheDocument();
    expect(screen.getByText(/same Workers Free request budget/i)).toBeInTheDocument();
  });
});

describe('Internet QBTCP status and disable', () => {
  const configured: RelayConfig = {
    enabled: true,
    baseUrl,
    tournamentId,
    keychainAccount: tournamentId,
    customDomain: false,
    claimedAt: '2026-09-10T11:00:00.000Z',
    lastContactAt: null,
  };

  it('warns when the relay is unreachable while keeping LAN fallback visible', async () => {
    const { secrets } = installKeychain();
    secrets.set(tournamentId, 'stored-management-credential');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    );
    renderPanel({ store: memoryStore(configured) });

    await waitFor(() => {
      expect(screen.getByText(/relay unreachable/i)).toBeInTheDocument();
    });
    expect(screen.getByTestId('relay-panel-status').textContent).toContain('Available · 192.168.1.24:3000');
  });

  it('names an unknown tournament instead of reporting the relay unreachable', async () => {
    const { secrets } = installKeychain();
    secrets.set(tournamentId, 'stored-management-credential');
    vi.stubGlobal(
      'fetch',
      relayFetch({
        [`${baseUrl}/qbtcp/v1/manage/tournaments/${tournamentId}/health`]: jsonResponse(404, {
          error: 'not-found',
          message: 'No such tournament.',
        }),
      }),
    );
    renderPanel({ store: memoryStore(configured) });

    await waitFor(() => {
      expect(screen.getByText(/relay tournament unknown/i)).toBeInTheDocument();
    });
    // Twice: once as the status warning, once as the last-sync error line. Neither blames the network.
    expect(screen.getAllByText(/no tournament with this id/i)).toHaveLength(2);
    expect(screen.queryByText(/relay unreachable/i)).toBeNull();
  });

  it('warns when LAN fallback is down and when a QBLive Worker shares the account', async () => {
    installKeychain();
    vi.stubGlobal('fetch', relayFetch());
    renderPanel({
      store: memoryStore(configured),
      lan: { available: false, address: null, permissionIssue: null },
      qbliveOrigin: `${baseUrl}/qblive/v1`,
    });

    await waitFor(() => {
      expect(screen.getByText(/LAN fallback unavailable/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/shares its Cloudflare account with a QBLive Worker/i)).toBeInTheDocument();
  });

  it('disables locally: LAN continuity is promised and the pointer is kept but inert', async () => {
    installKeychain();
    vi.stubGlobal('fetch', relayFetch());
    const { onAnnounce, store } = renderPanel({ store: memoryStore(configured) });

    await waitFor(() => {
      expect(screen.getByTestId('relay-panel-status')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^disable$/i }));

    await waitFor(() => {
      expect(screen.getByTestId('relay-panel-setup')).toBeInTheDocument();
    });
    expect(onAnnounce).toHaveBeenCalledWith(expect.stringMatching(/LAN QBTCP are unaffected/i));
    expect((store as unknown as { saved: RelayConfig[] }).saved.at(-1)).toMatchObject({ enabled: false });
  });

  it('refuses destroy while unacknowledged finals remain, without asking for confirm', async () => {
    const { secrets } = installKeychain();
    secrets.set(tournamentId, 'stored-management-credential');
    const fetchImpl = relayFetch({
      [`${baseUrl}/qbtcp/v1/manage/tournaments/${tournamentId}/results?state=unacked&limit=128`]:
        jsonResponse(200, {
          results: [{ result_id: 'final-1', fingerprint: 'abc' }],
        }),
    });
    vi.stubGlobal('fetch', fetchImpl);
    const { onAnnounce } = renderPanel({ store: memoryStore(configured) });

    await waitFor(() => {
      expect(screen.getByTestId('relay-panel-status')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /destroy relay/i }));

    await waitFor(() => {
      expect(screen.getByText(/still holds 1 final/i)).toBeInTheDocument();
    });
    // No confirm dialog appeared: the planner refused before asking.
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(onAnnounce).toHaveBeenCalledWith(expect.objectContaining({}));
  });
});
