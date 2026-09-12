/**
 * Internet QBTCP operator surface: setup wizard, status, disable, and diagnostics.
 *
 * # What this panel owns
 *
 * The deployment UX from #774: guided claim of a tournament-owned relay, setup validation
 * before anything says "ready," the compact operational status, safe disable/destroy, and a
 * credential-safe diagnostics view. It deliberately does not own the ongoing relay
 * synchronization — that is #773's engine — nor the scorer transport (#772).
 *
 * # Where the pointer lives
 *
 * The claimed relay pointer (origin, tournament id — never the credential) persists through
 * a `RelayPanelStore`. The default is `localStorage`; the relay sync engine (#773) is
 * expected to move the pointer into the tournament document next to its cursor state, at
 * which point this panel takes a document-backed store instead. The seam is the interface,
 * not the storage.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Callout, Diagnostics, Field, Panel, TextInput, useConfirm } from '../components';
import { errorNotice, type AnnounceInput } from '../notices';
import {
  isRelayTournamentId,
  isWorkersDevOrigin,
  normalizeRelayBaseUrl,
  relayFailureBudgetWarning,
  relayOwnershipExplainer,
  relayQbliveRecommendation,
  relaySetupTokenHint,
  unclaimedRelayConfig,
  type RelayConfig,
} from './relayConfig';
import {
  claimRelayBackend,
  forgetRelayCredential,
  hasDurableRelayCredentialStore,
  readRelayCredential,
  RelayClaimError,
  rotateRelayCredential,
  storeRelayCredential,
} from './relayCredentials';
import { runRelaySetupValidation, type RelaySetupReport } from './relaySetupCheck';
import {
  deriveRelayStatus,
  fetchRelayManagementHealth,
  healthViewOf,
  RelayHealthError,
  type RelayConnection,
  type RelayManagementHealth,
} from './relayStatus';
import { buildRelayDiagnostics } from './relayDiagnostics';
import {
  destroyRelayTournament,
  fetchRelayRetention,
  planRelayDestroy,
  RelayTeardownError,
} from './relayTeardown';

export interface RelayPanelStore {
  load(): RelayConfig | null;
  save(config: RelayConfig): void;
  clear(): void;
}

const defaultStoreKey = 'qbsheet.internet-qbtcp';

function readStoredConfig(key: string): RelayConfig | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RelayConfig>;
    if (typeof parsed.baseUrl !== 'string' || typeof parsed.tournamentId !== 'string') return null;
    if (!isRelayTournamentId(parsed.tournamentId)) return null;
    return { ...unclaimedRelayConfig(), ...parsed, keychainAccount: parsed.tournamentId };
  } catch {
    return null;
  }
}

/** localStorage-backed pointer store. Holds the relay address and id — never a credential. */
export function localStorageRelayPanelStore(key = defaultStoreKey): RelayPanelStore {
  return {
    load: () => readStoredConfig(key),
    save: (config) => {
      try {
        localStorage?.setItem(
          key,
          JSON.stringify({
            enabled: config.enabled,
            baseUrl: config.baseUrl,
            tournamentId: config.tournamentId,
            directorTournamentId: config.directorTournamentId,
            keychainAccount: config.tournamentId,
            customDomain: config.customDomain,
            claimedAt: config.claimedAt,
            lastContactAt: config.lastContactAt,
          }),
        );
      } catch {
        // A full or blocked store must not fail setup: the session still works.
      }
    },
    clear: () => {
      try {
        localStorage?.removeItem(key);
      } catch {
        // Clearing is best-effort; forgetting the keychain credential is the security step.
      }
    },
  };
}

export interface RelayPanelLan {
  available: boolean;
  address: string | null;
  permissionIssue: string | null;
}

const stepLabels: Record<string, string> = {
  reachable: 'Relay reachable over HTTPS',
  discovery: 'Protocol and capabilities',
  management: 'Management connection',
  origin: 'Scorer browser origin',
  publication: 'Initial state publication',
  stream: 'Realtime endpoint',
};

