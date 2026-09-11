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
import { isRelayTournamentId, normalizeRelayBaseUrl } from '../../../../src/director/relay/relayConfig';
import { generateTournamentId } from '../model/relay';
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
  const canClaim = urlCheck?.ok === true && isRelayTournamentId(tournamentId) && setupToken.trim() !== '';

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
            <h2 style={{ marginTop: 'var(--qbs-space-4)' }}>What the file left to be derived</h2>
            <ul className="plain">
              {tournament.ruleNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </>
        ) : null}
        {bridge.loadWarnings.length > 0 ? (
          <ul className="plain">
            {bridge.loadWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
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
              The management credential is kept on this machine only. It never enters an assignment, a pairing
              link, a QR code, or a saved result.
            </p>
            {!showForm ? (
              <div className="row">
                <Button onPress={bridge.beginRelayChange}>Change Relay…</Button>
                <Button variant="quiet" onPress={() => setConfirmForget(true)}>
                  Forget Relay Credential…
                </Button>
              </div>
            ) : null}
          </>
        ) : null}

        {showForm ? (
          <form
            className="setup-form"
            onSubmit={(event) => {
              event.preventDefault();
              void bridge.connectRelay({ baseUrl, tournamentId, setupToken });
            }}
          >
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
              value={setupToken}
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
                <Button onPress={bridge.cancelRelayChange} isDisabled={bridge.busy}>
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
    </>
  );
}
