/**
 * The tournament and the relay: what was loaded, and where rooms connect.
 *
 * Reloading rereads the `.yft`. It is not synchronization and does not claim to be — rosters
 * edited in YellowFruit reach QBBridge when the operator saves there and reloads here.
 */

import { useState } from 'react';
import { formatSummary } from '../model/tournament';
import type { BridgeApi } from '../model/useBridge';

export default function SetupView({ bridge }: { bridge: BridgeApi }) {
  const { tournament, state } = bridge;
  const [baseUrl, setBaseUrl] = useState(state.relay?.baseUrl ?? '');
  const [tournamentId, setTournamentId] = useState(state.relay?.tournamentId ?? '');
  const [setupToken, setSetupToken] = useState('');

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
        <div className="row" style={{ marginTop: 10 }}>
          <button type="button" onClick={() => void bridge.loadFile()} disabled={bridge.busy}>
            {tournament ? 'Reload YellowFruit File' : 'Open YellowFruit File'}
          </button>
        </div>
        {tournament && tournament.ruleNotes.length > 0 ? (
          <>
            <h2 style={{ marginTop: 14 }}>What the file left to be derived</h2>
            <ul className="plain muted">
              {tournament.ruleNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </>
        ) : null}
        {bridge.loadWarnings.length > 0 ? (
          <ul className="plain muted">
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
            <button type="button" onClick={bridge.forgetRelay}>
              Change Relay
            </button>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void bridge.connectRelay({ baseUrl, tournamentId, setupToken });
            }}
          >
            <div className="row">
              <label htmlFor="relay-url">Relay URL</label>
              <input
                id="relay-url"
                type="text"
                size={40}
                value={baseUrl}
                placeholder="https://qbtcp-relay-xyz.workers.dev"
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <label htmlFor="relay-tournament">Tournament ID</label>
              <input
                id="relay-tournament"
                type="text"
                size={28}
                value={tournamentId}
                onChange={(event) => setTournamentId(event.target.value)}
              />
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <label htmlFor="relay-token">One-time setup token</label>
              <input
                id="relay-token"
                type="password"
                size={28}
                value={setupToken}
                onChange={(event) => setSetupToken(event.target.value)}
              />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="primary" type="submit" disabled={bridge.busy}>
                Connect Relay
              </button>
              <span className="muted">
                The relay runs in the tournament&rsquo;s own Cloudflare account. Claiming consumes the setup
                token and returns the management credential once.
              </span>
            </div>
          </form>
        )}
      </section>
    </>
  );
}