function bootstrapMirror() {
  // A fresh claim holds no rooms yet; setup proves the management credential can write.
  // The sync engine supersedes this under (director_epoch, revision) fencing.
  return { director_epoch: 1, revision: 1, rooms: [], sessions: [] };
}

export function RelayPanel({
  lan,
  qbliveOrigin = null,
  roomsMirrored = null,
  store,
  directorTournamentId,
  onPointerChange,
  onAnnounce,
}: {
  lan: RelayPanelLan;
  qbliveOrigin?: string | null;
  roomsMirrored?: { mirrored: number; total: number } | null;
  store?: RelayPanelStore;
  directorTournamentId?: string;
  /** Structural pointer changes (claimed, disabled, destroyed) for parents showing pairings. */
  onPointerChange?: (config: RelayConfig | null) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const [panelStore] = useState<RelayPanelStore>(() => store ?? localStorageRelayPanelStore());
  // Mount-time snapshot for the automatic health check below. Depending on the live
  // `config` object re-runs the check after every refresh, because refresh persists a
  // new `lastContactAt` (hence a new object identity) — an infinite render loop.
  // The pointer (address and id — never the credential) loads synchronously with the panel.
  const [initialConfig] = useState<RelayConfig | null>(() => panelStore.load());
  const [config, setConfig] = useState<RelayConfig | null>(initialConfig);
  const [baseUrl, setBaseUrl] = useState('');
  const [tournamentId, setTournamentId] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<RelaySetupReport | null>(null);
  const [health, setHealth] = useState<RelayManagementHealth | null>(null);
  const [connection, setConnection] = useState<RelayConnection>('unconfigured');
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const confirm = useConfirm();

  const refresh = useCallback(
    async (active: RelayConfig) => {
      setBusy(true);
      setLastSyncError(null);
      try {
        const credential = await readRelayCredential(active.tournamentId);
        if (!credential) {
          setConnection('credential-invalid');
          setHealth(null);
          return;
        }
        const next = await fetchRelayManagementHealth(active.baseUrl, active.tournamentId, credential);
        setHealth(next);
        setConnection('connected');
        const contacted = { ...active, lastContactAt: new Date().toISOString() };
        setConfig(contacted);
        panelStore.save(contacted);
        setLastSyncAt(contacted.lastContactAt);
      } catch (reason) {
        setHealth(null);
        if (reason instanceof RelayHealthError) {
          if (reason.code === 'credential-invalid') setConnection('credential-invalid');
          else if (reason.code === 'unsupported') setConnection('unsupported');
          else if (reason.code === 'unclaimed') setConnection('unclaimed');
          else setConnection('unreachable');
          setLastSyncError(reason.message);
        } else {
          setConnection('unreachable');
          setLastSyncError(reason instanceof Error ? reason.message : 'The relay could not be reached.');
        }
      } finally {
        setBusy(false);
      }
    },
    [panelStore],
  );

  // A saved, enabled relay checks itself on mount; every later check is an explicit action
  // (setup, Check now, rotate). The check runs inside a closure — never as a synchronous
  // setState in the effect body — following the native server status poll.
  useEffect(() => {
    if (!initialConfig?.enabled) return;
    let cancelled = false;
    const check = () => {
      if (!cancelled) void refresh(initialConfig);
    };
    check();
    return () => {
      cancelled = true;
    };
  }, [initialConfig, refresh]);

  const submitSetup = async () => {
    if (busy) return;
    setError(null);
    setReport(null);
    const normalized = normalizeRelayBaseUrl(baseUrl);
    if (!normalized.ok) {
      setError(normalized.error);
      return;
    }
    const trimmedId = tournamentId.trim();
    if (!isRelayTournamentId(trimmedId)) {
      setError('Enter the 24-character tournament id from deployment.');
      return;
    }
    setBusy(true);
    try {
      let managementToken: string;
      try {
        const claimed = await claimRelayBackend({
          baseUrl: normalized.value,
          tournamentId: trimmedId,
          setupToken,
        });
        await storeRelayCredential(trimmedId, claimed.managementToken);
        managementToken = claimed.managementToken;
      } catch (reason) {
        // A claim that succeeded but whose validation then failed leaves the relay claimed
        // with the credential already in this machine's keychain. Retrying setup must
        // continue with the stored credential, not fail on the consumed setup secret — and
        // when no stored credential exists (another Director claimed it), the 403 stands.
        if (reason instanceof RelayClaimError && /already been claimed/.test(reason.message)) {
          const stored = await readRelayCredential(trimmedId).catch(() => null);
          if (!stored) throw reason;
          managementToken = stored;
        } else {
          throw reason;
        }
      }
      // The setup secret has served its single purpose; drop it from state immediately.
      setSetupToken('');
      const validation = await runRelaySetupValidation({
        baseUrl: normalized.value,
        tournamentId: trimmedId,
        managementToken,
        mirrorDocument: bootstrapMirror(),
      });
      setReport(validation);
      if (!validation.ready) {
        setError('Setup validation did not pass. The relay is claimed, but Internet QBTCP is not ready.');
        return;
      }
      const next: RelayConfig = {
        enabled: true,
        baseUrl: normalized.value,
        tournamentId: trimmedId,
        ...(directorTournamentId ? { directorTournamentId } : {}),
        keychainAccount: trimmedId,
        customDomain: !isWorkersDevOrigin(normalized.value),
        claimedAt: new Date().toISOString(),
        lastContactAt: new Date().toISOString(),
      };
      setConfig(next);
      panelStore.save(next);
      onPointerChange?.(next);
      setLastSyncAt(next.lastContactAt);
      // Explicit first check: the mount effect above does not re-run for a relay that was
      // claimed after mount, so setup loads the status surface itself.
      await refresh(next);
      onAnnounce('Internet QBTCP is ready. Pairing links now use the tournament relay.');
    } catch (reason) {
      setError(
        reason instanceof RelayClaimError || reason instanceof Error
          ? reason.message
          : 'Internet QBTCP setup failed.',
      );
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!config) return;
    const next = { ...config, enabled: false };
    setConfig(next);
    panelStore.save(next);
    onPointerChange?.(next);
    setConnection('unconfigured');
    setHealth(null);
    setLastSyncError(null);
    onAnnounce('Internet QBTCP disabled. Local and LAN QBTCP are unaffected.');
  };

  const rotate = async () => {
    if (!config || busy) return;
    setBusy(true);
    setError(null);
    try {
      const current = await readRelayCredential(config.tournamentId);
      if (!current) throw new RelayClaimError('No stored relay credential was found.');
      await rotateRelayCredential({
        baseUrl: config.baseUrl,
        tournamentId: config.tournamentId,
        currentToken: current,
      });
      onAnnounce('Relay management credential rotated.');
      await refresh(config);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Credential rotation failed.');
    } finally {
      setBusy(false);
    }
  };

  const destroy = async () => {
    if (!config || busy) return;
    setBusy(true);
    setError(null);
    try {
      const credential = await readRelayCredential(config.tournamentId);
      if (!credential) throw new RelayTeardownError('No stored relay credential was found.');
      const retention = await fetchRelayRetention(config.baseUrl, config.tournamentId, credential);
      const plan = planRelayDestroy(retention);
      if (plan.kind === 'destroy-blocked') {
        onAnnounce(errorNotice(plan.reason));
        setError(`${plan.reason} ${plan.required.join(' ')}`);
        return;
      }
      const confirmed = await confirm({
        title: 'Destroy the tournament relay?',
        body: 'Director stops syncing, and the relay deployment loses its rooms, retained finals, and credentials.',
        consequence:
          plan.advisories.length > 0
            ? plan.advisories.join(' ')
            : 'No unacknowledged finals remain on the relay.',
        confirmLabel: 'Destroy relay tournament',
      });
      if (!confirmed) return;
      await destroyRelayTournament(config.baseUrl, config.tournamentId, credential, plan);
      await forgetRelayCredential(config.tournamentId);
      panelStore.clear();
      setConfig(null);
      onPointerChange?.(null);
      setHealth(null);
      setReport(null);
      setConnection('unconfigured');
      onAnnounce('Tournament relay destroyed. Local and LAN QBTCP are unaffected.');
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Destroying the relay failed.';
      setError(message);
      onAnnounce(errorNotice(message));
    } finally {
      setBusy(false);
    }
  };

  if (!config?.enabled) {
    return (
      <Panel
        title="Internet QBTCP"
        description="Score over the internet through a tournament-owned relay, with LAN fallback."
        data-testid="relay-panel-setup"
      >
        <Callout tone="info">{relayOwnershipExplainer}</Callout>
        {!hasDurableRelayCredentialStore() ? (
          <Callout tone="info" title="Desktop app required">
            Internet QBTCP setup needs the Director desktop app: the management credential is kept in the
            operating-system keychain, which the browser preview does not have.
          </Callout>
        ) : (
          <>
            <Field label="Relay address" hint="The workers.dev URL from Cloudflare. No custom domain needed.">
              <TextInput
                type="url"
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  setError(null);
                }}
                placeholder="https://…workers.dev"
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field label="Tournament id" hint="The 24-character relay id from deployment.">
              <TextInput
                value={tournamentId}
                onChange={(event) => {
                  setTournamentId(event.target.value);
                  setError(null);
                }}
                placeholder="bcdfghjkmnpqrstvwxyz1234"
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field label="One-time setup secret" hint={relaySetupTokenHint}>
              <TextInput
                type="password"
                value={setupToken}
                onChange={(event) => {
                  setSetupToken(event.target.value);
                  setError(null);
                }}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            {error && <Callout tone="danger">{error}</Callout>}
            {report && !report.ready && (
              <Diagnostics
                label="Setup validation"
                defaultOpen
                standalone={false}
                items={report.steps.map((step) => ({
                  term: stepLabels[step.key] ?? step.key,
                  value: step.ok ? 'Passed' : step.message,
                }))}
              />
            )}
            <div className="director-form-actions">
              <Button variant="primary" icon="server" onClick={() => void submitSetup()} disabled={busy}>
                {busy ? 'Claiming and validating…' : 'Claim and validate'}
              </Button>
            </div>
            <Callout tone="warning" title="Failure budget">
              {relayFailureBudgetWarning} {relayQbliveRecommendation}
            </Callout>
          </>
        )}
      </Panel>
    );
  }

  const status = deriveRelayStatus({
    baseUrl: config.baseUrl,
    relay: connection,
    relayHealth: health ? healthViewOf(health) : null,
    lastSyncAt,
    lastSyncError,
    roomsMirrored: roomsMirrored?.mirrored ?? null,
    roomsTotal: roomsMirrored?.total ?? null,
    lanAvailable: lan.available,
    lanAddress: lan.address,
    lanPermissionIssue: lan.permissionIssue,
    qbliveOrigin,
  });

  const diagnostics = health
    ? buildRelayDiagnostics({
        relayUrl: config.baseUrl,
        protocolVersion: health.protocolVersion,
        relayRevision: health.relayRevision,
        mirrorRevision: health.mirrorRevision,
        lifecycle: health.lifecycle,
        roomsMirrored: roomsMirrored?.mirrored ?? null,
        roomsTotal: roomsMirrored?.total ?? null,
        resultsUnacked: health.resultsUnacked,
        helpOpen: health.helpOpen,
        meteredRequestsEstimate: health.meteredRequestsEstimate,
        rowsWrittenEstimate: health.rowsWrittenEstimate,
        rowsPerAcceptedProgress: health.rowsPerAcceptedProgress,
        meteredRequestsShare: health.meteredRequestsShare,
        rowsWrittenShare: health.rowsWrittenShare,
        connectionTransitions: [],
        lastSyncErrorCodes: lastSyncError ? ['health-check'] : [],
        lanFallbackAvailable: lan.available,
        lanFallbackAddress: lan.address,
      })
    : null;

  return (
    <Panel
      title="Internet QBTCP"
      description={`Primary scoring address ${config.baseUrl}`}
      data-testid="relay-panel-status"
    >
      {status.warnings.map((warning) => (
        <Callout
          key={warning.code}
          tone={
            warning.code === 'qblive-shared-budget' || warning.code === 'quota-warning' ? 'warning' : 'danger'
          }
          title={warningTitle(warning.code)}
        >
          {warning.message}
        </Callout>
      ))}
      {error && <Callout tone="danger">{error}</Callout>}
      {/* Disclosure initializes from defaultOpen once, so remount when attention state
          flips: warnings arriving after the async health check must expand the summary. */}
      <Diagnostics
        key={status.warnings.length > 0 ? 'relay-status-attention' : 'relay-status-quiet'}
        defaultOpen={status.warnings.length > 0}
        standalone={false}
        items={[
          { term: 'Primary address', value: status.primaryAddress, mono: true },
          { term: 'Relay', value: status.relay },
          { term: 'LAN fallback', value: status.lanFallback, mono: true },
          { term: 'Last sync', value: status.lastSync },
          { term: 'Rooms mirrored', value: status.roomsMirrored },
          ...(health?.relayRevision != null
            ? [{ term: 'Relay revision', value: String(health.relayRevision), mono: true as const }]
            : []),
        ]}
      />
      <div className="director-actions">
        <Button variant="secondary" onClick={() => void refresh(config)} disabled={busy}>
          {busy ? 'Checking…' : 'Check now'}
        </Button>
        <Button variant="secondary" onClick={() => void rotate()} disabled={busy}>
          Rotate credential
        </Button>
        <Button variant="quiet" onClick={() => void disable()} disabled={busy}>
          Disable
        </Button>
        <Button variant="quiet" onClick={() => void destroy()} disabled={busy}>
          Destroy relay…
        </Button>
      </div>
      {diagnostics && (
        <Diagnostics
          label="Relay diagnostics"
          hint="Credential-safe: no secrets, codes, or payloads."
          standalone={false}
          items={[
            { term: 'Protocol', value: `QBTCP v${diagnostics.protocol.version ?? '?'}` },
            { term: 'Lifecycle', value: diagnostics.lifecycle ?? '—' },
            {
              term: 'Retained',
              value: `finals ${diagnostics.retained.resultsUnacked ?? '—'} · open help ${diagnostics.retained.helpOpen ?? '—'}`,
            },
            {
              term: 'Budget',
              value: `metered requests ${share(diagnostics.budget.meteredRequestsShare)} · row writes ${share(diagnostics.budget.rowsWrittenShare)}`,
            },
          ]}
        />
      )}
    </Panel>
  );
}

function warningTitle(code: string): string {
  switch (code) {
    case 'relay-unreachable':
      return 'Relay unreachable';
    case 'unsupported-version':
      return 'Unsupported relay version';
    case 'credential-invalid':
      return 'Relay credential invalid';
    case 'relay-unclaimed':
      return 'Relay tournament unknown';
    case 'publication-failing':
      return 'State publication failing';
    case 'quota-warning':
      return 'Relay resource pressure';
    case 'lan-unavailable':
      return 'LAN fallback unavailable';
    case 'lan-permission':
      return 'Local-network permission issue';
    case 'qblive-shared-budget':
      return 'Shared Cloudflare budget';
    default:
      return 'Internet QBTCP needs attention';
  }
}

function share(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}% of daily allowance`;
}
