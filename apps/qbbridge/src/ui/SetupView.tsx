/**
 * The tournament and the relay: what was loaded, and where rooms connect.
 *
 * Reloading rereads the `.yft`. It is not synchronization and does not claim to be — rosters
 * edited in YellowFruit reach QBBridge when the operator saves there and reloads here.
 *
 * # The relay panel is deliberately hard to break
 *
 * A relay's setup token is consumed by the claim that produced the management credential, so a
 * deleted credential cannot be recreated and the relay it authorized cannot be claimed again.
 * Two consequences are built into this screen: **Change Relay** only opens a form and never
 * deletes anything, and the credential is removed only by an action that says so, behind a
 * dialog that says what cannot be undone.
 */

import { useState } from 'react';
import { Button, ConfirmDialog, Notice, TextField } from '@qbsheet/ui';
import {
  isRelayTournamentId,
  normalizeRelayBaseUrl,
  scoresheetOrigin,
} from '../../../../src/director/relay/relayConfig';
import { generateTournamentId } from '../model/relay';
import { scorerBuildLabel } from '../model/scorerBuilds';
import { formatSummary } from '../model/tournament';
import type { BridgeApi } from '../model/useBridge';

export default function SetupView({ bridge }: { bridge: BridgeApi }) {
  const { tournament, state } = bridge;
  const [baseUrl, setBaseUrl] = useState('');
  // Generated rather than demanded. The relay accepts whatever the claim names as long as it is
  // 24 characters from a restricted alphabet, and nobody types that correctly on a tournament
  // morning. It is not a secret — it appears in every pairing link.
  const [tournamentId, setTournamentId] = useState(generateTournamentId);
  const [setupToken, setSetupToken] = useState('');
  const [confirmForget, setConfirmForget] = useState(false);
  const [confirmRevokeBackup, setConfirmRevokeBackup] = useState(false);
  const [backupLabel, setBackupLabel] = useState('Tournament backup controller');
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');

  const showForm = state.relay === null || bridge.changingRelay;

  // Checked as it is typed, against the same rules the relay and the pairing-link builder use,
  // so a bad address is caught here rather than as a refusal after the setup token is spent.
  const trimmedUrl = baseUrl.trim();
  const urlCheck = trimmedUrl === '' ? null : normalizeRelayBaseUrl(trimmedUrl);
  const urlError = urlCheck && !urlCheck.ok ? urlCheck.error : undefined;
  const idError =
    tournamentId === '' || isRelayTournamentId(tournamentId)
      ? undefined
      : 'A tournament ID is 24 characters: digits and lowercase consonants.';
  const canClaim =
    !bridge.relayCredentialSavePending &&
    urlCheck?.ok === true &&
    isRelayTournamentId(tournamentId) &&
    setupToken.trim() !== '';
  // A claim consumes the token even if the local write needs a retry. Derive the field value from
  // that state so the one-time value disappears without an effect-driven cascading render.
  const visibleSetupToken =
    bridge.relayCredentialSavePending || (state.relay !== null && !bridge.changingRelay) ? '' : setupToken;
  const readiness = bridge.scorerReadiness;
  const readinessStatus = readiness?.status ?? 'unknown';
  const readinessHeading =
    readinessStatus === 'ready'
      ? 'Scorer connection ready'
      : readinessStatus === 'blocked'
        ? 'Scorer cannot use this relay yet'
        : readinessStatus === 'checking'
          ? 'Checking Scorer connection'
          : 'Scorer readiness not verified';
  const readinessMessage =
    readiness?.message ??
    `Check whether ${scoresheetOrigin} can pair with this relay before sharing room QR codes.`;

  function cancelRelayChange() {
    setBaseUrl('');
    setTournamentId(generateTournamentId());
    setSetupToken('');
    bridge.cancelRelayChange();
  }

  return (
    <>
      <section className="panel">
        <h2>Tournament</h2>
        {tournament ? (
          <dl className="facts">
            <dt>Name</dt>
            <dd>{tournament.name}</dd>
            <dt>Teams</dt>
            <dd>
              {tournament.teams.length} teams · {tournament.playerCount} players
            </dd>
            <dt>Rounds</dt>
            <dd>{tournament.rounds.length}</dd>
            <dt>Format</dt>
            <dd>{formatSummary(tournament).join(' · ')}</dd>
            {state.yftPath ? (
              <>
                <dt>File</dt>
                <dd className="muted">{state.yftPath}</dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="muted">
            Open the tournament&rsquo;s <code>.yft</code>. QBBridge reads it and never writes to it.
          </p>
        )}
        <div className="row" style={{ marginTop: 'var(--qbs-space-3)' }}>
          <Button onPress={() => void bridge.loadFile()} isDisabled={bridge.busy}>
            {tournament ? 'Reload YellowFruit File' : 'Open YellowFruit File'}
          </Button>
        </div>
        {tournament && tournament.ruleNotes.length > 0 ? (
          <>
            <h2 style={{ marginTop: 'var(--qbs-space-4)' }}>Scoring details derived from YellowFruit</h2>
            <ul className="plain">
              {tournament.ruleNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </>
        ) : null}
        {bridge.loadWarnings.length > 0 ? (
          <>
            <h2 style={{ marginTop: 'var(--qbs-space-4)' }}>Warnings that affect scoring or identity</h2>
            <ul className="plain">
              {bridge.loadWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className="panel">
        <h2>Relay</h2>
        {state.relay ? (
          <>
            <dl className="facts">
              <dt>Address</dt>
              <dd>{state.relay.baseUrl}</dd>
              <dt>Tournament id</dt>
              <dd className="code">{state.relay.tournamentId}</dd>
              <dt>Last publication</dt>
              <dd>{state.relay.revision === 0 ? 'None yet' : `Revision ${state.relay.revision}`}</dd>
            </dl>
            <p className="muted">
              The management credential is kept in this computer&rsquo;s operating-system secure storage. It
              never enters an assignment, a pairing link, a QR code, a saved result, or an ordinary backup.
            </p>
            <dl className="facts">
              <dt>Controller</dt>
              <dd>
                {state.relay.controllerRole === 'backup'
                  ? `Backup${state.relay.controllerLabel ? ` · ${state.relay.controllerLabel}` : ''}`
                  : 'Primary'}
              </dd>
            </dl>
            {state.relay.controllerRole === 'backup' ? (
              <div className="scorer-readiness" aria-live="polite">
                <h3>Backup controller recovery</h3>
                <p>
                  This profile is standby control. Importing the package does not change the relay; takeover
                  is an explicit action that advances the relay epoch and fences the old primary from mirror
                  and ACK writes.
                </p>
                <div className="row">
                  <Button
                    variant="primary"
                    onPress={() => void bridge.takeOverRelay()}
                    isDisabled={bridge.busy}
                  >
                    Take over tournament control
                  </Button>
                  <Button
                    variant="quiet"
                    onPress={() => void bridge.transferRelayToPrimary()}
                    isDisabled={bridge.busy}
                  >
                    Transfer control back to primary
                  </Button>
                </div>
              </div>
            ) : (
              <div className="scorer-readiness" aria-live="polite">
                <h3>Encrypted backup control</h3>
                <p>
                  Provision one named backup controller before play. QBBridge puts only the backup credential
                  and the local recovery state inside an authenticated encrypted package; the primary
                  credential is never copied into it. Keep the package and passphrase separate.
                </p>
                <TextField
                  label="Backup controller name"
                  value={backupLabel}
                  onChange={setBackupLabel}
                  autoComplete="off"
                />
                <TextField
                  label="New recovery passphrase"
                  type="password"
                  value={backupPassphrase}
                  onChange={setBackupPassphrase}
                  description="At least 12 characters. Use a different channel to tell the backup operator."
                  autoComplete="new-password"
                />
                <div className="row">
                  <Button
                    variant="primary"
                    onPress={() => void bridge.createRecoveryPackage(backupPassphrase, backupLabel)}
                    isDisabled={
                      bridge.busy || backupLabel.trim() === '' || backupPassphrase.trim().length < 12
                    }
                  >
                    Create encrypted backup package…
                  </Button>
                  <Button
                    variant="quiet"
                    onPress={() => setConfirmRevokeBackup(true)}
                    isDisabled={bridge.busy}
                  >
                    Revoke backup access…
                  </Button>
                </div>
              </div>
            )}
            {!showForm ? (
              <div className="row">
                <Button onPress={bridge.beginRelayChange}>Change Relay…</Button>
                <Button variant="quiet" onPress={() => setConfirmForget(true)}>
                  Forget Relay Credential…
                </Button>
              </div>
            ) : null}

            <div className="scorer-readiness" aria-live="polite">
              <h3>{readinessHeading}</h3>
              <p>{readinessMessage}</p>
              {readinessStatus !== 'ready' ? (
                <p className="faint">Pairing QR codes stay hidden until this check succeeds.</p>
              ) : null}
              <Button
                onPress={() => void bridge.checkScorerReadiness()}
                isDisabled={bridge.busy || readinessStatus === 'checking'}
              >
                {readinessStatus === 'checking' ? 'Checking…' : 'Check Scorer Readiness'}
              </Button>
            </div>

            <div className="scorer-readiness" aria-live="polite">
              <h3>Pinned Scorer build</h3>
              {bridge.scorerBuildPin ? (
                <p>
                  This tournament runs <strong>{scorerBuildLabel(bridge.scorerBuildPin)}</strong>, pinned{' '}
                  {bridge.scorerBuildPin.pinnedAt.slice(0, 10)}. Every result arrives stamped with the build
                  that scored it; anything else warns below.
                </p>
              ) : (
                <p className="faint">
                  No build pinned. Pin the production build validated before Round 1 so rooms that reload onto
                  a different build warn instead of silently diverging.
                </p>
              )}
              <div className="row">
                <Button onPress={() => void bridge.pinScorerBuild()} isDisabled={bridge.busy}>
                  {bridge.scorerBuildPin ? 'Re-pin current production build' : 'Pin current production build'}
                </Button>
                {bridge.scorerBuildPin ? (
                  <Button variant="quiet" onPress={bridge.clearScorerBuildPin} isDisabled={bridge.busy}>
                    Clear pin
                  </Button>
                ) : null}
              </div>
              {bridge.roomScorerBuilds.length > 0 ? (
                <ul>
                  {bridge.roomScorerBuilds.map((entry) => (
                    <li key={entry.roomId}>
                      {entry.roomName}:{' '}
                      {entry.build ? scorerBuildLabel(entry.build) : 'no scored game yet — unverified'}
                    </li>
                  ))}
                </ul>
              ) : null}
              {bridge.scorerBuildWarnings.length > 0 ? (
                <ul>
                  {bridge.scorerBuildWarnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </>
        ) : null}

        {showForm ? (
          <form
            className="setup-form"
            onSubmit={(event) => {
              event.preventDefault();
              void bridge.connectRelay({ baseUrl, tournamentId, setupToken }).then((connected) => {
                if (connected) setSetupToken('');
              });
            }}
          >
            {bridge.relayCredentialSavePending ? (
              <Notice tone="warning">
                The relay accepted the setup token, but the returned credential is not saved yet. The token
                has been cleared; restore local storage access, then retry the credential save.
                <div className="row" style={{ marginTop: 'var(--qbs-space-2)' }}>
                  <Button
                    variant="primary"
                    onPress={() => void bridge.retryRelayCredentialSave()}
                    isDisabled={bridge.busy}
                  >
                    Retry saving credential
                  </Button>
                </div>
              </Notice>
            ) : null}
            {state.relay ? (
              <Notice tone="info">
                The relay above stays connected and keeps working until a new one is claimed successfully.
              </Notice>
            ) : null}
            <TextField
              label="Relay URL"
              value={baseUrl}
              onChange={setBaseUrl}
              placeholder="https://qbtcp-relay-backend.your-subdomain.workers.dev"
              description="The deployed Worker origin from Cloudflare. No path, no trailing slash."
              errorMessage={urlError}
              autoComplete="off"
              isRequired
            />
            <div className="field-with-action">
              <TextField
                label="Tournament ID"
                value={tournamentId}
                onChange={setTournamentId}
                description="Names this tournament on your relay. Not a secret; it appears in every pairing link."
                errorMessage={idError}
                autoComplete="off"
                isRequired
              />
              <Button onPress={() => setTournamentId(generateTournamentId())}>Generate</Button>
            </div>
            <TextField
              label="One-time setup token"
              type="password"
              value={visibleSetupToken}
              onChange={setSetupToken}
              description="Consumed by the claim. The relay returns a management credential once."
              autoComplete="off"
              isRequired
            />
            <div className="row">
              <Button variant="primary" type="submit" isDisabled={bridge.busy || !canClaim}>
                {state.relay ? 'Claim New Relay' : 'Connect Relay'}
              </Button>
              {state.relay ? (
                <Button
                  onPress={cancelRelayChange}
                  isDisabled={bridge.busy || bridge.relayCredentialSavePending}
                >
                  Cancel
                </Button>
              ) : null}
              <span className="faint">
                The relay runs in the tournament&rsquo;s own Cloudflare account. Help &rarr; Setting up the
                Cloudflare relay has the deployment steps.
              </span>
            </div>
          </form>
        ) : null}

        <div className="scorer-readiness" aria-live="polite">
          <h3>Open encrypted backup package</h3>
          <p>
            On a backup laptop, open the package created by the primary and enter its passphrase. The package
            is decrypted only in memory, and the imported bearer is stored in the operating-system secure
            store.
          </p>
          <TextField
            label="Recovery passphrase"
            type="password"
            value={importPassphrase}
            onChange={setImportPassphrase}
            autoComplete="off"
          />
          <Button
            onPress={() => void bridge.importRecoveryPackage(importPassphrase)}
            isDisabled={bridge.busy || importPassphrase.trim().length < 12}
          >
            Open encrypted recovery package…
          </Button>
        </div>
      </section>

      <ConfirmDialog
        isOpen={confirmForget}
        title="Forget this relay credential?"
        confirmLabel="Forget Credential"
        confirmVariant="danger"
        onCancel={() => setConfirmForget(false)}
        onConfirm={() => {
          setConfirmForget(false);
          bridge.forgetRelayCredential();
        }}
      >
        This deletes the only copy of the management credential for{' '}
        <span className="code">{state.relay?.tournamentId}</span>. The relay&rsquo;s setup token was used up
        when this credential was claimed, so the same relay cannot be claimed again and QBBridge will not be
        able to publish to it or collect its results. Rooms already holding an assignment keep scoring.
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={confirmRevokeBackup}
        title="Revoke backup controller access?"
        confirmLabel="Revoke Backup Access"
        confirmVariant="danger"
        onCancel={() => setConfirmRevokeBackup(false)}
        onConfirm={() => {
          setConfirmRevokeBackup(false);
          void bridge.revokeBackup();
        }}
      >
        This invalidates the provisioned backup credential without deleting rooms, retained finals, or the
        primary relay credential. Create a new encrypted package before the next event if another backup
        laptop is needed.
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={bridge.pendingFileSwitch !== null}
        title="Open a different YellowFruit file?"
        confirmLabel="Start New Tournament"
        onCancel={bridge.cancelFileSwitch}
        onConfirm={bridge.confirmFileSwitch}
      >
        {bridge.pendingFileSwitch ? (
          <>
            This will replace the current QBBridge tournament setup for{' '}
            <span className="code">{bridge.pendingFileSwitch.tournamentName}</span>. The relay connection,
            rooms, active publications and received results will be cleared from this machine. Your results
            folder preference will stay. Nothing will be deleted from disk or from the relay.
          </>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
